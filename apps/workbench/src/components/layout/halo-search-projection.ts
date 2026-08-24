import type { WorkbenchProject } from '../../runtime/project-client';
import type { DirectConversation } from '../../runtime/use-direct-conversations';
import type { LocalKnowledgeDocument } from '../../runtime/local-knowledge-ledger';
import type { WorkbenchPage } from './workbench-page';

export type HaloSearchAction =
  | Readonly<{ kind: 'conversation'; id: string }>
  | Readonly<{ kind: 'project'; id: string }>
  | Readonly<{ kind: 'navigate'; page: WorkbenchPage }>
  | Readonly<{ kind: 'local-knowledge' }>;

export interface HaloSearchItem {
  readonly id: string;
  readonly group: '聊天会话' | '项目' | '本地知识库' | '工作面';
  readonly label: string;
  readonly description: string;
  readonly action: HaloSearchAction;
}

export interface HaloSearchSource {
  readonly conversations: readonly DirectConversation[];
  readonly projects: readonly WorkbenchProject[];
  readonly knowledge: readonly LocalKnowledgeDocument[];
}

function searchable(item: HaloSearchItem): string { return `${item.label}\n${item.description}\n${item.group}`.toLocaleLowerCase(); }

/** 仅投影已经加载在 WebView 内的本地标题、摘要和索引预览；此函数不读取 Provider、文件或网络。 */
export function createHaloSearchItems({ conversations, projects, knowledge }: HaloSearchSource): readonly HaloSearchItem[] {
  return [
    { id: 'surface-workspace', group: '工作面', label: '工作区对话', description: '回到当前本地聊天工作面。', action: { kind: 'navigate', page: 'workspace' } },
    { id: 'surface-projects', group: '工作面', label: '项目管理', description: '查看和组织本地项目与会话归属。', action: { kind: 'navigate', page: 'projects' } },
    { id: 'surface-models', group: '工作面', label: 'API 连接', description: '管理已保存的第三方 Provider 连接。', action: { kind: 'navigate', page: 'models' } },
    { id: 'surface-knowledge', group: '本地知识库', label: '本地知识库', description: '只查看主人明确加入的本地索引，不会自动上传或发送给模型。', action: { kind: 'local-knowledge' } },
    ...projects.map((project): HaloSearchItem => ({ id: `project-${project.projectId}`, group: '项目', label: project.title, description: project.description || `${project.taskCount} 项本地任务`, action: { kind: 'project', id: project.projectId } })),
    ...conversations.map((conversation): HaloSearchItem => ({ id: `conversation-${conversation.id}`, group: '聊天会话', label: conversation.title, description: `${conversation.messages.length} 条消息 · ${conversation.selection.model ?? conversation.selection.providerId}`, action: { kind: 'conversation', id: conversation.id } })),
    ...knowledge.map((document): HaloSearchItem => ({ id: `knowledge-${document.id}`, group: '本地知识库', label: document.title, description: document.sourcePreview || '已显式加入的本地资料。', action: { kind: 'local-knowledge' } })),
  ];
}

export function projectHaloSearchItems(source: HaloSearchSource, query: string): readonly HaloSearchItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  const items = createHaloSearchItems(source);
  if (!normalized) return items.slice(0, 18);
  return items.filter((item) => searchable(item).includes(normalized)).sort((left, right) => {
    const leftLabel = left.label.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
    const rightLabel = right.label.toLocaleLowerCase().startsWith(normalized) ? 0 : 1;
    return leftLabel - rightLabel || left.label.localeCompare(right.label, 'zh-CN');
  }).slice(0, 32);
}
