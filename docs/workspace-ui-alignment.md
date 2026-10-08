# 工作台与前台视觉统一

日期：2026-10-08（北京时间）。用户要求工作台整体 UI 与前台对齐。

## 实施

- `App.tsx` 为两端使用共同的 `museum-shell`，工作台增加 `workspace-shell`，登录页增加 `workspace-entry`。研究工作台标识收进品牌副标题。
- `publicShell.css` 的前台导航样式改为两端共享：深褐底色、白色标志、楷体品牌字、宋体栏目和细线选中态。修复中等宽度时旧规则把导航排到账户操作之后的问题。
- `workspaceTheme.css` 统一工作台二级导航、标题、面板、输入框、按钮、边线及键盘焦点。覆盖图像研究、三维复原、文献中心、电子文创、API配置与登录界面；沿用现有浅色/深色语义颜色。
- 窄屏保留全部导航和操作；390px 下品牌、账户操作、导航分行，导航可横向滚动。

## 验证

使用现有本机 Python 工具执行 `tools/build_frontend.py`，TypeScript 检查与 Vite 构建通过，产物写入 `build/web`。重新载入页面后确认最新构建生效，未重启后端。

浏览器检查五个工作台模块，以及前台首页、登录页。核对文献库/扩展库切换、三维复原组别切换、1200px 下的导航顺序、390px 下的表单和页面宽度、浅色/深色主题及2px键盘焦点轮廓。未记录浏览器控制台错误。检查后恢复浅色主题及浏览器原有视窗尺寸。

证据保存在 `output/workspace-ui-20261008/`：

- `build.log`：最终构建日志。
- `verification.json`：交互和响应式检查记录。
- `reconstruction-desktop.jpg`、`reconstruction-mobile.jpg`、`reconstruction-dark.jpg`：三维复原界面。
- `research-desktop.jpg`、`library-desktop.jpg`、`creative-desktop.jpg`：其他主要模块检查图。
