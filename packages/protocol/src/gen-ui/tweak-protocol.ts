// 一个文件=一种作用：Gen UI Tweak 标注线协议——页面内 Tweak 运行时与宿主之间的
// 注册/更新/选中/回传消息契约（纯逻辑，无 DOM）。
//
// 移植自 ZCode `packages/shared/src/gen-ui/tweakProtocol.ts`（Apache-2.0，见 THIRD-PARTY-NOTICES.md）。
// b07 差异：上游用 zod，本包手写校验并返回 `{ ok, reason }`；语义（控件闭集、
// callback 唯一、范围/颜色/选项合法、整组 ≤16KiB）与上游逐字对齐。
//
// 说明：这里的 `callback` 是页面内绑定的回调名（不是宿主控件 id）；宿主侧 Tweak 面板
// 用 `packages/protocol/src/gen-ui/contract.ts` 的 `GenUiTweak` 表达同一组控件的展示形态。

import {
  isGenUiPlainObject,
  rejectGenUiUnknownKeys,
  isGenUiNonEmptyString,
  type GenUiResult,
} from './contract.js';

/** 标注值：字符串/有限数/布尔（宿主回传的预览值）。 */
export type GenUiAnnotationValue = string | number | boolean;

interface GenUiAnnotationControlBase {
  readonly callback: string;
  readonly label: string;
  readonly reference?: string;
}

