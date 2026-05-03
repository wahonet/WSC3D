# 汉画像石数字化研究平台 (WSC3D)

> 当前版本：`v0.5.0` —— 关系网络 · 知识图谱 · 工程闭环

面向汉画像石数字化研究的本地化工作台，目前提供三大模块：

- **浏览**：单块画像石的 3D / 2D / 正射视图，可切换光照、背景、视角骰子，支持基于结构化尺寸的真实距离测量。
- **拼接**：多块画像石加载至同一拼接场景，提供平移/旋转微调、长边等比缩放、面对面贴合，方案可保存为 JSON。
- **标注**：基于 IIML 的图像志标注工作台。**3D 模型 / 高清原图双底图**自由切换；**AI Canny 线图**叠加辅助辨识浅浮雕轮廓；**YOLO 批量扫描** + **SAM 多 prompt 精修**（左键正点 / 右键负点 / Shift+左键拖框）双管线 AI 候选；候选可多选**几何并集**合并；4 点单应性**对齐校准**让两种底图下的标注双向投影；**标注间关系**（叙事 / 层级 / 空间 / 解释 14 种受控词）+ **空间关系自动推导**+ **Cytoscape 知识图谱 tab**形成完整的叙事网络；快捷键覆盖工具切换 / 撤销重做 / fit 视角。

## 快速开始

```bash
npm install
cd ai-service && pip install -r requirements.txt && cd ..
npm run dev
```

`npm run dev` 会通过 `concurrently` 并行启动后端、前端、AI 服务三套进程。
启动后访问：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:3100`
- AI 服务：`http://127.0.0.1:8000`

> AI 服务首次启动会从 GitHub 自动下载 MobileSAM 权重（约 39 MB）到 `ai-service/weights/`。
> 高清原图请放进仓库根目录的 `pic/`（已 `.gitignore`），文件名以画像石编号开头即可（例如 `29东汉武氏祠...tif`），AI 服务会按数字前缀匹配并按需做 tif → PNG 转码缓存。

## 常用命令

```bash
npm run scan        # 扫描本地资源、生成缓存
npm run typecheck   # 前后端 TypeScript 类型检查
npm run build       # 构建前后端产物
npm run dev:backend # 仅启动后端
npm run dev:frontend # 仅启动前端
```

## 技术栈

- **前端**：React 19 + Vite + TypeScript，3D 用 Three.js + OrbitControls，2D 标注画布用 react-konva，多边形并集用 polygon-clipping。
- **后端**：Node.js + Express + TypeScript，本地静态托管 GLTF/PNG，IIML 标注文档由 ajv 校验后落盘到 `data/iiml/`。
- **AI 服务**：Python + FastAPI + Pillow/numpy/OpenCV/MobileSAM/ultralytics，提供 SAM 多 prompt 智能分割、YOLOv8n 批量目标检测、Canny 线图、高清图 tif→PNG 转码缓存等。
- **数据格式**：标注采用类 IIML 的 JSON 文档；坐标系有两套——`modelBox` 归一化 `(u, v) ∈ [0, 1]²` 与高清图自身归一化坐标，每条标注用 `frame` 字段区分；两套坐标系可通过 `culturalObject.alignment`（4 点单应性矩阵）相互投影。

## 数据资源

启动前请确认本机已具备以下目录（均位于仓库父目录或通过环境变量自定义）：

| 目录 | 内容 | 默认路径 | 备注 |
| --- | --- | --- | --- |
| 三维模型 | 64+ 个 `.gltf` / `.png` 缩略图 | `./temp` | 入库 `.gitignore` |
| 结构化分档 | 45 份画像石 Markdown 档案 | `./画像石结构化分档` | 入库 `.gitignore` |
| 参考图 | 标注系统设计参考截图 | `./参考图` | 入库 `.gitignore` |
| 高清原图 | 画像石 tif/jpg/png（数字前缀匹配 stoneId） | `./pic` | 入库 `.gitignore` |
| AI 转码缓存 | 高清图 tif → PNG 落盘缓存 | `./ai-service/cache/source/` | 入库 `.gitignore` |
| SAM 权重 | `mobile_sam.pt`（首次启动自动下载） | `./ai-service/weights/` | 入库 `.gitignore` |
| 术语库 | `data/terms.json`（人物 / 动物 / 器物 / 场景 / 纹饰） | `./data/terms.json` | |
| 标注存储 | `data/iiml/<stoneId>.iiml.json` | `./data/iiml/` | |

可通过环境变量自定义：`WSC3D_ROOT`、`WSC3D_MODEL_DIR`、`WSC3D_METADATA_DIR`、`WSC3D_REFERENCE_DIR`、`WSC3D_PIC_DIR`。

## 主要接口

后端（Express，`:3100`）：

