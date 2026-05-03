# WSC3D v0.2.2 — 标注模块 ICON 化与工程小修

> 发布日期：2026-05-03
> 对应计划：M2，见 [`ROADMAP.md`](ROADMAP.md) 第 1 节
> 思考记录：[`THINKING_m2.md`](THINKING_m2.md)

本次迭代把标注模块从「标签 + 备注」二元结构升级为「结构层级 + 图像志三层
+ 受控术语 + 证据源」四件套，同时补齐导出 IIML、色板自定义两项用户诉求，
并做了代码分割与 Three/Konva 资源回收两项工程小修。

## 标注模块

### 详情面板 ICON 化

- **结构层级下拉**（`structuralLevel`）：whole / scene / figure / component /
  trace / inscription / damage / unknown 八档，IIML schema 原生字段。
- **图像志三层文本**（论文 35 ICON 核心）：
  - `semantics.preIconographic` 前图像志：看得见的对象纯描述（本版新增）；
  - `semantics.iconographicMeaning` 图像志：主题识别；
  - `semantics.iconologicalMeaning` 图像学：文化解释；
  - 三段各自折叠显示，默认展开"图像志"。
- **题刻子面板**：仅当 `structuralLevel === "inscription"` 时出现，
  支持 `transcription / translation / readingNote` 三段。
- **备注** `notes` 继续保留为自由文字，不参与 IIML 语义导出。

### 受控术语多选

- 从 `/api/terms` 拉 `data/terms.json`（5 个分类 / 约 30 条术语）；
- 支持输入检索 + 多选 chip；点 × 移除；
- 右侧 + 按钮支持"自定义术语"，写一个 label 即可入库；
- `IimlTermRef.scheme` 在 M2 固定 `"WSC3D"`，
  `ICONCLASS / AAT / Wikidata` 等外部词表字段在类型上预留，M3 再开界面。

### 证据源数组

- 新增 `annotation.sources[]` 判别联合（discriminated union），支持 4 种 kind：
  - `metadata`：关联结构化档案的层/帧（`layerIndex + panelIndex`）；
  - `reference`：文献引用（`title + uri + citation`）；
  - `resource`：关联 IIML resources（`resourceId`，M2 手填字符串，M4 资源切换时改下拉）；
  - `other`：自由文本兜底。
- `metadata` kind 下拉直接读取 `/api/stones/:id/metadata` 的 `layers` / `panels`。

### 色板自定义

- 列表色块的交互改为两段式：未选中时点击色块 → 选中标注；再次点击 → 弹出色板 popover；
- 详情面板顶部新增色块 + popover，支持 10 个预设色与 HTML5 自定义色选择；
- 防御性拦截 `mousedown` 冒泡，避免色板里的操作触发底层画布的框选。

### 导出 IIML

- 标注状态区右上角新增下载按钮，
  浏览器直接 `Blob + URL.createObjectURL` 下载 `<stoneId>-<yyyymmdd-hhmm>.iiml.json`；
- 下载不影响后端持久化，两者走同一份 `annotationState.doc`。

## 工程小修

- **代码分割**：`AssemblyWorkspace / AssemblyPanel / AnnotationWorkspace /
  AnnotationPanel / AnnotationToolbar` 改为 `React.lazy + <Suspense>` 按模式动态加载。
  实测 bundle（gzip 体积已列出）：
  - 主 `index.js` 844 KB（gzip 234 KB），相较改造前 >1 MB 的主 chunk 直降约 20%；
  - `AnnotationWorkspace` 323 KB（gzip 99.8 KB，含 `react-konva`）；
  - `AssemblyWorkspace` 34.7 KB（gzip 10.2 KB）；
  - `AnnotationPanel` 18.4 KB、`AssemblyPanel` 5.4 KB、`AnnotationToolbar` 2.1 KB。
  未达成 plan 预设的 "主 chunk < 600 KB" 目标，原因是 Three.js + `StoneViewer`
  仍随 viewer 首屏同步加载；若后续愿意接受 viewer 模式 loading 闪烁，可把 StoneViewer
  也改 lazy，能再降约 300 KB。本次保持首屏 viewer 即时可用的体验。
- **Three / Konva 资源回收**：
  - `AnnotationCanvas` 卸载时显式 `stage.destroy()`，作为 react-konva 自身清理的防御性保险；
  - `StoneViewer.disposeObject` 扩展到常用 12 个贴图 slot（`map / normalMap /
    roughnessMap / metalnessMap / emissiveMap / aoMap / alphaMap / bumpMap /
    displacementMap / envMap / lightMap / specularMap`），长时间使用后不再积累显存。

## 数据兼容

- 后端 IIML 校验 `iimlSchema` 保持 `additionalProperties: true`，
  `semantics.preIconographic`、`sources[]` 无破坏性落盘到 `data/iiml/<stoneId>.iiml.json`；
- 旧标注文档自动迁移：旧字段保留，无 `preIconographic` 和 `sources` 视为空值。

## 手动验收

1. **新建标注完整流程**：进入标注模块 → 矩形框选一条 → 选"figure 层级" →
   填 `preIconographic`（可见对象）/ `iconographicMeaning`（主题识别）/
   `iconologicalMeaning`（文化解释）→ 在受控术语搜索 "青龙" 加两条 → 加 1 条
   `metadata` 证据源（选某层/帧）+ 1 条 `reference` 证据源（填 title + citation）→ 刷新 → 回读无误。
2. **题刻条件分支**：把任一标注的 `structuralLevel` 切到 `inscription` →
   确认题刻子面板出现（释文 / 翻译 / 释读注）→ 切回 `figure` → 题刻面板自动折叠。
3. **色板自定义**：点击列表里某条已选中的标注色块 → popover 弹出 →
   点预设色生效 + 用 HTML5 拾色器选自定义色生效；详情面板顶部色块同理。
4. **导出 IIML**：点状态区右上角下载图标 → 浏览器下载 `<stoneId>-<ts>.iiml.json` →
   打开 JSON 看到 `preIconographic` / `sources` / `terms` 三类字段完整。
5. **代码分割**：DevTools Network 打开新标签刷新 → 首屏只拉主 chunk + CSS；
   切到"拼接"模式触发 `AssemblyWorkspace-*.js`；切到"标注"模式触发
   `AnnotationWorkspace-*.js` + `AnnotationPanel-*.js` + `AnnotationToolbar-*.js`。
6. **资源回收**：标注模式停留约 10 min 后切回浏览模式 →
   DevTools Memory → Take snapshot → 比较前后，无明显 Konva Stage / Three.js
   Mesh 残留（仅 React 组件实例差值）。

## 已知限制

- 代码分割主 chunk 仍 > 600 KB，原因是 Three.js + StoneViewer 随 viewer 首屏加载；
- 钢笔工具尚未支持贝塞尔控制柄（M3 及以后）；
- 受控术语的 `ICONCLASS / AAT / Wikidata` 仅在类型层保留 `scheme` 字段，M3 才接入 UI；
- AI 候选流、多解释并存、知识图谱、IIIF/COCO/PNG+Mask 导出均属 M3 / M4 范围；
- 标注画布在窗口大小剧烈变化时偶发 1 帧错位（v0.2.1 已记录）。

## 下一步

下一步规划见 [`THINKING_m2.md`](THINKING_m2.md) 与 [`ROADMAP.md`](ROADMAP.md) 第 2-3 节。

本次 **未自动打 git tag**，等待 QA 验收后由用户确认是否打 `v0.2.2` tag。
