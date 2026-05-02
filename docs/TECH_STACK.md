# 技术栈选型报告

## 当前阶段：P0-P2

- 前端框架：React + TypeScript + Vite。理由是启动快、生态成熟，适合 Three.js 工具型界面。
- 3D 引擎：Three.js。理由是 glTF 支持完善，OrbitControls、GLTFLoader、后续 TransformControls/后处理都可直接复用。
- UI 层：自定义 CSS 工具界面 + lucide-react 图标。当前界面需要专业软件式布局，先避免引入重型组件库；到方案管理、表格、表单增多时再评估 Ant Design 或 Arco Design。
- 后端框架：Node.js + Express。理由是与前端同栈，便于直接托管 glTF/PNG 静态资源和实现本地文件索引。
- 数据解析：TypeScript Markdown 解析器。先按现有 45 份结构化文档稳定提取标题、尺寸、层级、来源与正文。
- 数据库：P0/P1 暂不引入，P2 方案保存开始使用 SQLite，部署版再迁移 PostgreSQL。
- 模型格式：当前本地资产已是 glTF，P1 直接加载；后续加入 glTF-Transform 管线处理 Draco、KTX2 与 LOD。

## P3 预留

- 2D 画布：Konva.js 或 Fabric.js，优先 Konva.js。
- 图谱可视化：Cytoscape.js 或 ECharts Graph，优先 Cytoscape.js。
- AI 标注服务：Python + MobileSAM/FastSAM，单独服务化，前端以截图和点击坐标请求 mask。