export interface GenUiRangeAnnotationControl extends GenUiAnnotationControlBase {
  readonly type: 'range';
  readonly currentValue: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface GenUiColorAnnotationControl extends GenUiAnnotationControlBase {
  readonly type: 'color';
  readonly currentValue: string;
}

export interface GenUiToggleAnnotationControl extends GenUiAnnotationControlBase {
  readonly type: 'toggle';
  readonly currentValue: boolean;
}

export interface GenUiSelectAnnotationControl extends GenUiAnnotationControlBase {
  readonly type: 'select';
  readonly currentValue: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
}

export type GenUiAnnotationControl =
  | GenUiRangeAnnotationControl
  | GenUiColorAnnotationControl
  | GenUiToggleAnnotationControl
  | GenUiSelectAnnotationControl;

export interface GenUiAnnotationTarget {
  readonly id: string;
  readonly label: string;
  readonly selector: string;
  readonly tagName: string;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface GenUiAnnotationControlsPayload {
  readonly controlsMode: 'replace';
  readonly controls: readonly GenUiAnnotationControl[];
}

export type GenUiTweakMessage =
  | { readonly type: 'register'; readonly registrationId: string; readonly annotationControls: GenUiAnnotationControlsPayload; readonly targets: readonly GenUiAnnotationTarget[] }
  | { readonly type: 'update'; readonly registrationId: string; readonly annotationControls: GenUiAnnotationControlsPayload; readonly targets: readonly GenUiAnnotationTarget[] }
  | { readonly type: 'dispose'; readonly registrationId: string }
  | { readonly type: 'select'; readonly registrationId: string; readonly targetId: string }
  | { readonly type: 'escape' };

export interface GenUiTweakResult {
  readonly annotationControls?: GenUiAnnotationControlsPayload;
}

export interface GenUiTweakAnnotation {
  readonly active: boolean;
  readonly selection: { readonly registrationId: string; readonly targetId: string } | null;
  readonly changes: readonly {
    readonly registrationId: string;
    readonly targetId: string;
    readonly annotationControlChanges: readonly { readonly callback: string; readonly previousValue: GenUiAnnotationValue; readonly value: GenUiAnnotationValue }[];
  }[];
}

const GEN_UI_ANNOTATION_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
/** 单组标注控件的序列化上限：与 Widget 状态同一量级（上游同值）。 */
export const GEN_UI_ANNOTATION_MAX_BYTES = 16_384;
export const GEN_UI_ANNOTATION_MAX_CONTROLS = 12;

function isAnnotationValue(value: unknown): value is GenUiAnnotationValue {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** 候选值是否满足控件的取值约束（range 区间 / color 十六进制 / toggle 布尔 / select 选项内）。 */
export function isGenUiAnnotationValue(control: GenUiAnnotationControl, candidate: unknown): candidate is GenUiAnnotationValue {
  switch (control.type) {
    case 'range':
      return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= control.min && candidate <= control.max;
    case 'color':
      return typeof candidate === 'string' && GEN_UI_ANNOTATION_COLOR.test(candidate);
    case 'toggle':
      return typeof candidate === 'boolean';
    case 'select':
      return typeof candidate === 'string' && control.options.some((option) => option.value === candidate);
  }
}

function parseAnnotationControl(value: unknown): GenUiResult<GenUiAnnotationControl> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-annotation-control-not-object' };
  if (!isGenUiNonEmptyString(value.callback, 128)) return { ok: false, reason: 'gen-ui-annotation-callback-invalid' };
  if (!isGenUiNonEmptyString(value.label, 120)) return { ok: false, reason: 'gen-ui-annotation-label-invalid' };
  if (value.reference !== undefined && !(typeof value.reference === 'string' && value.reference.length <= 160)) {
    return { ok: false, reason: 'gen-ui-annotation-reference-invalid' };
  }
  const base = { callback: value.callback, label: value.label, ...(value.reference === undefined ? {} : { reference: value.reference }) };
  switch (value.type) {
    case 'range': {
      if (!rejectGenUiUnknownKeys(value, ['callback', 'label', 'reference', 'type', 'currentValue', 'min', 'max', 'step'])) {
        return { ok: false, reason: 'gen-ui-annotation-unknown-key' };
      }
      if (
        typeof value.currentValue !== 'number' ||
        !Number.isFinite(value.currentValue) ||
        typeof value.min !== 'number' ||
        !Number.isFinite(value.min) ||
        typeof value.max !== 'number' ||
        !Number.isFinite(value.max) ||
        typeof value.step !== 'number' ||
        !Number.isFinite(value.step) ||
        value.step <= 0
      ) {
        return { ok: false, reason: 'gen-ui-annotation-range-invalid' };
      }
      return { ok: true, value: { ...base, type: 'range', currentValue: value.currentValue, min: value.min, max: value.max, step: value.step } };
    }
    case 'color': {
      if (!rejectGenUiUnknownKeys(value, ['callback', 'label', 'reference', 'type', 'currentValue'])) {
        return { ok: false, reason: 'gen-ui-annotation-unknown-key' };
      }
      if (typeof value.currentValue !== 'string' || !GEN_UI_ANNOTATION_COLOR.test(value.currentValue)) {
        return { ok: false, reason: 'gen-ui-annotation-color-invalid' };
      }
      return { ok: true, value: { ...base, type: 'color', currentValue: value.currentValue } };
    }
    case 'toggle': {
      if (!rejectGenUiUnknownKeys(value, ['callback', 'label', 'reference', 'type', 'currentValue'])) {
        return { ok: false, reason: 'gen-ui-annotation-unknown-key' };
      }
      if (typeof value.currentValue !== 'boolean') return { ok: false, reason: 'gen-ui-annotation-toggle-invalid' };
      return { ok: true, value: { ...base, type: 'toggle', currentValue: value.currentValue } };
    }
    case 'select': {
      if (!rejectGenUiUnknownKeys(value, ['callback', 'label', 'reference', 'type', 'currentValue', 'options'])) {
        return { ok: false, reason: 'gen-ui-annotation-unknown-key' };
      }
      if (typeof value.currentValue !== 'string' || value.currentValue.length > 120) {
        return { ok: false, reason: 'gen-ui-annotation-select-invalid' };
      }
      if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 12) {
        return { ok: false, reason: 'gen-ui-annotation-select-invalid' };
      }
      const options: { label: string; value: string }[] = [];
      for (const option of value.options) {
        if (!isGenUiPlainObject(option) || !rejectGenUiUnknownKeys(option, ['label', 'value'])) {
          return { ok: false, reason: 'gen-ui-annotation-select-invalid' };
        }
        if (!isGenUiNonEmptyString(option.label, 120) || typeof option.value !== 'string' || option.value.length > 120) {
          return { ok: false, reason: 'gen-ui-annotation-select-invalid' };
        }
        options.push({ label: option.label, value: option.value });
      }
      return { ok: true, value: { ...base, type: 'select', currentValue: value.currentValue, options } };
    }
    default:
      return { ok: false, reason: 'gen-ui-annotation-type-unsupported' };
  }
}

function parseAnnotationControls(value: unknown): GenUiResult<GenUiAnnotationControlsPayload> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-annotation-controls-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['controlsMode', 'controls'])) return { ok: false, reason: 'gen-ui-annotation-unknown-key' };
  if (value.controlsMode !== 'replace') return { ok: false, reason: 'gen-ui-annotation-controls-mode-invalid' };
  if (!Array.isArray(value.controls) || value.controls.length < 1 || value.controls.length > GEN_UI_ANNOTATION_MAX_CONTROLS) {
    return { ok: false, reason: 'gen-ui-annotation-controls-invalid' };
  }
  const controls: GenUiAnnotationControl[] = [];
  const callbacks = new Set<string>();
  for (const raw of value.controls) {
    const parsed = parseAnnotationControl(raw);
    if (!parsed.ok) return parsed;
    const control = parsed.value;
    if (callbacks.has(control.callback) || !isGenUiAnnotationValue(control, control.currentValue)) {
      return { ok: false, reason: 'gen-ui-annotation-controls-invalid' };
    }
    callbacks.add(control.callback);
    controls.push(control);
  }
  const payload: GenUiAnnotationControlsPayload = { controlsMode: 'replace', controls };
  if (JSON.stringify(payload).length > GEN_UI_ANNOTATION_MAX_BYTES) {
    return { ok: false, reason: 'gen-ui-annotation-controls-too-large' };
  }
  return { ok: true, value: payload };
}

