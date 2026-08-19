// 一个文件=一种作用：TaskEvent 的运行时 JSON Schema 契约校验。
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import eventSchema from '../schema/task-event.schema.json';
import type { TaskEvent } from './types.js';

export interface ContractViolation {
  path: string;
  keyword: string;
  message: string;
}

export type TaskEventValidation =
  | { ok: true; event: TaskEvent }
  | { ok: false; errors: readonly ContractViolation[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(eventSchema);

function toViolation(error: ErrorObject): ContractViolation {
  return {
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? '违反事件协议',
  };
}

/**
 * C3/C6 入口校验。任何来自进程、sidecar、持久化日志或 UI 的未知数据，
 * 在被领域层消费前必须经过本函数。
 */
export function validateTaskEvent(value: unknown): TaskEventValidation {
  if (validate(value)) {
    return { ok: true, event: value as TaskEvent };
  }

  return {
    ok: false,
    errors: (validate.errors ?? []).map(toViolation),
  };
}

export function isTaskEvent(value: unknown): value is TaskEvent {
  return validateTaskEvent(value).ok;
}
