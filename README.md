# 汉画像石数字化研究平台 WSC3D

> **当前版本**：`v0.8.0` · 图谱 UI 修缮 · 资源独立 tab · 三维生成正射图 ·
> 多资源画布切换 · 跨资源坐标变换 · `.hpsml` 解包 · 正射图 1:1 对齐与跨资源 SAM/YOLO

WSC3D 是一款面向汉画像石数字化研究的本地化工作台，把"高清原图 / 三维模型 /
拓片 / 正射图"等多源资源串成一个统一的图像志（iconography）研究流程。整个
系统由前端（React + Three.js + Konva）、后端（Node.js + Express）、AI 服务
（Python + FastAPI + MobileSAM + YOLOv8）三套进程组成，全部本地运行，数据
不出本机。

平台围绕三大核心模块展开：

| 模块 | 用途 |
| --- | --- |
| **浏览** | 单块画像石的 3D / 2D / 正射视图，光照 / 背景可调，按结构化尺寸自动校准的真实距离测量。 |
| **拼接** | 多块画像石加载到统一 Three.js 场景，支持平移 / 旋转 / 长边等比缩放 / 面对面贴合，方案以 JSON 持久化。 |
| **标注** | 基于 IIML 的图像志标注工作台，含双底图 / 多资源 / SAM / YOLO / 知识图谱 / 多解释并存等 12 项核心能力，详见下文。 |

## 标注模块亮点

- **多源底图**：3D 模型 + 高清原图 双底图，**多资源画布切换**（pic 原图 /
  正射 / 拓片 / 法线图 / RTI / 点云 / 线图 / 自定义自由切换）
- **一键正射图**：从三维模型生成与 modelBox 1:1 对齐的正射 PNG 作为标注底图，
  替代缺失的原图
- **跨资源坐标变换**：在等价正射图上的标注与 3D 模型视图自动双向同步；非等
  价资源（背 / 顶 / 底面 / 拓片 / 法线图）走 4 点单应性标定
- **5 种 AI 线图算法**：canny / canny-plus / sobel / scharr / morph 各自落盘
  缓存，浏览器并发请求互不影响
- **三层 AI 候选**：YOLO 批量扫描（CLAHE 双跑增强检出率） + SAM 多 prompt 精修
  + YOLO bbox 一键 SAM 精修；候选支持几何并集合并
- **AI 处理记录全程可溯源**：每次 SAM / YOLO / Canny 调用记一条
  `processingRun`，论文要求的"候选可追溯到具体模型 + 参数 + 时间"自动满足
- **标注间关系**：14 种受控词（叙事 / 层级 / 空间 / 解释并存）+ 空间关系
  自动推导 + 用户采纳
- **Cytoscape 知识图谱**：4 种中心性算法（权威度 / 邻居数 / 桥梁度 / 接近度）
  + MCL 群组检测 + top-N 金色光环 + 横向排行榜
- **多解释并存对比**：同一画面对象的多视角释读（A 学者读"青龙" / B 读"独角兽"）
  在 RelationsEditor 上方并排卡片对比
- **批量任务进度面板**：长任务可中途取消
- **5 种学术导出**：IIML / CSV / COCO（喂 YOLO 训练）/ IIIF Web Annotation /
  `.hpsml` 自定义研究包
- **`.hpsml` 一键解包导入**：跨机器迁移完整研究状态

## 快速开始

```bash
npm install
cd ai-service && pip install -r requirements.txt && cd ..
npm run dev
```

`npm run dev` 通过 `concurrently` 并行启动后端、前端、AI 服务三套进程。
启动后访问：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:3100`
- AI 服务：`http://127.0.0.1:8000`