function parseAnnotationTarget(value: unknown): GenUiResult<GenUiAnnotationTarget> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-annotation-target-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['id', 'label', 'selector', 'tagName', 'rect'])) {
    return { ok: false, reason: 'gen-ui-annotation-target-invalid' };
  }
  if (!isGenUiNonEmptyString(value.id, 128) || !isGenUiNonEmptyString(value.label, 80) || typeof value.selector !== 'string' || value.selector.length > 1024) {
    return { ok: false, reason: 'gen-ui-annotation-target-invalid' };
  }
  if (!isGenUiNonEmptyString(value.tagName, 120)) return { ok: false, reason: 'gen-ui-annotation-target-invalid' };
  if (!isGenUiPlainObject(value.rect) || !rejectGenUiUnknownKeys(value.rect, ['x', 'y', 'width', 'height'])) {
    return { ok: false, reason: 'gen-ui-annotation-target-invalid' };
  }
  const { x, y, width, height } = value.rect;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width < 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height < 0
  ) {
    return { ok: false, reason: 'gen-ui-annotation-target-invalid' };
  }
  return { ok: true, value: { id: value.id, label: value.label, selector: value.selector, tagName: value.tagName, rect: { x, y, width, height } } };
}

export function parseGenUiTweakMessage(value: unknown): GenUiResult<GenUiTweakMessage> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-tweak-message-not-object' };
  switch (value.type) {
    case 'register':
    case 'update': {
      if (!rejectGenUiUnknownKeys(value, ['type', 'registrationId', 'annotationControls', 'targets'])) {
        return { ok: false, reason: 'gen-ui-tweak-message-unknown-key' };
      }
      if (!isGenUiNonEmptyString(value.registrationId, 128)) return { ok: false, reason: 'gen-ui-annotation-registration-invalid' };
      const controls = parseAnnotationControls(value.annotationControls);
      if (!controls.ok) return controls;
      // 上游约束：targets 必须恰好 1 个（当前仅支持单容器标注）。
      if (!Array.isArray(value.targets) || value.targets.length !== 1) return { ok: false, reason: 'gen-ui-annotation-targets-invalid' };
      const target = parseAnnotationTarget(value.targets[0]);
      if (!target.ok) return target;
      return {
        ok: true,
        value: { type: value.type, registrationId: value.registrationId, annotationControls: controls.value, targets: [target.value] },
      };
    }
    case 'dispose': {
      if (!rejectGenUiUnknownKeys(value, ['type', 'registrationId'])) return { ok: false, reason: 'gen-ui-tweak-message-unknown-key' };
      if (!isGenUiNonEmptyString(value.registrationId, 128)) return { ok: false, reason: 'gen-ui-annotation-registration-invalid' };
      return { ok: true, value: { type: 'dispose', registrationId: value.registrationId } };
    }
    case 'select': {
      if (!rejectGenUiUnknownKeys(value, ['type', 'registrationId', 'targetId'])) return { ok: false, reason: 'gen-ui-tweak-message-unknown-key' };
      if (!isGenUiNonEmptyString(value.registrationId, 128) || !isGenUiNonEmptyString(value.targetId, 128)) {
        return { ok: false, reason: 'gen-ui-annotation-registration-invalid' };
      }
      return { ok: true, value: { type: 'select', registrationId: value.registrationId, targetId: value.targetId } };
    }
    case 'escape': {
      if (!rejectGenUiUnknownKeys(value, ['type'])) return { ok: false, reason: 'gen-ui-tweak-message-unknown-key' };
      return { ok: true, value: { type: 'escape' } };
    }
    default:
      return { ok: false, reason: 'gen-ui-tweak-message-type-unsupported' };
  }
}