```text
GET  /api/scan                        扫描汇总
GET  /api/stones                      画像石列表
GET  /api/stones/:id/model            画像石模型
GET  /api/stones/:id/metadata         画像石结构化档案
GET  /api/reference-images            参考图列表
GET  /api/terms                       受控术语库
GET  /api/iiml/:stoneId               读取 IIML 标注文档
PUT  /api/iiml/:stoneId               保存 IIML 标注文档（ajv 校验）
GET  /api/assembly-plans              拼接方案列表
POST /api/assembly-plans              保存拼接方案
```

AI 服务（FastAPI，`:8000`）：

```text
GET  /ai/health                       健康检查 + SAM 加载状态
POST /ai/sam                          SAM 智能分割（多 prompt：正点 / 负点 / box；
                                      stoneId 高清图 / imageBase64 截图双路径）
POST /ai/yolo                         YOLOv8n 目标检测（stoneId / imageBase64 双路径，
                                      classFilter / confThreshold / maxDetections）
POST /ai/canny                        OpenCV Canny 线图（旧 base64 路径）
GET  /ai/source-image/{stone_id}      高清原图 tif → PNG 转码（带磁盘缓存，max_edge 可调）
GET  /ai/lineart/{stone_id}           Canny 线图 PNG（method/low/high/max_edge，
                                      落盘缓存到 ai-service/cache/lineart/）
```

## 模块概览

### 浏览模块

- 3D / 2D / 正射 三种视图，2D 模式锁定为正面正交相机；视角骰子可切到 6 个面。
- 测量工具按当前模型长边自动校准为 cm；未匹配尺寸时回落到模型单位。
- 背景与光照分档可独立切换，便于查看不同浮雕阴影。

### 拼接模块

- 最多同时加载 10 块模型，独立 Three.js 场景。
- 可锁定参考块、对其他块做 1/5/10 cm 步长平移与 5°/任意角度旋转。
- 方案以 JSON 保存到 `data/assembly-plans/`，支持重命名/重新加载。

### 标注模块

#### 底图（双源）

- 画布右上角 segmented 切换 **3D 模型 / 高清图**，两种模式下统一支持滚轮缩放（围绕光标）+ 中键 / 右键拖动 pan。
- **3D 模型模式**：用 modelBox UV `(u, v) ∈ [0, 1]²` 作为标注坐标系；视图变换由 OrbitControls 处理。
- **高清图模式**：从 `/ai/source-image/:stoneId` 拉取 tif → PNG 转码后的高清原图，标注坐标系是图自身归一化坐标；SAM 候选与显示在同一坐标系，识别后**天然对齐**。

#### 工具集

- 选择 / 移动、矩形、圆 / 椭圆、点、钢笔（多边形，双击或回车闭合）
- **SAM 多 prompt 智能分割**（v0.4.0 升级）：左键正点 / 右键负点 / Shift+左键拖框 → Enter 提交一次推理；高清图路径（`stoneId` + MobileSAM ViT-T）+ 当前视角截图 fallback
- **YOLO 批量扫描**（v0.4.0 新增）：工具栏 `Radar` 按钮一次给候选 tab 喂 N 个 bbox，再用 SAM 二次精修
- **AI Canny 线图叠加**（v0.4.0 新增）：高清图模式下 mini segmented 切 "+线图"，半透明白线突出浅浮雕轮廓
- **对齐校准（Crosshair）**：4 点单应性标定，详见下文

#### 一标注一图层

- 每条标注自带颜色、可见性、锁定、`reviewStatus`（候选 / 已审 / 已通过 / 已拒绝）。
- 创建后进入"草稿"，详情面板有「确定 / 取消 / 删除」；草稿外的也可随时重命名、隐藏、锁定、删除。
- 浏览模式下不再渲染标注；标注文档自动保存到 `data/iiml/<stoneId>.iiml.json`，遵守 IIML 约束（ajv 校验）。

#### IIML / ICON 三层

- 详情面板：结构层级（whole / scene / figure / component / trace / inscription / damage / unknown）
- 图像志三层文本：前图像志（preIconographic）/ 图像志（iconographicMeaning）/ 图像学（iconologicalMeaning）
- 题刻条件子面板：仅当 `structuralLevel === "inscription"` 时出现
- 受控术语多选：从 `data/terms.json` 检索 + chip 多选 + 自定义
- 证据源数组：`metadata` / `reference` / `resource` / `other` 四种 kind 判别联合
- 导出按钮：`<stoneId>-<yyyymmdd-hhmm>.iiml.json` 一键下载

#### SAM 候选闭环

