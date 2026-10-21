import { useMemo, useState } from 'react';
import { AGENCY_DIVISION_LABEL, loadAgencyRoles, type AgencyDivision, type AgencyRole } from '../../runtime/agency-role-catalog';

/**
 * 预置专业角色目录（**只读**）。
 *
 * ## 改了什么，为什么
 *
 * 以前这个页面通过 HTTP 客户端读 `本机能力服务`，还提供"添加为待审查候选"——
 * 那个服务（`apps/runtime-gateway`）在 2026-08-26 被删除，于是页面永远停在"未就绪"。
 *
 * 现在数据来自构建期导出的 JSON（`npm run agency:catalog`），随包打进来，
 * **没有网络、没有 IO、打开即用**。
 *
 * "添加为候选"被移除了：它要写入本机 Skill Pack 账本，而那个账本在应用里不存在。
 * 留一个按不动的按钮，比没有这个按钮更糟 —— 用户会以为功能坏了。
 * 若以后补上账本（Tauri 命令 + SQLite），这个动作可以加回来。
 */
export function AgencyRoleCatalogPage({ onBack }: { readonly onBack: () => void }) {
  const snapshot = useMemo(() => loadAgencyRoles(), []);
  const [selectedId, setSelectedId] = useState<string>();
  const [division, setDivision] = useState<'all' | AgencyDivision>('all');

  const filtered = useMemo(
    () => snapshot.roles.filter((role) => division === 'all' || role.division === division),
    [snapshot.roles, division],
  );
  const selected: AgencyRole | undefined = snapshot.roles.find((role) => role.id === selectedId);

  return <section className="page-stack agency-role-page">
    <div className="page-heading agency-role-heading">
      <div><span>EXTENSIONS & CAPABILITIES / AGENCY ROLES</span><h1>预置专业角色</h1><p>源自 agency-agents 的 {snapshot.roles.length} 个 MIT 许可角色。它们是可审查的**上下文候选**，不是可自动执行、授权或安装的插件。</p></div>
      <div><button title="返回扩展与能力页面。" onClick={onBack} type="button">← 返回扩展与能力</button></div>
    </div>

    <section className="design-foundation-card" aria-label="项目设计基线">
      <div><span>PROJECT DESIGN FOUNDATION</span><h2>UI Designer · Apple-first 设计简报</h2><p>项目根 <code>DESIGN.md</code> 与 Apple-first 设计契约是 UI Designer、Frontend Developer、UX Researcher 和 Code Reviewer 的共同依据。它优先保护可读性、系统字体、层级、行动清晰度与受控状态表达。</p></div>
      <dl><div><dt>主基线</dt><dd>Apple HIG、系统字体、行动蓝、克制材料层级</dd></div><div><dt>辅助模式</dt><dd>Linear 的表面阶梯；Raycast 的命令与键帽提示</dd></div><div><dt>安全边界</dt><dd>设计文本不会自动注入、授权、读取密钥或改变工具能力</dd></div></dl>
      <small>详细契约：<code>docs/design/apple-first-workbench-contract.md</code>。</small>
    </section>

    {snapshot.dropped > 0 && <p className="agency-role-error" role="alert">目录中有 {snapshot.dropped} 个角色因数据形状不合法被丢弃；请重新运行 <code>npm run agency:catalog</code>。</p>}

    <div className="agency-role-toolbar">
      <label>专业领域<select title="仅筛选角色目录，不会加载角色到任务。" value={division} onChange={(event) => { setDivision(event.target.value as typeof division); setSelectedId(undefined); }}>
        <option value="all">全部领域</option>
        {(['engineering', 'design', 'product', 'testing'] as const).map((item) => <option key={item} value={item}>{AGENCY_DIVISION_LABEL[item]}</option>)}
      </select></label>
      <span>{snapshot.roles.length} 个已归因角色 · {snapshot.license} · 不授予任何能力</span>
    </div>

    <div className="agency-role-layout">
      <div className="agency-role-list">{filtered.map((role) => <button
        aria-pressed={selectedId === role.id}
        className={`agency-role-item${selectedId === role.id ? ' active' : ''}`}
        key={role.id}
        onClick={() => setSelectedId(role.id)}
        title={`查看 ${role.displayName} 的来源、版权和角色文本。`}
        type="button"
      ><span>{AGENCY_DIVISION_LABEL[role.division]}</span><strong>{role.displayName}</strong><small>{role.description}</small><em>{snapshot.license} · 不授予权限</em></button>)}{filtered.length === 0 && <p className="agency-role-note">没有匹配的预置角色。</p>}</div>

      <aside className="agency-role-detail" aria-live="polite">{!selected
        ? <div className="agency-role-empty"><strong>选择一个角色查看详情</strong><span>角色正文已随应用打包，打开即读；不会联网，也不会自动注入任何任务。</span></div>
        : <>
          <header><div><span>{AGENCY_DIVISION_LABEL[selected.division]} · 来源角色</span><h2>{selected.displayName}</h2><p>{selected.description}</p></div><a href={selected.upstreamUrl} rel="noreferrer" target="_blank" title="在系统浏览器中打开上游文件。">查看上游来源 ↗</a></header>
          <div className="agency-role-license"><strong>{selected.license} 许可归因</strong><span>{selected.copyright}</span><small>角色正文不会授予工具、批准、秘密访问或自动执行。</small></div>
          <div className="agency-role-actions"><span>此目录目前**只读**：写入 Skill Pack 账本的动作尚未接入，因此没有"添加为候选"按钮。</span></div>
          <details className="agency-role-content"><summary title="展开上游复制的完整角色文本和文件内版权头。">查看带归因的角色原文</summary><pre>{selected.content}</pre></details>
        </>}</aside>
    </div>
  </section>;
}
