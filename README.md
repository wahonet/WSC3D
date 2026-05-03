# 汉画像石数字化研究平台 (WSC3D)

面向汉画像石数字化研究的本地化工作台，目前提供三大模块：

- **浏览**：单块画像石的 3D / 2D / 正射视图，可切换光照、背景、视角骰子，支持基于结构化尺寸的真实距离测量。
- **拼接**：多块画像石加载至同一拼接场景，提供平移/旋转微调、长边等比缩放、面对面贴合，方案可保存为 JSON。
- **标注**：基于模型空间归一化坐标的 2D 标注画布，标注随相机平移/缩放自动跟随；矩形 / 椭圆 / 点 / 钢笔四种工具，标注本身即是图层（可独立隐藏 / 锁定 / 删除）。

## 快速开始

```bash
npm install
npm run dev
```

启动后访问：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:3100`
- AI 服务（可选）：`http://127.0.0.1:8000`

> AI 服务用 Python + FastAPI 编写在 `ai-service/`，目前接口已就绪但当前界面未启用，详见下方"下一步计划"。

## 常用命令

```bash
npm run scan        # 扫描本地资源、生成缓存
npm run typecheck   # 前后端 TypeScript 类型检查
npm run build       # 构建前后端产物
npm run dev:backend # 仅启动后端
npm run dev:frontend # 仅启动前端
```

## 技术栈

- **前端**：React 19 + Vite + TypeScript，3D 用 Three.js + OrbitControls，2D 标注画布用 react-konva。
- **后端**：Node.js + Express + TypeScript，本地静态托管 GLTF/PNG，IIML 标注文档由 ajv 校验后落盘到 `data/iiml/`。
- **AI 服务**（可选）：Python + FastAPI + Pillow/numpy/OpenCV，预留 SAM、YOLO、Canny 接口。
- **数据格式**：标注采用类 IIML 的 JSON 文档，模型坐标统一在 `modelBox` 归一化的 (u, v) ∈ [0, 1]² 空间。

## 数据资源

启动前请确认本机已具备以下目录（均位于仓库父目录或通过环境变量自定义）：

| 目录 | 内容 | 默认路径 |
| --- | --- | --- |
| 三维模型 | 64+ 个 `.gltf` / `.png` 缩略图 | `./temp` |
| 结构化分档 | 45 份画像石 Markdown 档案 | `./画像石结构化分档` |
| 参考图 | 标注系统设计参考截图 | `./参考图` |
| 术语库 | `data/terms.json`（人物 / 动物 / 器物 / 场景 / 纹饰） | `./data/terms.json` |
| 标注存储 | `data/iiml/<stoneId>.iiml.json` | `./data/iiml/` |

可通过环境变量自定义：`WSC3D_ROOT`、`WSC3D_MODEL_DIR`、`WSC3D_METADATA_DIR`、`WSC3D_REFERENCE_DIR`。

## 主要接口

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

- 默认 2D 视图，标注画布与三维场景共享同一相机投影；用户平移、缩放视图时，所有标注按 `modelBox` 4 角投影实时跟随。
- 工具：选择/移动、矩形（拖动出尺寸）、圆/椭圆（拖动出尺寸）、点、钢笔（多边形，双击或回车闭合）。
- **一标注一图层**：每条标注自带颜色、可见性、锁定状态。锁定后即不可拖动 / 调整尺寸。
- 标注创建后自动选中并进入"草稿"，右侧详情面板提供「确定 / 取消 / 删除」；草稿外的标注也可随时重命名、隐藏、锁定、删除。
- 浏览模式下不再渲染标注，标注内容仅在标注工作区内可见与编辑。
- 标注文档自动保存到 `data/iiml/<stoneId>.iiml.json`，遵守 IIML 约束（ajv 校验）。

## 目录结构

```text
ai-service/        AI 子服务（Python + FastAPI，预留 SAM / YOLO / Canny）
backend/           Node.js 后端（API、目录扫描、IIML 持久化）
frontend/          React + Three.js 前端
  src/modules/viewer/      浏览模块
  src/modules/assembly/    拼接模块
  src/modules/annotation/  标注模块（画布 + 面板 + Store）
  src/modules/shared/      视角骰子等共享组件
data/              术语库、IIML 文档、拼接方案
docs/              技术方案、扫描报告、QA 截图
temp/              本地三维模型源文件（实际项目不入库）
画像石结构化分档/   45 份画像石 Markdown 档案
参考图/            标注系统的 UI 参考截图
```

## 下一步计划

详细计划见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。简要：

- 标注：色板自定义、批量术语绑定、关联到结构化档案的层 / 帧、3D 模式下气泡叠加。
- AI：恢复 SAM 智能分割、YOLO 候选框、Canny 线图三条管线，完善与画布的回写。
- 协作：版本快照、IIML 导出、知识图谱可视化、与拼接方案的交叉引用。