> AI 服务首次启动会从 GitHub 自动下载 MobileSAM 权重（约 39 MB）到
> `ai-service/weights/`，下载期间前端 SAM 按钮会显示"加载中"。
>
> 高清原图请放进仓库根目录的 `pic/`（已 `.gitignore`），文件名以画像石编号开头
> 即可（例如 `29东汉武氏祠...tif`），AI 服务会按数字前缀匹配并按需做
> tif → PNG 转码缓存。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run scan` | 扫描本地资源、生成缓存 summary |
| `npm run typecheck` | 前后端 TypeScript 类型检查 |
| `npm run build` | 构建前后端产物 |
| `npm run dev:backend` | 仅启动后端 |
| `npm run dev:frontend` | 仅启动前端 |
| `npm run migrate:iiml-frame` | 一次性给历史 IIML 文档补 `frame="model"` 字段 |

## 技术栈

- **前端**：React 19 + Vite + TypeScript；3D 渲染用 Three.js + OrbitControls，
  2D 标注画布用 react-konva，多边形并集用 polygon-clipping，知识图谱用 cytoscape。
- **后端**：Node.js + Express + TypeScript；本地静态托管 GLTF / PNG 资源，
  IIML 文档由 ajv 校验后落盘到 `data/iiml/`，拼接方案落盘到 `data/assembly-plans/`。
- **AI 服务**：Python + FastAPI + Pillow / numpy / OpenCV / MobileSAM / ultralytics；
  提供 SAM 多 prompt 智能分割、YOLOv8n 批量目标检测、5 种 Canny 线图、高清图
  tif → PNG 转码缓存等。
- **数据格式**：标注采用类 IIML 的 JSON 文档；坐标系有两套 ——
  `modelBox` 归一化 `(u, v) ∈ [0, 1]²` 与高清图自身归一化坐标，每条标注用
  `frame` 字段区分；两套坐标系可通过 `culturalObject.alignment`（4 点单应性
  矩阵）相互投影。

## 数据资源

启动前请确认本机已具备以下目录（均位于仓库父目录或通过环境变量自定义）：

| 目录 | 内容 | 默认路径 | 备注 |
| --- | --- | --- | --- |
| 三维模型 | 64+ 个 `.gltf` / `.png` 缩略图 | `./temp` | 入库 `.gitignore` |
| 结构化分档 | 45 份画像石 Markdown 档案 | `./画像石结构化分档` | 入库 `.gitignore` |
| 参考图 | 标注系统设计参考截图 | `./参考图` | 入库 `.gitignore` |
| 高清原图 | 画像石 tif/jpg/png（数字前缀匹配 stoneId） | `./pic` | 入库 `.gitignore` |
| AI 转码缓存 | 高清图 tif → PNG 落盘缓存 | `./ai-service/cache/source/` | 入库 `.gitignore` |
| 线图缓存 | 各 method × 阈值组合的线图 PNG | `./ai-service/cache/lineart/` | 入库 `.gitignore` |
| SAM 权重 | `mobile_sam.pt`（首次启动自动下载） | `./ai-service/weights/` | 入库 `.gitignore` |
| 术语库 | 人物 / 动物 / 器物 / 场景 / 纹饰 受控词 | `./data/terms.json` | |
| 标注存储 | 每块画像石一份 IIML | `./data/iiml/<stoneId>.iiml.json` | |
| 拼接方案 | JSON 形式持久化 | `./data/assembly-plans/` | |
| 资源落盘 | 用户生成 / 上传的正射 / 拓片等 | `./data/stone-resources/<stoneId>/` | |

可通过环境变量自定义：`WSC3D_ROOT`、`WSC3D_MODEL_DIR`、`WSC3D_METADATA_DIR`、
`WSC3D_REFERENCE_DIR`、`WSC3D_PIC_DIR`、`WSC3D_IIML_DIR`。

## API 一览

### 后端 Express（`:3100`）

```text
GET    /api/health                          健康检查
GET    /api/scan                            扫描汇总
POST   /api/scan/refresh                    强制重建目录缓存
GET    /api/stones                          画像石列表
GET    /api/stones/:id/model                画像石模型
GET    /api/stones/:id/metadata             结构化档案
GET    /api/stones/:id/resources            画像石资源列表（正射 / 拓片等）
POST   /api/stones/:id/resources            上传画像石资源（PNG raw 或 base64）
DELETE /api/stones/:id/resources/:fileName  删除一份正射图（其它类型受保护）
GET    /api/reference-images                参考图列表
GET    /api/terms                           受控术语库
GET    /api/iiml/:stoneId                   读取 IIML 标注文档
PUT    /api/iiml/:stoneId                   保存 IIML 标注文档（ajv 校验）
GET    /api/iiml/alignments                 所有画像石的 4 点对齐状态
GET    /api/iiml/context                    IIML JSON-LD 上下文
POST   /api/iiml/:stoneId/import-md         从结构化档案导入标注
POST   /api/hpsml/import                    .hpsml 研究包解包导入
GET    /api/assembly-plans                  拼接方案列表
GET    /api/assembly-plans/:id              单条拼接方案
POST   /api/assembly-plans                  保存拼接方案
```

### AI 服务 FastAPI（`:8000`）

```text
GET    /ai/health                       健康检查 + SAM 加载状态
POST   /ai/sam                          SAM 智能分割（imageUri / stoneId / base64 三路径）
POST   /ai/yolo                         YOLOv8n 目标检测（同三路径，CLAHE 双跑）
POST   /ai/canny                        OpenCV Canny 线图（旧 base64 路径）
GET    /ai/source-image/{stone_id}      高清原图 tif → PNG 转码缓存
GET    /ai/lineart/{stone_id}           线图 PNG（5 种算法 / 阈值组合各自缓存）
GET    /ai/lineart/methods              支持的线图方法列表
```

## 模块详解

### 浏览模块

- 3D / 2D / 正射 三种视图，2D 模式锁定为正面正交相机；视角骰子可切到 6 个面
- 测量工具按当前模型长边自动校准为 cm；未匹配尺寸时回落到模型单位
- 背景与光照分档可独立切换，便于查看不同浮雕阴影

### 拼接模块

- 最多同时加载 10 块模型，独立 Three.js 场景
- 可锁定参考块、对其他块做 1 / 5 / 10 cm 步长平移与 5° / 任意角度旋转
- 方案以 JSON 保存到 `data/assembly-plans/`，支持重命名、重新加载

### 标注模块

#### 双底图

- 画布右上角 segmented 切换 **3D 模型 / 高清图**，两种模式下统一支持滚轮缩放
  （围绕光标）+ 中键 / 右键拖动 pan
- **3D 模型模式**：用 modelBox UV `(u, v) ∈ [0, 1]²` 作为标注坐标系；视图变换
  由 OrbitControls 处理
- **高清图模式**：从 `/ai/source-image/:stoneId` 拉取 tif → PNG 转码后的高清原
  图；标注坐标系是图自身归一化坐标，SAM 候选与显示**天然对齐**

#### 多资源切换（v0.8.0）

高清图模式下出现资源切换条，自动列出 IIML `resources[]` 里的所有图像类资源：

- 默认"原图"（pic/ 走 `/ai/source-image/`）
- Orthophoto / Rubbing / NormalMap / LineDrawing / OriginalImage / RTI / Other
  类型均会被列成 chip
- 切到非 pic/ 资源时强制禁用 Canny 线图叠加（线图管线只处理 pic/ 原图）
- **等价正射图**（view = front + frustumScale = 1.0）：图像 UV ≡ modelBox UV，
  标注与 3D 模型视图双向自动同步，顶部出现绿色徽章提示

#### 工具集

- 选择 / 移动、矩形、圆 / 椭圆、点、钢笔（多边形，双击或回车闭合）
- **SAM 多 prompt 智能分割**：左键正点 / 右键负点 / Shift + 左键拖框 → Enter
  提交一次推理；高清图路径（stoneId 或 imageUri + MobileSAM ViT-T） + 当前
  视角截图 fallback
- **YOLO 批量扫描**：工具栏 `Radar` 按钮一次给候选 tab 喂 N 个 bbox，再用
  SAM 二次精修
- **AI 线图叠加**：5 种边缘检测算法 + 阈值滑杆 + 透明度，半透明白线突出浅
  浮雕轮廓
- **对齐校准（Crosshair）**：4 点单应性标定，详见下文

#### 一标注一图层

- 每条标注自带颜色、可见性、锁定、`reviewStatus`（候选 / 已审 / 已通过 /
  已拒绝）
- 创建后进入"草稿"，详情面板有「确定 / 取消 / 删除」；草稿外的也可随时
  重命名、隐藏、锁定、删除
- 浏览模式下不再渲染标注；标注文档自动保存到
  `data/iiml/<stoneId>.iiml.json`，遵守 IIML 约束（ajv 校验）

#### IIML / ICON 三层

- 详情面板：结构层级（whole / scene / figure / component / trace / inscription
  / damage / unknown）
- 图像志三层文本：前图像志（preIconographic）/ 图像志（iconographicMeaning）
  / 图像学（iconologicalMeaning）
- 题刻条件子面板：仅当 `structuralLevel === "inscription"` 时出现
- 受控术语多选：从 `data/terms.json` 检索 + chip 多选 + 自定义；附 D6 共现
  推荐
- 证据源数组：metadata / reference / resource / other 四种 kind 判别联合
- 导出按钮：IIML / CSV / COCO / IIIF / `.hpsml` 五种格式各自一键下载

#### SAM 候选闭环

- 候选 tab 批量审阅：单条 Approve / Reject / Retry，全部接受 / 全部拒绝
- **多选合并**（polygon-clipping union）：候选 / 列表两个 tab 都支持勾选 ≥ 2 条
  多边形 → "合并选中" → 几何并集（只保留外环），合并后的 reviewStatus 智能
  继承

#### 4 点对齐校准

- 工具栏 `Crosshair` 按钮启动；按钮右下角青色圆点表示已校准
- 流程："乒乓式" 4 对点采集 —— 在 3D 模型上点 4 个特征点后自动切到高清图，
  再点 4 个对应位置 → review 阶段两套点叠加显示（橙色 = 当前 frame，青色虚化
  = 投影自对面 frame）→ 保存进 `culturalObject.alignment`
- 渲染：跨 frame 标注用稀疏虚线 + 半透明显示（"投影态"），仅可点选不可拖拽
  编辑；未校准时跨 frame 标注被隐藏并提示
- 数学核心：4 点 DLT 解 3 × 3 单应性矩阵 + 高斯消元求解 + 3 × 3 求逆，封装
  在 `frontend/src/modules/annotation/homography.ts`

## 目录结构

```text
ai-service/        AI 子服务（Python + FastAPI）
  app/
    main.py            FastAPI 路由入口
    sam.py             MobileSAM 推理 + 高清图加载 + tif → PNG 转码
    yolo.py            YOLOv8n 通用模型 + CLAHE 双跑
    canny.py           5 种线图算法 + 落盘缓存
    utils.py           base64 / 像素工具
  weights/             MobileSAM / YOLOv8 权重（首次启动自动下载）
  cache/source/        高清图转码 PNG 缓存
  cache/lineart/       线图 PNG 缓存
