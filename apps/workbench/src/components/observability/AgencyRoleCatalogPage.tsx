import { useEffect, useMemo, useState } from 'react';
import { HttpAgencyRoleClient, type WorkbenchAgencyRoleDetail, type WorkbenchAgencyRoleSummary } from '../../runtime/agency-role-client';

const client = new HttpAgencyRoleClient();
const DIVISION_LABEL: Record<WorkbenchAgencyRoleSummary['division'], string> = { engineering: '工程', design: '设计', product: '产品', testing: '测试' };

/** 三角色目录只做浏览和“创建候选”；不会加载到任务、切换模型、安装 hook 或执行任何外部动作。 */
export function AgencyRoleCatalogPage({ localServiceReady, onBack }: { localServiceReady: boolean; onBack: () => void }) {
  const [roles, setRoles] = useState<readonly WorkbenchAgencyRoleSummary[]>([]);
  const [selected, setSelected] = useState<WorkbenchAgencyRoleDetail>();
  const [division, setDivision] = useState<'all' | WorkbenchAgencyRoleSummary['division']>('all');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [candidateMessage, setCandidateMessage] = useState<string>();
  const load = (): void => {
    if (!localServiceReady || pending) return;
    setPending(true); setError(undefined);
    void client.list().then(setRoles).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取预置角色目录。')).finally(() => setPending(false));
  };
  useEffect(() => { load(); // 仅在三级目录被主动打开且 本机能力服务 已附着时读取。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localServiceReady]);
  const filtered = useMemo(() => roles.filter((role) => division === 'all' || role.division === division), [roles, division]);
  const open = (role: WorkbenchAgencyRoleSummary): void => {
    if (pending) return; setPending(true); setError(undefined); setCandidateMessage(undefined);
    void client.detail(role.id).then(setSelected).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取角色详情。')).finally(() => setPending(false));
  };
  const addCandidate = (): void => {
    if (!selected || pending) return; setPending(true); setError(undefined); setCandidateMessage(undefined);
    void client.createCandidate(selected.id).then((result) => setCandidateMessage(result.alreadyExists ? `“${selected.displayName}” 已在本机 Skill Pack 账本中，状态为 ${result.pack.status}。` : `已创建“${selected.displayName}”候选（${result.pack.id}）。它尚未审查、发布或注入任何任务。`)).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '未能创建角色候选。')).finally(() => setPending(false));
  };
  return <section className="page-stack agency-role-page"><div className="page-heading agency-role-heading"><div><span>EXTENSIONS & CAPABILITIES / AGENCY ROLES</span><h1>预置专业角色</h1><p>源自 agency-agents 的少量 MIT 许可角色。它们是可审查的上下文候选，而不是可自动执行、授权或安装的插件。</p></div><div><button title="返回二级“扩展与能力”页面。" onClick={onBack} type="button">← 返回扩展与能力</button><button title="读取本机 本机能力服务 的静态角色目录；不请求网络、不扫描文件、不安装任何外部工具。" disabled={!localServiceReady || pending} onClick={load} type="button">{pending ? '读取中…' : '刷新目录'}</button></div></div>
    <section className="design-foundation-card" aria-label="NOVA Apple-first design foundation">
      <div><span>PROJECT DESIGN FOUNDATION</span><h2>UI Designer · Apple-first 设计简报</h2><p>项目根 <code>DESIGN.md</code> 与 Apple-first 设计契约是 UI Designer、Frontend Developer、UX Researcher 和 Code Reviewer 的共同依据。它优先保护可读性、系统字体、层级、行动清晰度与受控状态表达。</p></div>
      <dl><div><dt>主基线</dt><dd>Apple HIG、系统字体、行动蓝、克制材料层级</dd></div><div><dt>辅助模式</dt><dd>Linear 的表面阶梯；Raycast 的命令与键帽提示</dd></div><div><dt>安全边界</dt><dd>设计文本不会自动注入、授权、读取密钥或改变工具能力</dd></div></dl>
      <small>详细契约：<code>docs/design/apple-first-workbench-contract.md</code>。选择并添加 UI Designer 后，它仍只是待审查的 Skill Pack 候选。</small>
    </section>
    {!localServiceReady && <p className="agency-role-note">请先附着本机 本机能力服务。角色目录不会自动启动或连接服务。</p>}
    {localServiceReady && <><div className="agency-role-toolbar"><label>专业领域<select title="仅筛选角色目录，不会加载角色到任务。" value={division} onChange={(event) => { setDivision(event.target.value as typeof division); setSelected(undefined); setCandidateMessage(undefined); }}><option value="all">全部领域</option>{(['engineering', 'design', 'product', 'testing'] as const).map((item) => <option key={item} value={item}>{DIVISION_LABEL[item]}</option>)}</select></label><span>8 个已归因角色 · MIT · 需显式候选与后续人工审查</span></div>
      <div className="agency-role-layout"><div className="agency-role-list">{filtered.map((role) => <button aria-pressed={selected?.id === role.id} className={`agency-role-item${selected?.id === role.id ? ' active' : ''}`} key={role.id} title={`查看 ${role.displayName} 的完整来源、版权和角色文本；不会自动将其加入任务。`} onClick={() => open(role)} type="button"><span>{DIVISION_LABEL[role.division]}</span><strong>{role.displayName}</strong><small>{role.description}</small><em>MIT · 不授予权限</em></button>)}{filtered.length === 0 && <p className="agency-role-note">没有匹配的预置角色。</p>}</div>
        <aside className="agency-role-detail" aria-live="polite">{!selected && <div className="agency-role-empty"><strong>选择一个角色查看详情</strong><span>角色正文仅在你点击某个角色时从本机 本机能力服务 显式读取；不会自动注入任务。</span></div>}{selected && <><header><div><span>{DIVISION_LABEL[selected.division]} · 来源角色</span><h2>{selected.displayName}</h2><p>{selected.description}</p></div><a href={selected.source.upstreamUrl} rel="noreferrer" target="_blank" title="在浏览器中打开上游 agency-agents 文件；不会将数据发送给 本机能力服务。">查看上游来源 ↗</a></header><div className="agency-role-license"><strong>MIT 许可归因</strong><span>{selected.source.copyright} · {selected.source.repository}</span><small>SHA-256：{selected.source.contentDigest.slice(0, 16)}… · 角色正文不会授予工具、批准、秘密访问或自动执行。</small></div><div className="agency-role-actions"><button title="将此角色的原始带版权文本作为 Skill Pack candidate 写入本机账本；不会发布、注入或执行。" disabled={pending} onClick={addCandidate} type="button">添加为待审查候选</button><span>随后仍需在 Skill Pack 生命周期中人工 review、验证摘要并 publish。</span></div>{candidateMessage && <p className="agency-role-success">{candidateMessage}</p>}<details className="agency-role-content"><summary title="展开上游复制的完整角色文本和文件内版权头。">查看带归因的角色原文</summary><pre>{selected.content}</pre></details></>}</aside></div>
    </>}
    {error && <p className="agency-role-error" role="alert">{error}</p>}
  </section>;
}
