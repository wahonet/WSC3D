# WSC3D v0.6.0 — M3 收尾 · 学术导出 · 工程瘦身

> 发布日期：2026-05-04
> 对应计划：M3 收尾 + M4 起步（COCO / IIIF 导出）+ 工程闭环
> 上一发布：[`v0.5.0`](RELEASE_NOTES_v0.5.0.md) — 关系网络 · 知识图谱 · 工程闭环

本次发布由 AI agent 在用户睡觉期间连续推进完成。三条线收齐：

1. **关系网络收尾**：知识图谱关系筛选 + Cytoscape layout 切换 + 节点 size 按度数
2. **AI 学术溯源**：SAM / YOLO 调用历史写入 IIML processingRuns；详情面板可折叠
   "AI 处理记录" section 让每条标注都能追溯到模型 / 参数 / 时间
3. **学术导出 + 工程瘦身**：COCO JSON（喂 YOLO/Detectron2 训练）+ IIIF Web
   Annotation（与外部博物馆平台互操作）；StoneViewer 改 lazy 让主 chunk
   从 882 → 477 KB

工作日志与时间线：[`WORK_LOG_post_v0.5.0.md`](WORK_LOG_post_v0.5.0.md)。

---

## 1. 关系网络收尾（B 后续）

### 1.1 知识图谱关系筛选（D1）

KnowledgeGraphView 在 toolbar 与 canvas 之间加一行筛选 chip：

- **类别 chip**：4 组（叙事 / 层级 / 空间 / 解释）
- **来源 chip**：仅显示 doc 中实际出现的 origin（manual / spatial-auto / ai-suggest）
- chip toggle 多选 OR；空集合 = 不过滤；右侧"清除过滤"

行为：被排除的边淡化（`.is-faded` opacity 0.12）而不是隐藏，保持空间布局
稳定，便于回切对比。仅刷 class 不重建图，layout 不抖动。

### 1.2 Cytoscape layout 切换 + 节点 size 按度数（D2）

- **4 种 layout**：cose 力导向 / concentric 同心圆（按度数）/ breadthfirst
  层级树 / grid 栅格
- **大图阈值**：节点数 > 100 默认 grid，避免 cose 卡 1-2s；阈值跨越自动切回
- **节点 size 按度数**：`mapData(degree, 0, 12, 22, 50)`，关系越多节点越大，
  "叙事中心"在视觉上一眼可见
- 切 layout 直接 `cy.layout().run()`，不重建图

`buildLayoutOptions(name)` 把 4 套 layout 配置封装成纯函数，未来加 dagre / klay
只动这一处。

---

## 2. AI 学术溯源（D3 + D4）

### 2.1 processingRuns 数据模型

新增 `IimlProcessingRun` 类型：

```ts
type IimlProcessingRun = {
  id: string;
  method: "sam" | "yolo" | "canny" | "sam-merge" | string;
  model: string;
  modelVersion?: string;
  input?: Record<string, unknown>;       // prompt 摘要
  output?: Record<string, unknown>;      // ok / detectionsCount
  confidence?: number;
  resultAnnotationIds?: string[];        // 直接产出的 annotation id
  resourceId?: string;
  frame?: "image" | "model";
  startedAt: string;
  endedAt?: string;
  warning?: string;
  error?: string;
};
```

`IimlDocument.processingRuns` 类型从 `Record<string, unknown>[]` 收紧到该类型。
reducer 加 `add-processing-run`，走 updateDoc 进 undo 栈。

### 2.2 写入路径

- **SAM**：`AnnotationCanvas.submitSamPrompts` 在 finally 里追加一条记录，
  含 prompt 摘要（正点数 / 负点数 / hasBox / sourceMode / path）+ confidence
  + resultAnnotationIds，失败也报（error 字段）
- **YOLO**：`App.handleSubmitYoloScan` finally 同样追加，含
  resultAnnotationIds 和 detection 数；no-detection 用 warning 标，真异常用 error
- **prompt 摘要不存全部坐标**：避免 IIML 文档膨胀；坐标已在
  `annotation.generation.prompt` 完整保留

### 2.3 AI 处理记录 section

`ProcessingRunsList` 组件挂在 EditTab 末尾、删除按钮之上，可折叠展示：

- 选中 annotation 时只列"产生过该标注的 run"，按 endedAt 降序
- 每条 run 显示：method 徽章 + model 等宽字体 + 相对时间 + 置信度 + 输入摘要
  + 产出 chip（点击跳转到对应标注）+ warning / error
- 失败 / 无产出 run 浅红条 + 错误文本

