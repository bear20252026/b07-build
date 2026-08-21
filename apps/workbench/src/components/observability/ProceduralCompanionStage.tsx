/**
 * 零依赖的本地程序化 3D 回退角色。
 * 使用浏览器 CSS 三维透视和多个几何面构成，而非远端资产或 VRM 文件。
 * 它是真实可见的立体舞台，但不声称是可导入的 VRM；经审查 VRM 到位后可替换该组件。
 */
export function ProceduralCompanionStage({ enabled }: { enabled: boolean }) {
  if (!enabled) return <div aria-label="Companion 角色呈现关闭" className="procedural-companion-stage"><span>角色呈现关闭</span></div>;
  return <div aria-label="本地程序化 3D Companion 预览" className="procedural-companion-stage">
    <div className="companion-3d-scene" aria-hidden="true">
      <div className="companion-3d-robot">
        <div className="companion-3d-head"><i className="companion-3d-visor"><b /><b /></i></div>
        <div className="companion-3d-neck" />
        <div className="companion-3d-body"><i /><b /></div>
        <div className="companion-3d-arm companion-3d-arm--left" /><div className="companion-3d-arm companion-3d-arm--right" />
        <div className="companion-3d-leg companion-3d-leg--left" /><div className="companion-3d-leg companion-3d-leg--right" />
      </div>
    </div>
  </div>;
}