backend/           Node.js 后端
  src/
    server.ts            Express 入口 + 路由
    services/catalog.ts  目录扫描与 stoneId 匹配
    services/iiml.ts     IIML 持久化 + ajv 校验 + Markdown 导入
    services/hpsml.ts    .hpsml 研究包解包导入
    parsers/markdownParser.ts  结构化档案 Markdown 解析器
    scripts/                  一次性脚本（scan / migrate-iiml-frame）
frontend/          React + Three.js + Konva 前端
  src/
    App.tsx                  应用根 + 全局状态 + 模式切换
    api/client.ts            统一 HTTP 封装 + IIML / AI 类型契约
    modules/viewer/          浏览模块（StoneViewer + SourceImageView）
    modules/assembly/        拼接模块（Workspace + Panel + AdjustControls）
    modules/annotation/      标注模块（约 25 个组件 + 工具）
      AnnotationCanvas.tsx     Konva 画布（含跨 frame 渲染、标定 overlay）
      AnnotationWorkspace.tsx  工作区容器（双底图切换 + 多资源切换）
      AnnotationPanel.tsx      详情面板（5 个 tab：编辑 / 候选 / 列表 / 图谱 / 资源）
      AnnotationToolbar.tsx    左侧工具栏
      KnowledgeGraphView.tsx   cytoscape 图谱（4 中心性 + MCL）
      ResourcesEditor.tsx      资源 tab（生成正射 + IIML / 后端落盘列表）
      RelationsEditor.tsx      关系编辑器（14 种受控词）
      ProcessingRunsList.tsx   AI 处理记录
      AlternativeInterpretationsView.tsx  多解释并存
      TermPicker.tsx           受控术语多选
      SourcesEditor.tsx        证据源编辑器
      TaskProgressPanel.tsx    批量任务进度
      YoloScanDialog.tsx       YOLO 扫描参数
      ColorPopover.tsx         颜色选择
      geometry.ts              UV / 屏幕坐标转换、几何工厂
      homography.ts            4 点单应性矩阵求解
      merge.ts                 候选合并（polygon-clipping union）
      sam.ts                   SAM 客户端（双路径 fallback）
      orthophoto.ts            从 3D 模型生成正射 PNG
      spatial.ts               空间关系自动推导
      cooccurrence.ts          受控术语共现推荐
      exporters.ts             5 种学术导出
      graphMetrics.ts          中心性算法 + MCL 群组
      store.ts                 标注 reducer + 选择器
      types.ts                 模块本地类型 + IIML re-export
    modules/shared/      视角骰子等共享组件
