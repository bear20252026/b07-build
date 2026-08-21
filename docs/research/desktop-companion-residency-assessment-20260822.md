# Windows Desktop Companion 常驻评估

**日期：** 2026-08-22
**状态：** 研究完成；尚未将主窗口关闭改为隐藏，也尚未创建常驻角色窗口。
**范围：** 仅 Windows x64 首发；不将此机制视为后台自动化、屏幕捕获、麦克风采集、Discord、游戏控制或 API 调用授权。

## 可行性结论

Tauri 2 公开 API 提供系统托盘、窗口关闭请求拦截、隐藏窗口、唯一标签的多窗口创建和置顶查询能力，因此可以实现“关闭工作台主窗口后保留单独 Companion 角色窗口”的本机桌面模式。[1] [2] [3]

> 关键语义必须分开：用户点击主窗口关闭按钮时，可以由应用拦截关闭请求、隐藏主工作台并保留角色窗口与托盘；用户从托盘选择“退出 AI Work OS”时，必须真正退出所有窗口、Gateway sidecar 与角色资源。应用不得把关闭误导为永久退出，也不得使用户失去明确退出路径。

## Windows 首期架构

| 组件 | 职责 | 默认状态 | 不拥有的权限 |
| --- | --- | --- | --- |
| 主工作台窗口 | 任务、设置与审计 | 正常显示 | 不控制桌面/游戏/外部聊天 |
| Companion 窗口 | 无边框、可拖动、尺寸受限的 2D/VRM 舞台 | 视觉开关开启时创建 | 不读取屏幕、不采集音频、不执行工具 |
| 托盘菜单 | 显示工作台、显示/隐藏角色、暂停视觉角色、退出全部 | 随桌面壳启动 | 不隐式启动模型、TTS 或后台服务 |
| 显式退出 | 销毁 Companion、主窗口、托盘和 Gateway sidecar | 用户操作 | 不保留驻留进程 |

## 需要在实现前完成的前置条件

1. 在 Tauri Cargo feature 与 capability 清单中只增加托盘、窗口显示/隐藏、关闭和受限多窗口权限；不要向 WebView 暴露通用 shell、文件或系统权限。
2. Companion 窗口采用独立 label、最小化前端入口和动态按需资源加载；默认不能常驻网络连接或启动 TTS。
3. 需要在 Windows 真机验证透明窗口、GPU/WebView2 资源占用、多显示器 DPI、触控笔拖动与托盘退出路径；沙箱浏览器无法替代这些系统层验证。
4. 将“关闭角色窗口”和“退出整个应用”置于三级 Companion 设置与托盘菜单中，前者只销毁舞台，后者明确停止整个进程树。

## 平台边界

Android、iPadOS 和网页端不具有 Windows 系统托盘与桌面置顶窗口等价物。跨平台偏好契约可以共用，但“关闭主窗口后保留桌面角色”必须作为 Windows desktop-only 能力投影；移动端应对应为前台场景/应用内角色，网页端应对应为可关闭浮层，而不是伪造后台驻留。

## References

[1]: https://v2.tauri.app/learn/system-tray/ "Tauri v2 System Tray"
[2]: https://v2.tauri.app/learn/window-customization/ "Tauri v2 Window Customization"
[3]: https://v2.tauri.app/reference/javascript/api/namespacewindow/ "Tauri v2 Window API"