export function parseGenUiTweakResult(value: unknown): GenUiResult<GenUiTweakResult> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-tweak-result-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['annotationControls'])) return { ok: false, reason: 'gen-ui-tweak-result-unknown-key' };
  if (value.annotationControls === undefined) return { ok: true, value: {} };
  const controls = parseAnnotationControls(value.annotationControls);
  if (!controls.ok) return controls;
  return { ok: true, value: { annotationControls: controls.value } };
}

export function parseGenUiTweakAnnotation(value: unknown): GenUiResult<GenUiTweakAnnotation> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-annotation-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['active', 'selection', 'changes'])) return { ok: false, reason: 'gen-ui-annotation-unknown-key' };
  if (typeof value.active !== 'boolean') return { ok: false, reason: 'gen-ui-annotation-active-invalid' };
  let selection: GenUiTweakAnnotation['selection'] = null;
  if (value.selection !== null && value.selection !== undefined) {
    if (!isGenUiPlainObject(value.selection) || !rejectGenUiUnknownKeys(value.selection, ['registrationId', 'targetId'])) {
      return { ok: false, reason: 'gen-ui-annotation-selection-invalid' };
    }
    if (!isGenUiNonEmptyString(value.selection.registrationId, 128) || !isGenUiNonEmptyString(value.selection.targetId, 128)) {
      return { ok: false, reason: 'gen-ui-annotation-selection-invalid' };
    }
    selection = { registrationId: value.selection.registrationId, targetId: value.selection.targetId };
  }
  if (!Array.isArray(value.changes) || value.changes.length > 64) return { ok: false, reason: 'gen-ui-annotation-changes-invalid' };
  const changes: Array<{
    registrationId: string;
    targetId: string;
    annotationControlChanges: Array<{ callback: string; previousValue: GenUiAnnotationValue; value: GenUiAnnotationValue }>;
  }> = [];
  for (const change of value.changes) {
    if (!isGenUiPlainObject(change) || !rejectGenUiUnknownKeys(change, ['registrationId', 'targetId', 'annotationControlChanges'])) {
      return { ok: false, reason: 'gen-ui-annotation-changes-invalid' };
    }
    if (!isGenUiNonEmptyString(change.registrationId, 128) || !isGenUiNonEmptyString(change.targetId, 128)) {
      return { ok: false, reason: 'gen-ui-annotation-changes-invalid' };
    }
    if (!Array.isArray(change.annotationControlChanges) || change.annotationControlChanges.length > GEN_UI_ANNOTATION_MAX_CONTROLS) {
      return { ok: false, reason: 'gen-ui-annotation-changes-invalid' };
    }
    const edits: { callback: string; previousValue: GenUiAnnotationValue; value: GenUiAnnotationValue }[] = [];
    for (const edit of change.annotationControlChanges) {
      if (!isGenUiPlainObject(edit) || !rejectGenUiUnknownKeys(edit, ['callback', 'previousValue', 'value'])) {
        return { ok: false, reason: 'gen-ui-annotation-changes-invalid' };
      }
      if (!isGenUiNonEmptyString(edit.callback, 128) || !isAnnotationValue(edit.previousValue) || !isAnnotationValue(edit.value)) {
        return { ok: false, reason: 'gen-ui-annotation-changes-invalid' };
      }
      edits.push({ callback: edit.callback, previousValue: edit.previousValue, value: edit.value });
    }
    changes.push({ registrationId: change.registrationId, targetId: change.targetId, annotationControlChanges: edits });
  }
  return { ok: true, value: { active: value.active, selection, changes } };
}