- 候选 tab 批量审阅：单条 Approve / Reject / Retry，全部接受 / 全部拒绝
- **多选合并（polygon-clipping union）**：候选 / 列表两个 tab 都支持勾选 ≥ 2 条多边形 → "合并选中" → 几何并集（只保留外环），合并后的 reviewStatus 智能继承（任一源是候选 → 候选；否则跟随第一个源）

#### 4 点对齐校准

- 工具栏 `Crosshair` 按钮启动；状态指示：已校准时按钮右下角青色圆点
- 流程："乒乓式" 4 对点采集 —— 在 3D 模型上点 4 个特征点后自动切到高清图，再点 4 个对应位置 → review 阶段两套点叠加显示（橙色 = 当前 frame，青色虚化 = 投影自对面 frame）→ 保存进 `culturalObject.alignment`
- 渲染：跨 frame 标注用稀疏虚线 + 半透明显示（"投影态"），仅可点选不可拖拽编辑；未校准时跨 frame 标注被隐藏并提示
- 数学核心：4 点 DLT 解 3×3 单应性矩阵 + 高斯消元求解 + 3×3 求逆，封装在 `frontend/src/modules/annotation/homography.ts`

## 目录结构

```text
ai-service/        AI 子服务（Python + FastAPI）
  app/sam.py             MobileSAM 推理 + 高清图加载 + tif→PNG 转码
  app/main.py            FastAPI 路由
  weights/               MobileSAM 权重（首次启动自动下载）
  cache/source/          高清图转码 PNG 缓存
backend/           Node.js 后端（API、目录扫描、IIML 持久化）
frontend/          React + Three.js 前端
  src/modules/viewer/      浏览模块（StoneViewer + SourceImageView）
  src/modules/assembly/    拼接模块
  src/modules/annotation/  标注模块（画布 + 面板 + Store）
    geometry.ts            UV / 屏幕坐标转换、几何工厂
    homography.ts          4 点单应性矩阵求解
    merge.ts               候选合并（polygon-clipping union）
    sam.ts                 SAM 客户端（双路径 fallback）
    AnnotationCanvas.tsx   Konva 画布主体（含跨 frame 渲染、标定 overlay）
    AnnotationWorkspace.tsx 工作区容器（双底图切换 + 标定流程状态机）
    AnnotationPanel.tsx    详情面板（ICON 三层 + 候选审阅 + 多选合并）
    AnnotationToolbar.tsx  左侧工具栏
  src/modules/shared/      视角骰子等共享组件
data/              术语库、IIML 文档、拼接方案
docs/              技术方案、Release Notes、ROADMAP、扫描报告
temp/              本地三维模型源文件（实际项目不入库）
pic/               高清原图 tif/jpg/png（不入库，AI 服务读这里）
画像石结构化分档/   45 份画像石 Markdown 档案
参考图/            标注系统的 UI 参考截图
```

## 版本与发布

| 版本 | 主题 | 链接 |
| --- | --- | --- |
| v0.5.0 | 关系网络 · 知识图谱 · 工程闭环 | [Release Notes](docs/RELEASE_NOTES_v0.5.0.md) |
| v0.4.0 | AI 加深：SAM 多 prompt · AI 线图 · YOLO 批量候选 | [Release Notes](docs/RELEASE_NOTES_v0.4.0.md) |
| v0.3.0 | AI 标注闭环 · 多源底图 · 4 点对齐校准 | [Release Notes](docs/RELEASE_NOTES_v0.3.0.md) |
| v0.2.2 | 标注模块 ICON 化与工程小修 | [Release Notes](docs/RELEASE_NOTES_v0.2.2.md) |
| v0.2.1 | 拼接模块多石拖动修复 | [Release Notes](docs/RELEASE_NOTES_v0.2.1.md) |
| v0.2.0 | 标注模块「一标注一图层」重构 | [Release Notes](docs/RELEASE_NOTES_v0.2.0.md) |

> 工作日志：v0.4.0 → v0.5.0 由 AI agent 在用户睡觉期间连续推进，详见
> [`docs/WORK_LOG_post_v0.4.0.md`](docs/WORK_LOG_post_v0.4.0.md)。

## 下一步计划

详细计划见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。简要：

- **M3 收尾**：共现术语推荐（基于 relations + terms 数据）；多解释并存的 UI 专项打磨。
- **AI 加深后续**：针对汉画像石微调 YOLO（"祥瑞 / 礼器 / 车马"等高价值类）；AI 线图扩展 Sobel / HED / Relic2Contour。
- **M4**：多资源版本切换（原图 / RTI / 拓片 / 线图 / 法线图）、IIIF Web Annotation / COCO JSON / `.hpsml` 自定义研究包导出。
- **工程**：Playwright 端到端覆盖（SAM 多 prompt + YOLO + 合并 + 校准 + 关系 + 图谱）；主 chunk 进一步拆分（StoneViewer 也 lazy）到 < 600 KB。
