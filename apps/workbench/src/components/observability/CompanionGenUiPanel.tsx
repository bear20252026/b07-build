// 一个文件=一种作用：陪伴面（Companion）的 Gen UI 承载面板——把「Agent 即时生成的页面」
// 接进陪伴控制页，证明 Gen UI 双轨这条缝在工作台真实通电。
//
// 形态评估落点（见 PR 描述）：陪伴面适合承载**轻量、可即时生成、可调参**的呈现卡，
// 不适合承载上游那种带标注遮罩的全屏可视化编辑器。故这里的示例页面是一张「陪伴状态卡」：
// 展示 widgetState、提供颜色/滑杆/下拉/开关四类 Tweak 控件、并可发起一次追问。

import { useState } from 'react';
import type { GenUiStateTarget } from '@awo/protocol';
import { GenUiHost } from '../workspace/GenUiHost';

/**
 * 陪伴面 Gen UI 页面的归属键：workspace 用 `awo://companion` 伪路径（陪伴面不属于任何真实
 * 工作区目录），session 固定为 `companion-studio`；状态仍按 (workspace, session, path) 隔离。
 */
export const COMPANION_GEN_UI_TARGET: GenUiStateTarget = {
  workspacePath: 'awo://companion',
  sessionId: 'companion-studio',
  path: '/companion/companion-status-card.html',
};

/**
 * 示例页面：一张「陪伴状态卡」。脚本只使用宿主注入的 `window.zcode` 与 `window.Tweak`
 * 两个全局，不引用任何外部资源——验证「生成 HTML + 桥 + Tweak」三段都在真实环境里工作。
 */
export const COMPANION_STATUS_CARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>陪伴状态卡</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 14px; font: 13px/1.6 system-ui, sans-serif; color: #1f2933; background: transparent; }
  h1 { margin: 0 0 6px; font-size: 15px; }
  #card { display: grid; gap: 10px; }
  #mood { margin: 0; padding: 10px; border-radius: 12px; background: rgba(121, 183, 237, .16); }
  #follow { justify-self: start; padding: 6px 12px; border: 0; border-radius: 9px; color: #fff; background: #2879c8; font-size: 12px; font-weight: 700; }
  #tweak-container { display: block; height: 1px; }
</style>
</head>
<body>
  <section id="card">
    <h1>陪伴状态卡</h1>
    <p id="mood">等待宿主状态…</p>
    <button id="follow" type="button">让 Agent 据此继续</button>
    <div id="tweak-container" aria-label="陪伴状态卡参数"></div>
  </section>
<script>
(function () {
  var design = { accent: '#79b7ed', glow: 60, avatar: 'orbit', animate: true };
  var mood = document.getElementById('mood');
  function render() {
    mood.textContent = '强调色 ' + design.accent + ' · 光晕 ' + design.glow + '% · 角色 ' + design.avatar + ' · 动效 ' + (design.animate ? '开' : '关');
  }
  render();
  window.addEventListener('zcode:set_globals', function (event) {
    var globals = event.detail && event.detail.globals;
    if (globals && globals.widgetState && globals.widgetState.modelContent) {
      var saved = globals.widgetState.modelContent;
      mood.textContent = '已保存状态：' + JSON.stringify(saved);
    }
  });
  var tweak = new window.Tweak({
    container: document.getElementById('tweak-container'),
    onChange: function () {
      render();
      void window.zcode.setWidgetState({ modelContent: { accent: design.accent, glow: design.glow }, privateContent: { avatar: design.avatar, animate: design.animate } });
    }
  });
  tweak.addColorPicker(design, 'accent', { label: '强调色', reference: 'accent' });
  tweak.addSlider(design, 'glow', { label: '光晕强度', min: 0, max: 100, step: 5, unit: '%', reference: 'glow' });
  tweak.addSelect(design, 'avatar', { label: '角色', options: ['orbit', 'mori', 'pixel', 'sage'], reference: 'avatar' });
  tweak.addToggle(design, 'animate', { label: '动效', reference: 'animate' });
  document.getElementById('follow').addEventListener('click', function () {
    void window.zcode.sendFollowUpMessage({ prompt: '请根据陪伴状态卡当前的强调色、光晕强度与角色，给出一个更贴合的呈现建议。', title: '陪伴状态卡' });
  });
})();
</script>
</body>
</html>`;

export function CompanionGenUiPanel({ onFollowUp }: { readonly onFollowUp?: (prompt: string, title: string | undefined) => void | Promise<void> }) {
  const [mounted, setMounted] = useState(false);
  const [gateViolation, setGateViolation] = useState<string>();

  return (
    <section aria-label="陪伴面 Gen UI 承载" style={{ display: 'grid', gap: 8 }}>
      <div>
        <span className="panel-eyebrow">GEN UI / COMPANION</span>
        <h2>即时生成页面</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12 }}>
          陪伴面可以承载 Agent 即时生成的轻量 HTML 页面：页面运行在沙箱 iframe（无同源权限），
          状态经 <code>window.zcode</code> 回传宿主并按工作区/会话隔离，参数控件由工作台侧栏渲染。
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => setMounted((current) => !current)} title="挂载/卸载示例生成页面（沙箱 iframe）。">
          {mounted ? '收起示例页面' : '打开示例页面'}
        </button>
      </div>
      {gateViolation !== undefined && <small style={{ color: '#9b3845' }}>页面请求被宿主拒绝：{gateViolation}</small>}
      {mounted && (
        <GenUiHost
          target={COMPANION_GEN_UI_TARGET}
          html={COMPANION_STATUS_CARD_HTML}
          {...(onFollowUp === undefined ? {} : { onFollowUp })}
          onGateViolation={(reason) => setGateViolation(reason)}
        />
      )}
    </section>
  );
}