意义：研究档案可追溯到具体模型 + 参数 + 时间 + 输出。论文 24/25/26/34 都
强调 AI 候选必须可追溯。

---

## 3. 学术导出（D7 + D8）

### 3.1 COCO JSON（D7）

`exportToCoco(doc, opts)` 输出标准 COCO 数据集：

- **images**：每文档当 1 张图，width/height 从 `stone.metadata.dimensions` 推断
- **annotations**：
  - BBox → `bbox=[x, y, w, h]` 像素 + `area = w*h`
  - Polygon → `segmentation=[[x1, y1, x2, y2, ...]]` + 外接 bbox + shoelace 算 area
  - Point / LineString 跳过（COCO 不支持）
- **categories**：8 档 `structuralLevel` 各一类
- **扩展字段** `iiml_id` / `iiml_label`：保留 IIML 标注 id 供回溯，不破坏 COCO 兼容

ListTab 下载区加 "COCO" 按钮；输出 `<stoneId>-<ts>.coco.json`。

意义：标注数据直接喂 YOLOv8 / Detectron2 训练，是后续"YOLO 微调汉画像石
专用模型"的输入（论文 24 路径）。

### 3.2 IIIF Web Annotation（D8）

`exportToIiifAnnotationPage(doc, opts)` 输出 W3C Web Annotation Data Model：

- **AnnotationPage** 含 N 个 Annotation
- **target selector**：
  - BBox → `FragmentSelector#xywh=...`
  - Polygon → `SvgSelector` + svg path（M / L 段）
  - Point → 8x8 FragmentSelector
- **body**：按 purpose 拆分
  - `tagging`：label / terms
  - `describing`：preIconographic
  - `identifying`：iconographicMeaning
  - `classifying`：iconologicalMeaning
  - `transcribing`：题刻 transcription
- **motivation**：inscription level → `transcribing`，其它 → `tagging`
- **generator**：标记 WSC3D + 标注的 `method/model`，SAM/YOLO 来源可追溯

`canvasId` 字段占位 `urn:wsc3d:{stoneId}:canvas`，用户上传外部平台前可手工
替换为真实 IIIF Canvas URL。

ListTab 下载区加 "IIIF" 按钮；输出 `<stoneId>-<ts>.iiif.json`。

意义：与外部博物馆 / 文物平台互操作（IIIF Presentation API v3 兼容）。

---

## 4. 共现术语推荐（D6）

新增 `cooccurrence.ts · recommendCooccurringTerms`：

- 扫所有 `annotation.semantics.terms` 构建 term ↔ term 共现矩阵
- 当前已有 `termIds = T`：`candidateScore[t] = sum_{s∈T} cooc[s][t]`
- 取 top 5
- 当前无 terms 时退化为"按全局频次"推荐
- 含 terms 标注 < 5 时返回空（避免噪声推荐）

`TermPicker` 在 search input 下方加 chip 行 "建议 [chip1] [chip2] ..."；
点击直接 `pickExisting`（与正常选取同一路径）。query 非空时隐藏。

意义：标注完"西王母"后自动推荐"玉兔 / 九尾狐 / 三足乌"等共现术语，提升
标注效率（论文 35 ICON 提示的"共现叙事"自动化）。

---

## 5. 工程瘦身（D5）

### 5.1 StoneViewer lazy

`App.tsx` 把 `StoneViewer` 改 `import type` + `lazy(() => ...)`，viewer
模式下包 Suspense。

构建实测（gzip 体积）：

| chunk | 之前 | 现在 |
|---|---|---|
| **index.js** | 882 KB (234 gzip) | **477 KB (144 gzip)** |
| StoneViewer | - | 10 KB (4 gzip) |
| ViewCube | - | 404 KB (103 gzip)（含 Three / Orbit / GLTF） |
| AnnotationPanel | 23 KB | 485 KB (155 gzip)（含 cytoscape） |
| AnnotationWorkspace | 336 KB | 346 KB |

主 chunk 减小 46%，达成 v0.4.0 release notes 已知限制 #5（< 600 KB）。

AnnotationPanel 涨是 D2 cytoscape ~150 KB 的代价，但它本身仍 lazy 不影响
首屏。首次进 viewer / annotation / assembly 任一模式仍需 ~500 KB 加载（带
StoneViewer + Three.js），可以接受 1-2s loading 闪烁换主 chunk 显著瘦身。

---

## 6. commit 时间线