data/              术语库、IIML 文档、拼接方案、资源落盘
docs/              技术方案、Release Notes、ROADMAP、工作日志
temp/              本地三维模型源文件（不入库）
pic/               高清原图 tif / jpg / png（不入库，AI 服务读这里）
画像石结构化分档/   45 份画像石 Markdown 档案（不入库）
参考图/            标注系统的 UI 参考截图（不入库）
```

## 版本与发布

| 版本 | 主题 | 链接 |
| --- | --- | --- |
| **v0.8.0** | 图谱 UI 修缮 · 资源独立 tab · 三维生成正射图 · 多资源画布切换 · 跨资源坐标变换 · `.hpsml` 解包 | [Release Notes](docs/RELEASE_NOTES_v0.8.0.md) |
| v0.7.0 | 紧急修复 · 图谱完善 · 多解释 UI · AI 加深 · 多资源 · `.hpsml` 包 | [Release Notes](docs/RELEASE_NOTES_v0.7.0.md) |
| v0.6.0 | M3 收尾 · 学术导出 · 工程瘦身 | [Release Notes](docs/RELEASE_NOTES_v0.6.0.md) |
| v0.5.0 | 关系网络 · 知识图谱 · 工程闭环 | [Release Notes](docs/RELEASE_NOTES_v0.5.0.md) |
| v0.4.0 | AI 加深：SAM 多 prompt · AI 线图 · YOLO 批量候选 | [Release Notes](docs/RELEASE_NOTES_v0.4.0.md) |
| v0.3.0 | AI 标注闭环 · 多源底图 · 4 点对齐校准 | [Release Notes](docs/RELEASE_NOTES_v0.3.0.md) |
| v0.2.2 | 标注模块 ICON 化与工程小修 | [Release Notes](docs/RELEASE_NOTES_v0.2.2.md) |
| v0.2.1 | 拼接模块多石拖动修复 | [Release Notes](docs/RELEASE_NOTES_v0.2.1.md) |
| v0.2.0 | 标注模块「一标注一图层」重构 | [Release Notes](docs/RELEASE_NOTES_v0.2.0.md) |

> 工作日志记录了 v0.4.0 → v0.8.0 的连续推进时间线，详见
> [`docs/WORK_LOG_post_v0.4.0.md`](docs/WORK_LOG_post_v0.4.0.md) /
> [`docs/WORK_LOG_post_v0.5.0.md`](docs/WORK_LOG_post_v0.5.0.md) /
> [`docs/WORK_LOG_post_v0.6.0.md`](docs/WORK_LOG_post_v0.6.0.md) /
> [`docs/WORK_LOG_post_v0.7.0.md`](docs/WORK_LOG_post_v0.7.0.md)。

## 路线图

详细计划见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。简要：

- **v0.9.0 候选**：画布跨资源投影（读 `resource.transform` 把标注投影到当前
  底图坐标系）+ `.hpsml` 三方合并 + canny 管线支持任意 URI（正射 / 拓片也能
  叠线图）+ 资源选择状态持久化。
- **AI 加深**：用现有 COCO 导出 + 1000+ 标注积累后微调汉画像石专用 YOLO
  （v0.7.0 的批量 SAM 精修 + v0.8.0 正射图能加速积累训练数据）；AI 线图接入
  HED / Relic2Contour 深度学习方法。
- **工程**：Playwright 端到端覆盖（需要稳定 dev 环境）；多用户协作 provenance；
  图谱节点群组识别加权。

## 协议与致谢

- 许可：本项目目前仅作研究使用，未对外开源 license（如有需要请联系作者）。
- 致谢：MobileSAM、Ultralytics YOLOv8、Three.js、Konva、Cytoscape、polygon-clipping
  等优秀开源项目让本平台得以快速迭代。
