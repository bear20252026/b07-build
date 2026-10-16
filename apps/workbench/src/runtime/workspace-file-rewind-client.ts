// 工作区文件回退 —— 把变更日志、规划器与原生写入面接起来。
//
// 三件事：
// 1. `previewWorkspaceFileRewind`：读日志 → 过完整性闸 → 交给规划器。
// 2. `planToPatchOperations`：把计划映射成原生 `workspace_patch` 的操作形状。
// 3. 两个 IO 适配器：从 Tauri 读文件状态、用 WebCrypto 算摘要。
//
// ## 为什么"不完整就阻断"这一步在本层而不是规划器里
//
// 规划器只认识"记录 + 当前文件状态"，不认识日志的存储细节（丢过多少条、是否作废）。
// 而这两件事恰恰决定"这份历史能不能用来还原文件"：有洞的历史会产出一个**漏掉文件
// 的"安全"计划**——比明确拒绝更危险。故本层把不完整信号转成一个 `checkpoint_unreadable`
// 的不安全条目，让规划器的整次阻断逻辑接管。
//
// ## 为什么映射不做二次翻译
//
// 规划器的 `FileRewindOperation` 与原生 `PatchOperation` 字段一一对应，本层只做
// 命名转换（`action` → `kind`，camelCase → snake_case）。之所以能一一对应，是因为
// 回退在设计上就**复用原生 patch 批次**，从而继承它的 CAS 校验、原生回滚与审批门，
// 不新增任何原生写入命令（见 docs/design/workspace-file-rewind-cas-design.md §2.2）。

import {
  MISSING_CONTENT_SHA256,
  type ContentHasher,
  type CurrentFileStateReader,
  type FileRewindOperation,
  type FileRewindPlan,
  type FileRewindUnsafeFile,
} from './workspace-file-rewind-contract.js';
import { buildWorkspaceFileRewindPlan } from './workspace-file-rewind.js';
import {
  readWorkspaceFileJournal,
  type WorkspaceFileJournalStorage,
} from './workspace-file-journal.js';

/** 日志不完整（有洞或已作废）时的稳定错误码。 */
export const FILE_REWIND_JOURNAL_INCOMPLETE_CODE = 'checkpoint_unreadable' as const;

/** 原生 patch 操作形状（`workspace_stage_patch_batch` 的入参元素）。 */
export interface WorkspacePatchOperationLike {
  readonly kind: 'update' | 'add' | 'delete';
  readonly path: string;
  readonly previous_sha256?: string;
  readonly next_sha256?: string;
  readonly next_content?: string;
}

export interface WorkspaceFileRewindPreviewInput {
  readonly storage: WorkspaceFileJournalStorage;
  readonly conversationId: string;
  readonly reader: CurrentFileStateReader;
  readonly hasher: ContentHasher;
}

/**
 * 预览一次文件回退。
 *
 * 只读：不写任何文件、不领票据。回退是破坏性动作，必须先能看清"会动哪些、哪些被拦下"。
 */
export async function previewWorkspaceFileRewind(
  input: WorkspaceFileRewindPreviewInput,
): Promise<FileRewindPlan> {
  const journal = readWorkspaceFileJournal(input.storage, input.conversationId);

  // 完整性闸：日志有洞（丢过记录）或已作废时，**不能**拿它去规划。
  // 一份漏了记录的历史会算出一个"安全"的计划，而那个计划会漏掉本该还原的文件 ——
  // 用户看到"回退成功"，但工作区并没有回到那一刻。明确拒绝才是对的。
  if (journal.unjournalable || journal.droppedCount > 0) {
    const reason: FileRewindUnsafeFile = {
      path: 'workspace',
      reason: FILE_REWIND_JOURNAL_INCOMPLETE_CODE,
      operationCount: journal.droppedCount,
      toolNames: [],
      message: journal.unjournalable
        ? '该会话的文件变更历史已作废（曾出现无法记录的写入），无法安全还原文件。'
        : `该会话的文件变更历史有 ${journal.droppedCount} 条记录已被丢弃，无法安全还原文件。`,
    };
    return { canApply: false, safeFiles: [], unsafeFiles: [reason], ignoredFiles: [], operations: [] };
  }

  return buildWorkspaceFileRewindPlan({
    records: journal.records,
    reader: input.reader,
    hasher: input.hasher,
  });
}

/**
 * 把回退计划映射成原生 patch 批次的操作列表。
 *
 * 调用方应只在 `plan.canApply` 为真时使用它 —— 计划被阻断时 `operations` 已为空，
 * 这里再返回空数组只是把同一条纪律表达两次。
 */
export function planToPatchOperations(plan: FileRewindPlan): readonly WorkspacePatchOperationLike[] {
  return plan.operations.map((operation) => toPatchOperation(operation));
}

function toPatchOperation(operation: FileRewindOperation): WorkspacePatchOperationLike {
  if (operation.action === 'delete') {
    // 原生 delete 分支只接受 previous_sha256，不接受 next_*。
    return { kind: 'delete', path: operation.path, previous_sha256: operation.previousSha256 };
  }
  // restore 在原生侧就是 update：把内容写成检查点时的样子。
  return {
    kind: 'update',
    path: operation.path,
    previous_sha256: operation.previousSha256,
    ...(operation.nextContent !== null ? { next_content: operation.nextContent } : {}),
    ...(operation.nextSha256 !== null ? { next_sha256: operation.nextSha256 } : {}),
  };
}

/** 从原生读文件当前状态。读失败转成 `failed`，不抛异常（端口约定）。 */
export function createTauriWorkspaceFileStateReader(
  invokeCommand: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): CurrentFileStateReader {
  return {
    async read(path) {
      try {
        const result = (await invokeCommand('workspace_read_file', { path })) as { content?: unknown };
        if (typeof result?.content !== 'string') {
          return { failed: '原生返回的文件内容形状不符。' };
        }
        return { exists: true, content: result.content };
      } catch (error: unknown) {
        // 文件不存在与"读不动"必须分开：前者是合法的当前状态（回退可能就是要删掉它），
        // 后者是"判不了"（fail-closed）。原生用 `workspace-file-not-found` 区分。
        const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
        if (code.includes('file-not-found') || code.includes('not-found')) {
          return { exists: false, content: null };
        }
        return { failed: code || '读取工作区文件失败。' };
      }
    },
  };
}

/** 用 WebCrypto 算内容摘要。内容为 `null` 时返回缺失哨兵。 */
export function createWebCryptoContentHasher(): ContentHasher {
  return {
    async sha256(content) {
      if (content === null) return MISSING_CONTENT_SHA256;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    },
  };
}
