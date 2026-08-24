import { useState } from 'react';
import type { WorkbenchProject, WorkbenchProjectTaskRef } from '../../runtime/project-client';
import type { DirectConversation } from '../../runtime/use-direct-conversations';

export interface ProjectBoardProps {
  storageReady: boolean;
  projects: readonly WorkbenchProject[];
  selectedProjectId?: string;
  projectTasks: readonly WorkbenchProjectTaskRef[];
  activeTask?: { taskId: string; runId: string };
  pending: boolean;
  error?: string;
  onBackToChat(): void;
  onCreate(input: { title: string; description?: string }): void;
  onSelect(projectId: string): void;
  onAttachCurrentTask(): void;
  onOpenKnowledge(): void;
  onOpenFiles(): void;
  onOpenArtifacts(): void;
  onOpenTerminal(): void;
  conversations: readonly DirectConversation[];
}

/** P28：项目页为二级 metadata 工作台；不会读取文件、发起 Provider 请求或提交任务。 */
export function ProjectBoard({ storageReady, projects, selectedProjectId, projectTasks, activeTask, pending, error, onBackToChat, onCreate, onSelect, onAttachCurrentTask, onOpenKnowledge, onOpenFiles, onOpenArtifacts, onOpenTerminal, conversations }: ProjectBoardProps) {
  const [title, setTitle] = useState(''); const [description, setDescription] = useState('');
  const selected = projects.find((project) => project.projectId === selectedProjectId);
  const projectConversations = conversations.filter((conversation) => conversation.projectId === selectedProjectId);
  const canCreate = storageReady && title.trim().length > 0 && !pending;
  return <section className="project-board" aria-label="项目工作台">
    <header className="project-board-header"><div><span>PROJECT WORKSPACE</span><h1>项目</h1><p>项目只组织会话和 task/run 引用；文件、产物、终端和知识资料由各自的独立窗口在主人明确操作后打开。</p></div><div><button onClick={onOpenKnowledge} type="button">本地知识库</button><button onClick={onBackToChat} type="button">返回聊天</button></div></header>
    {!storageReady && <p className="project-board-notice">本地项目存储暂不可用；请检查浏览器本地数据设置后重试。</p>}
    <div className="project-board-grid"><aside><h2>项目列表</h2>{projects.length === 0 ? <p>尚无项目。创建后可显式关联当前任务。</p> : projects.map((project) => <button aria-pressed={project.projectId === selectedProjectId} className={project.projectId === selectedProjectId ? 'active' : ''} key={project.projectId} onClick={() => onSelect(project.projectId)} type="button"><strong>{project.title}</strong><small>{project.taskCount} 个任务</small></button>)}<form onSubmit={(event) => { event.preventDefault(); if (canCreate) { onCreate({ title, description: description || undefined }); setTitle(''); setDescription(''); } }}><label>新项目名称<input disabled={!storageReady || pending} maxLength={120} onChange={(event) => setTitle(event.target.value)} value={title} /></label><label>说明（可选）<textarea disabled={!storageReady || pending} maxLength={500} onChange={(event) => setDescription(event.target.value)} value={description} /></label><button disabled={!canCreate} type="submit">{pending ? '处理中…' : '创建项目'}</button></form></aside><main>{selected ? <><h2>{selected.title}</h2><p>{selected.description || '此项目尚未添加说明。'}</p><div className="project-board-summary"><span>{selected.taskCount} 个受控 task/run</span><span>{projectConversations.length} 个关联会话</span>{selected.lastTaskAt && <span>最近关联：{new Date(selected.lastTaskAt).toLocaleString()}</span>}</div><div className="project-board-summary"><button onClick={onOpenFiles} type="button">项目文件</button><button onClick={onOpenArtifacts} type="button">项目产物</button><button onClick={onOpenTerminal} type="button">终端计划</button></div>{activeTask && <button disabled={pending} onClick={onAttachCurrentTask} type="button">关联当前任务</button>}<h3>关联会话</h3>{projectConversations.length === 0 ? <p>尚无会话。项目处于选中状态时，后续直接聊天会关联至此项目。</p> : <ul>{projectConversations.map((conversation) => <li key={conversation.id}>{conversation.title} · {conversation.messages.length} 条消息</li>)}</ul>}<h3>已关联任务</h3>{projectTasks.length === 0 ? <p>尚未关联任务。关联不会复制文件或事件内容。</p> : <ul>{projectTasks.map((item) => <li key={`${item.taskId}:${item.runId}`}><code>{item.taskId}</code> / <code>{item.runId}</code></li>)}</ul>}</> : <p>从左侧选择项目，或创建一个新的本地项目。</p>}{error && <p className="project-board-error">{error}</p>}</main></div>
  </section>;
}
