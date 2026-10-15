// 一个文件=一种作用：Gen UI 宿主侧 Tweak 注册表——处理页面发来的 register/update/dispose/
// select/escape 消息，维护控件分组与当前值，并投影成下发回 guest 的标注（annotation）。
//
// 与上游 `ui/src/gen-ui/app/tweaks.ts` 的关系：上游把 Tweak 面板与标注遮罩绑在一起（宿主
// 拥有控件 UI，遮罩负责选中容器）；b07 无 overlay，故这里只保留**控件分组 + 值回传**这一半：
// 分组标题取容器 target.label，选中态由工作台侧栏承担。消息 schema、控件取值约束、回传
// 语义（previousValue 必须等于控件 currentValue）全部复用 `@awo/protocol` 的 tweak 契约。

import {
  isGenUiAnnotationValue,
  type GenUiAnnotationControl,
  type GenUiAnnotationTarget,
  type GenUiAnnotationValue,
  type GenUiTweakAnnotation,
  type GenUiTweakMessage,
  type GenUiTweakResult,
} from '@awo/protocol';

/** 宿主侧 Tweak 分组：一个页面容器对应一组控件。 */
export interface GenUiTweakGroup {
  readonly registrationId: string;
  readonly title: string;
  readonly target: GenUiAnnotationTarget;
  readonly controls: readonly GenUiAnnotationControl[];
}

/** 标注 changes 上限（上游同值）。 */
const MAX_ANNOTATION_CHANGES = 64;

export class GenUiTweakRegistry {
  private readonly groupsById = new Map<string, GenUiTweakGroup>();
  private readonly valuesByCallback = new Map<string, GenUiAnnotationValue>();
  private selection: { registrationId: string; targetId: string } | null = null;

  /** 处理一条 Tweak 消息，返回应答（register/update 回显控件以确认采纳）。 */
  handle(message: GenUiTweakMessage): GenUiTweakResult {
    switch (message.type) {
      case 'register':
      case 'update': {
        const target = message.targets[0];
        if (target === undefined) return {};
        const group: GenUiTweakGroup = {
          registrationId: message.registrationId,
          title: target.label,
          target,
          controls: message.annotationControls.controls,
        };
        this.groupsById.set(message.registrationId, group);
        // 丢弃已移除控件的值；新控件取控件自带 currentValue。
        const callbacks = new Set(group.controls.map((control) => control.callback));
        for (const key of [...this.valuesByCallback.keys()]) if (!callbacks.has(key)) this.valuesByCallback.delete(key);
        for (const control of group.controls) {
          if (!this.valuesByCallback.has(control.callback)) this.valuesByCallback.set(control.callback, control.currentValue);
        }
        return { annotationControls: message.annotationControls };
      }
      case 'dispose': {
        const group = this.groupsById.get(message.registrationId);
        if (!group) return {};
        this.groupsById.delete(message.registrationId);
        for (const control of group.controls) this.valuesByCallback.delete(control.callback);
        if (this.selection?.registrationId === message.registrationId) this.selection = null;
        return {};
      }
      case 'select': {
        const group = this.groupsById.get(message.registrationId);
        if (group && group.target.id === message.targetId) {
          this.selection = { registrationId: message.registrationId, targetId: message.targetId };
        }
        return {};
      }
      case 'escape': {
        this.selection = null;
        return {};
      }
    }
  }

  groups(): readonly GenUiTweakGroup[] {
    return [...this.groupsById.values()];
  }

  values(): Readonly<Record<string, GenUiAnnotationValue>> {
    return Object.fromEntries(this.valuesByCallback);
  }

  /** 修改控件值：越界/类型不符一律拒绝（返回 false，不改变已有值）。 */
  setValue(callback: string, value: unknown): boolean {
    const control = this.findControl(callback);
    if (!control || !isGenUiAnnotationValue(control, value)) return false;
    this.valuesByCallback.set(callback, value);
    return true;
  }

  /** 恢复某控件到其 currentValue（工作台「还原」按钮）。 */
  resetValue(callback: string): boolean {
    const control = this.findControl(callback);
    if (!control) return false;
    this.valuesByCallback.set(callback, control.currentValue);
    return true;
  }

  /** 当前选中态（b07 由侧栏触发；无 overlay 时不自动产生）。 */
  currentSelection(): { registrationId: string; targetId: string } | null {
    return this.selection;
  }

  /** 投影成下发回 guest 的标注：只回传「已改动」的控件。 */
  annotation(): GenUiTweakAnnotation {
    const changes: Array<{
      registrationId: string;
      targetId: string;
      annotationControlChanges: Array<{ callback: string; previousValue: GenUiAnnotationValue; value: GenUiAnnotationValue }>;
    }> = [];
    for (const group of this.groupsById.values()) {
      const edits: { callback: string; previousValue: GenUiAnnotationValue; value: GenUiAnnotationValue }[] = [];
      for (const control of group.controls) {
        const current = this.valuesByCallback.get(control.callback);
        if (current === undefined || current === control.currentValue) continue;
        edits.push({ callback: control.callback, previousValue: control.currentValue, value: current });
      }
      if (edits.length > 0) {
        changes.push({ registrationId: group.registrationId, targetId: group.target.id, annotationControlChanges: edits });
        if (changes.length >= MAX_ANNOTATION_CHANGES) break;
      }
    }
    return { active: this.groupsById.size > 0, selection: this.selection, changes };
  }

  reset(): void {
    this.groupsById.clear();
    this.valuesByCallback.clear();
    this.selection = null;
  }

  private findControl(callback: string): GenUiAnnotationControl | undefined {
    for (const group of this.groupsById.values()) {
      const control = group.controls.find((candidate) => candidate.callback === callback);
      if (control) return control;
    }
    return undefined;
  }
}