```
5ce94c7 docs(work-log): D7+D8 完成 — COCO / IIIF 导出
d6685c3 feat(annotation): D7 + D8 COCO JSON / IIIF Web Annotation 导出
e51f7d5 docs(work-log): D6 完成 — 共现术语推荐
411ef5a feat(annotation): D6 共现术语推荐（基于已有标注 terms 统计）
3cabbda docs(work-log): D5 完成 — 主 chunk < 600 KB
585d46a perf(app): D5 StoneViewer 改 lazy 加载，主 chunk 从 882 KB 降到 477 KB
c0ec6db docs(work-log): D4 完成 — AI 处理记录 section
9c180aa feat(annotation): D4 AI 处理记录 section（详情面板可折叠展示）
d85163f docs(work-log): D3 完成 — processingRuns 写入
b2b2808 feat(annotation): D3 SAM / YOLO processingRuns 写入 IIML（学术溯源）
e541f3e docs(work-log): D2 完成 — 图谱 layout + 节点尺寸
61c4f60 feat(annotation): D2 知识图谱 layout 切换 + 节点 size 按度数
fcc0f73 docs(work-log): D1 完成 — 知识图谱关系筛选
c35c5c1 feat(annotation): D1 知识图谱关系筛选 / 高亮（kind + origin chip）
```

---

## 7. 数据兼容

- 历史 IIML 文档没 `processingRuns` 字段：按 `[]` 处理；新调用 SAM / YOLO 才写入
- 老 `processingRuns` 是 `Record<string, unknown>[]`：`getProcessingRuns(doc)` 防御过滤掉缺关键字段的条目
- 新增字段（cytoscape layout 状态 / 类别筛选 / 共现推荐）都仅是前端 UI 状态，
  不进 IIML doc

---

## 8. 验收要点

进标注模式后依次试：

1. **知识图谱筛选**：图谱 tab → toolbar 下方一行 chip → 点 "叙事" → 只剩
   叙事关系亮色，其它淡化；点 "清除过滤" 恢复
2. **图谱 layout**：图谱 tab → 下一行 chip "布局：力导向 / 同心圆 / 层级树
   / 栅格" → 点切换 → layout 立即变化；> 100 节点时默认 grid
3. **节点尺寸**：图谱中关系最多的"中心"标注节点明显比叶子节点大
4. **AI 处理记录**：选某 SAM 候选 → EditTab 末尾 "AI 处理记录" 折叠条 →
   展开应见到该候选的 SAM run（model / 时间 / 正点数等）
5. **共现推荐**：先标注 5+ 个含 terms 的标注 → 选某新标注 → terms 输入框
   下方应有 "建议" chip 行
6. **COCO 导出**：列表 tab 下载区 → 点 COCO → 下载
   `<stoneId>-<ts>.coco.json` → 打开看 categories / annotations 结构正确
7. **IIIF 导出**：同 6，点 IIIF → 下载 `.iiif.json` → 看 AnnotationPage
   结构 + body purpose / motivation 正确
8. **lazy 加载**：DevTools Network → 刷新 → 主 chunk index 应 ~140 KB gzip；
  首次进 viewer / annotation 模式时再加载 StoneViewer / ViewCube chunk

---

## 9. 已知限制

- 本次发布全部由 AI agent 自行推进，所有功能已经过 typecheck，但 **未做
  浏览器端到端测试**
- 共现推荐当前只看 term ↔ term，不看"距离 / 关系" 增强；下个版本可考虑
  纳入 spatial relations 加权
- COCO 导出 imageSize 用 `stone.metadata.dimensions`（cm 单位）当像素，
  实际 ML 训练时一般要重新校对到真实图像分辨率；用户应在导出后手工调整
  images.width/height
- IIIF canvasId 占位 `urn:wsc3d:...`，上传外部平台前需替换为真实 IIIF
  Canvas URL
- ViewCube chunk 404 KB（含 Three.js）首次进任一 3D 模式都要加载，无法进
  一步拆；要降只能换 webgl 库（不现实）

---

## 10. 下一步

详细规划见 [`ROADMAP.md`](ROADMAP.md)。简要：

- **M3 完结**：多解释并存 UI 专项打磨（alternativeInterpretationOf 已支持
  字段，但缺"多视角对比" 展示）
- **M4 推进**：多资源版本切换（原图 / RTI / 拓片 / 线图 / 法线图）+
  `coordinateSystem.transform` 跨版本变换；`.hpsml` 自定义研究包导出
- **AI 加深**：用现有 COCO 导出 + 1000+ 标注积累后微调汉画像石专用 YOLO；
  AI 线图扩展 Sobel / HED / Relic2Contour
- **工程**：Playwright 端到端覆盖（需要稳定 dev 环境）

本次 **未自动打 git tag**，等待用户验收后决定是否打 `v0.6.0` tag。
