# 下一步工作计划

> 当前版本：`v0.8.0` —— 在 v0.7.0 基础上：
> ① 图谱 UI 修缮（chip 行 4 → 2；PageRank 中文化"权威度"；排行榜从侧栏挪到 canvas 下方横向滚动）；
> ② "资源"独立 tab + 从三维模型一键生成正射图（offscreen Three.js 渲染 + 后端落盘 + 自动关联 IIML resources）；
> ③ M4 多资源架构落地（多资源画布切换 SourceImageView `imageUrl?` / 跨资源坐标变换数据模型 `IimlResourceTransform` / .hpsml 解包导入 backend services）。
>
> **下一阶段：M5（v0.9 / v0.10 / v0.11 / v1.0，12 个月）—— 领域数据集 + RTI 完整管线 +
> 跨石头知识库 → 公开数据集 release**。详细论证见 [`THINKING_m5.md`](THINKING_m5.md)，
> 战略章节见下文 §3.5。
>
> 本文档按"近期 → 中期 → 远期"列出下一步要做的工作。

---

## 0. 当前已交付（截至 v0.8.0）

### 浏览模块

- 3D / 2D / 正射，视角骰子，测距（按结构化尺寸自动 cm 校准），背景与光照分档切换。

### 拼接模块

- 最多 10 块同时加载、平移 / 旋转微调（1/5/10 cm 步长，5° / 任意角度）、长边等比缩放、面对面贴合。
- 方案 JSON 持久化（`data/assembly-plans/`）+ 重命名 / 重新加载。
- 多石场景下 gizmo 拖动正常（v0.2.1 修复），新加石头不重置相机。

### 标注模块

#### 双源底图（v0.3.0 新增）

- 工作区右上角 segmented 切换 **3D 模型 / 高清图**。
- **3D 模型**：modelBox UV `(u, v) ∈ [0, 1]²`；OrbitControls 处理视图变换。
- **高清图**：`<img>` + 自维护 ViewState（scale / offsetX / offsetY），滚轮 / 中键 / 右键自带 pan + zoom。后端 `/ai/source-image/{stone_id}` 把 tif 缩放到长边 4096 LANCZOS 后落盘缓存为 PNG。
- 两种模式下鼠标交互一致：滚轮缩放 + 中键 / 右键拖动平移。

#### 工具

- 选择 / 矩形 / 圆 - 椭圆 / 点 / 钢笔（双击或回车闭合）
- **SAM 多 prompt 智能分割**（v0.4.0 升级）：左键正点 / 右键负点 / Shift+左键拖框 → Enter 提交一次推理；MobileSAM ViT-T；高清图直读 + 截图 fallback。
- **YOLO 批量扫描**（v0.4.0 新增）：工具栏 Radar 按钮 + 设置 dialog（类别过滤 / 置信度阈值 / 最大检测数）；YOLOv8n COCO 通用模型；落入候选 tab。
- **AI Canny 线图**（v0.4.0 新增）：高清图模式下 mini segmented 切 "+线图"；后端 OpenCV Canny + 落盘缓存 + 前端半透明叠加。
- **对齐校准**（v0.3.0 新增）：工具栏 `Crosshair` 按钮，"乒乓式" 4 对点采集，标定结果写入 `culturalObject.alignment`。

#### 数据模型（IIML / ICON 三层 + 双坐标系）

- **IIML 文档**：`@context / culturalObject / resources / annotations / relations / processingRuns / provenance`（ajv 校验后落盘到 `data/iiml/<stoneId>.iiml.json`）。
- **结构层级**：whole / scene / figure / component / trace / inscription / damage / unknown。
- **图像志三层**：`semantics.preIconographic / iconographicMeaning / iconologicalMeaning`，论文 35 ICON 核心。
- **题刻条件子面板**：`structuralLevel === "inscription"` 时出现，三段（释文 / 翻译 / 释读注）。
- **受控术语**：M2 阶段用本地 `WSC3D` 词表，scheme 字段预留 `ICONCLASS / AAT / Wikidata`。
- **证据源数组**：`metadata`（archive 层 / 帧）/ `reference`（文献）/ `resource`（IIML resources）/ `other`（自由文本）。
- **审定状态**：`reviewStatus: candidate / reviewed / approved / rejected`，仅在 AI 候选 / 合并场景显示。
- **frame 字段**（v0.3.0 新增）：每条标注标记 `image | model`，跨 frame 显示通过 4 点单应性矩阵投影。
- **alignment 字段**（v0.3.0 新增）：`culturalObject.alignment.controlPoints[]` 持久化 4 对对应点。

#### 候选闭环（v0.3.0 新增）

- 候选 tab + 列表 tab 都支持 checkbox 多选 + "合并选中"按钮。
- `polygon-clipping` 做几何并集，只保留每个 polygon 的外环（丢孔洞），符合"只保留最外面的边缘"。
- 合并产物的 reviewStatus 智能继承：任一源是候选 → 候选；否则跟随第一个源（避免已 approved 标注被打回未审）。

#### 关系网络（v0.5.0 新增）

- **标注间关系**：IimlRelation { kind, source, target, origin, note }；
  受控 14 种 kind / 4 组（叙事 / 层级 / 空间 / 解释）；origin 区分 manual /
  spatial-auto / ai-suggest。
- **RelationsEditor**：详情面板末尾 inline 表单创建关系；显示作为 source / target
  的关系列表；支持单条删除与跳转。
- **空间关系自动推导**：纯运行时算 above/below/leftOf/rightOf/overlaps/nextTo；
  不入库；用户"采纳"才升 manual。
- **画布关联连线**：选中标注时 manual 实线 + auto 虚线连到所有相关标注。
- **知识图谱 tab**：Cytoscape.js 节点 / 边图；与画布双向联动。

#### 工程闭环（v0.5.0 新增）

- 键盘快捷键：V/R/E/N/P/S/F + Ctrl+Z/Y。
- 候选 tab 类别 chip 过滤。
- 头部画像石下拉显示 alignment 状态（"✓ " 前缀）。

#### M3 收尾（v0.6.0 新增）

- **知识图谱关系筛选**：kind chip（4 组）+ origin chip（仅显示出现的）；
  toggle 多选 OR；被排除的边淡化（`.is-faded` opacity 0.12）不重建图。
- **Cytoscape 大图性能**：4 layout 切换（cose / concentric / breadthfirst /
  grid）；> 100 节点默认 grid；节点 size 按 degree 动态映射。
- **SAM / YOLO processingRuns 写入 IIML**：每次 AI 调用追加一条
  `IimlProcessingRun` 含 method / model / input 摘要 / output /
  resultAnnotationIds / startedAt / endedAt / warning / error。
- **AI 处理记录 section**：`ProcessingRunsList` 折叠展示选中标注的全部
  AI 调用历史；点产出 chip 跳转到对应标注。
- **共现术语推荐**：`cooccurrence.ts` 算 term ↔ term 共现矩阵；TermPicker
  在搜索框下方加 chip 行；含 terms 标注 < 5 时静默不显示。

#### 学术导出（v0.6.0 新增）

- **COCO JSON**：`exporters.exportToCoco` 标准 COCO 数据集；BBox/Polygon
  转 segmentation；structuralLevel 作为 categories；扩展字段 iiml_id /
  iiml_label 保留 IIML 链路。
- **IIIF Web Annotation**：`exporters.exportToIiifAnnotationPage` W3C
  Web Annotation Data Model；BBox→FragmentSelector / Polygon→SvgSelector；
  body 按 purpose 拆分（tagging / describing / identifying / classifying
  / transcribing）；motivation 区分 inscription。

#### 工程瘦身（v0.6.0 新增）

- StoneViewer lazy → 主 chunk 882 KB → 477 KB（gzip 234 → 144 KB），减少 46%。

#### 图谱 UI 修缮 + 资源独立 tab + 正射图生成（v0.8.0 新增）

- **图谱 UI 修缮**（v0.8.0 H1）：chip 行 4 → 2；中心性算法中文化
  （权威度 / 邻居数 / 桥梁度 / 接近度）；排行榜从右侧 230px 侧栏挪到 canvas
  下方横向滚动；canvas 占整行 min-height 380px；群组规模 chip 并入 head
- **资源独立 tab**（v0.8.0 H2）：AnnotationPanel TabKey 加 "resources"；原
  嵌在 ListTab 的 ResourcesEditor 移到独立 tab 下；卡片显示 160px max-height
  缩略图；分 3 个 section（生成正射 / IIML 条目 / 后端已落盘）
- **从三维模型生成正射图**（v0.8.0 H3）：`frontend/src/modules/annotation/orthophoto.ts`
  独立 offscreen Three.js 渲染器；4 视图方向（front/back/top/bottom）；
  OrthographicCamera frustum 裹 AABB + 5% 留白；AmbientLight 0.75 +
  DirectionalLight 1.0 斜上 45° 单灯；PNG blob 3072px 长边
- **后端资源落盘端点**（v0.8.0 H3）：`POST/GET /api/stones/:id/resources`
  落盘到 `data/stone-resources/{stoneId}/{type}-{timestamp}.png`；静态托管
  `/assets/stone-resources/`

#### 多资源架构（v0.8.0 M4 落地）

- **多资源画布切换**（v0.8.0 I1）：SourceImageView 新增 `imageUrl?` prop
  覆写默认 pic/ 原图；AnnotationWorkspace 新增 activeImageResourceId 状态 +
  资源切换 segmented UI；切非 pic/ 资源时禁用 Canny 叠加
- **跨资源坐标变换（数据模型）**（v0.8.0 I2）：IimlResourceTransform 联合类型
  （orthographic-from-model / homography-4pt / affine-matrix 3 种 kind）；
  IimlResourceEntry.transform 可选字段；正射图生成时自动填入
  `{ kind: "orthographic-from-model", view, modelAABB, pixelSize, frustumScale }`；
  ResourcesEditor 卡片显示金绿色提示条。**画布投影实装留 v0.9.0**
- **.hpsml 解包导入**（v0.8.0 I3）：`backend/src/services/hpsml.ts` 新增
  `importHpsmlPackage`；校验 format/formatVersion；解 stoneId（options >
  context.stone.id > iiml.documentId 前缀）；IIML 走 saveIimlDoc 完整 ajv 校验；
  拼接方案导入 `data/assembly-plans/`；conflictStrategy overwrite/skip；
  `POST /api/hpsml/import?stoneId=...&conflict=...`；前端 ListTab 下载区
  加"导入 .hpsml"按钮，导入后若是当前 stoneId 自动刷新画布

#### 紧急修复 + 图谱完善（v0.7.0 新增）

- **保存按钮 dirty 状态**：textarea / input onChange 直接 markDirty，按钮在
  滚动后仍亮；`.edit-actions` sticky bottom 始终可见
- **YOLO 检测优化**：CLAHE 自适应直方图增强 + 原图 + 增强图双跑 + IoU 0.55
  去重；默认 conf 0.10、不过滤类别；response 加 debug 字段（rawDetections /
  classDistribution / filteredByClass / filteredByConf）；前端按 debug 给精确
  原因
- **知识图谱中心识别**：4 种中心性算法（PageRank / Degree / Betweenness /
  Closeness）；MCL 群组检测；top-N 节点金色光环 + ★；着色 3 模式（按层级 /
  按群组 / 按中心度）；侧栏排行榜（top-8 + 群组色点 + 进度条）；群组聚拢布局

#### AI 加深（v0.7.0 新增）

- **5 种线图算法**：canny / canny-plus（默认，Canny + 形态学闭运算）/ sobel /
  scharr / morph（自适应阈值 + 形态学）；前端线图参数面板可切换 + 阈值滑杆 +
  透明度
- **SAM 自动 prompt**：`refineBBoxWithSam` 把 YOLO bbox 喂给 SAM 跑精修；单条
  + 批量两路径；保留 label / 颜色等用户字段，写一条 method=sam-refine 的
  processingRun
- **多解释并存 UI**：`AlternativeInterpretationsView` 检测 alternativeInterpretationOf
  关系（双向），并排对比卡片（标签 / 三层语义 / 来源 / 置信度 / 证据数）

#### M3 收尾 + M4 起步（v0.7.0 新增）

- **批量任务进度面板**：`TaskProgressPanel` 右下角浮窗 + status running/done/
  failed/cancelled + 进度条 + 取消按钮；SAM 批量精修走该队列可中途取消
- **多资源版本管理**：`ResourcesEditor` 列出 doc.resources，支持添加 8 种类型
  （Mesh3D / OriginalImage / Rubbing / NormalMap / LineDrawing / RTI /
  PointCloud / Other）+ URI + 描述
- **.hpsml 自定义研究包导出**：`exportToHpsml` 把 IIML + 关系网络 + 拼接方案 +
  词表快照 + stone metadata 打成单 JSON；context.networkStats 含
  annotationCount / relationCount / processingRunCount / relationKindBreakdown

### AI 子服务（FastAPI）

- `/ai/health`：服务健康检查 + SAM 加载状态轮询（pending / downloading / loading / ready / error）。
- `/ai/sam`：MobileSAM ViT-T 推理；多 prompt（正点 / 负点 / box 一次提交）；`imageBase64` 截图路径与 `stoneId` 高清图路径。
- `/ai/yolo`（v0.4.0 实装）：YOLOv8n COCO 推理；`stoneId` / `imageBase64` 双路径；返回 bbox（带 `bbox_uv` image-normalized 与 SAM polygon 同约定）。
- `/ai/source-image/{stone_id}`（v0.3.0 新增）：tif → PNG 转码 + 落盘缓存（`max_edge` 可调，默认 4096）。
- `/ai/lineart/{stone_id}`（v0.4.0 新增 / v0.7.0 扩展）：5 种算法（canny / canny-plus / sobel / scharr / morph），落盘缓存 `cache/lineart/`，按 method 前缀分别缓存。
- `/ai/lineart/methods`（v0.7.0 新增）：返回支持的算法列表。
- `/ai/canny`：旧 base64 路径，保留兼容。

---

## 1. M2 完成清单（已交付）

> 详见 [`RELEASE_NOTES_v0.2.2.md`](RELEASE_NOTES_v0.2.2.md) 与 [`THINKING_m2.md`](THINKING_m2.md)。

### 1.1 标注详情面板 ICON 化

- [x] **A. 色板自定义**：列表色块 popover，10 个推荐色 + HTML5 拾色器。
- [x] **G. 结构层级下拉**：8 档枚举，IIML schema 原生字段。
- [x] **H. 图像志三层文本**：preIconographic / iconographicMeaning / iconologicalMeaning + notes 备注（自由文字、不参与 IIML 语义导出）。
- [x] **B. 受控术语多选**：`/api/terms` 检索 + chip 多选 + 自定义术语；scheme 字段预留外部词表。
- [x] **C. 证据源数组**：4 种 kind 判别联合；`metadata` kind 直接读取 `/api/stones/:id/metadata` 的 layers / panels。
- [x] **D. 导出 IIML**：状态区右上角下载按钮，浏览器 `Blob + URL.createObjectURL` 一键下载。

### 1.2 工程小修

- [x] **代码分割**：`AssemblyWorkspace / AssemblyPanel / AnnotationWorkspace / AnnotationPanel / AnnotationToolbar` 改为 `React.lazy + <Suspense>`；主 chunk 从 > 1MB 降到 ~ 800KB（gzip ~245KB）。
- [x] **资源回收**：AnnotationCanvas 卸载时显式 `stage.destroy()`；StoneViewer 的 disposeMaterial 扩展 12 个贴图 slot。

---

## 2. M3 — AI 标注接入与多解释（v0.3.0 / v0.4.0 已完成 SAM 与 YOLO，关系图谱进行中）

### 2.1 SAM 智能分割（已完成 v0.3.0 + v0.4.0）

- [x] **阶段 1**：MobileSAM ViT-T 启动时自动从 GitHub 拉取权重（`weights/mobile_sam.pt`）；单点 prompt；OpenCV Canny fallback。
- [x] **阶段 2**：高清图直读路径（`stoneId` + 后端 PIL 解码 + tif→PNG 转码缓存）；前后端 v 轴方向统一；多 mask 候选启发式（丢面积 > 50% 的"场景级"大块、必须包含 prompt 点、选最紧凑那个）。
- [x] **候选合并**（polygon union）：候选 / 列表两个 tab 都支持。
- [x] **阶段 3**：多 prompt 点累积（含负点）+ box prompt；prompt 元数据记录在 `generation.prompt`，已为 IIML `processingRuns[]` 做好准备。
- [ ] **阶段 4（待）**：把每次 SAM 调用作为一条独立 record 写入 `processingRuns[]`（model / version / parameters / timestamp / 输入 prompt / 输出 mask 区域），便于研究溯源。

### 2.2 多源底图与对齐校准（已完成 v0.3.0）

- [x] **3D 模型 / 高清图**双底图切换。
- [x] **4 点单应性对齐校准**：`culturalObject.alignment` + 跨 frame 标注按 H 矩阵投影显示。
- [ ] **更精细的对齐**：4 点扩展到 N 点（≥ 4），用 SVD 而不是 8 元 DLT 求解，提升标定精度；当前 4 点对小型不规则画像石已足够。
- [ ] **跨 frame 标注就地编辑**：当前跨 frame 标注只能查看，需要切回原 frame 编辑。如确有研究流程上的需要（如在 3D 上拖动一个图坐标系标注），再加反向投影路径。

### 2.3 YOLO 候选检测（v0.4.0 第一阶段 + v0.7.0 增强）

- [x] **批量审阅流程**：工具栏 Radar 触发；扫描 → bbox 落入候选 tab → 用 SAM 二次精修。
- [x] **类别过滤 + 置信度阈值**：YoloScanDialog 提供 `classFilter` chip 多选 + 阈值滑杆 + 最大检测数。
- [x] **通用 COCO 模型起点**（v0.4.0 默认勾选 30 类，v0.7.0 改为默认不过滤让真实输出可见）。
- [x] **CLAHE 双跑 + 精确 debug 提示**（v0.7.0 E3）：原图 + CLAHE 增强图双跑按 IoU 去重；response 加 rawDetections / classDistribution / filteredByClass / filteredByConf；前端按 debug 给精确原因。
- [x] **SAM 自动 prompt：YOLO bbox → polygon**（v0.7.0 F3）：单条 + 批量两路径；保留用户字段；写一条 method=sam-refine 的 processingRun。
- [ ] **微调汉画像石专用模型**：YOLOv8 在标注积累足够后微调，识别祥瑞 / 礼器 / 车马 / 建筑等高价值类（论文 24 提示）。需要先用现有手工 + 半自动标注积累 ~1000 个 bbox 训练集；v0.7.0 的 SAM 批量精修 + COCO 导出可加速积累。
- [x] **候选 tab 类别筛选**（v0.5.0 C6 已实装）。

### 2.4 AI 线图（v0.4.0 第一阶段 + v0.7.0 扩展）

- [x] **Canny 线图叠加层**：在高清图模式下半透明叠加，辨识浅浮雕轮廓；后端落盘缓存 + 前端 mini segmented 切换。
- [x] **5 种线图算法**（v0.7.0 F2）：canny / canny-plus（默认，Canny + 形态学闭运算）/ sobel / scharr / morph（自适应阈值 + 形态学）；前端线图参数面板 method chip + low/high + 透明度滑杆。
- [ ] **HED 等深度学习线图**：`/ai/lineart?method=hed` 待加 holistically-nested edge detection 模型。
- [ ] **Relic2Contour / 论文 25**：等其变成成熟开源模型后接入；当前先占位。
- [ ] **风格化线图严格审核**（论文 34 LoRA 扩散）：所有 AI 生成的线图标记为 candidate，必须人工确认才进入 IIML（当前线图是纯算法不写库，不需要审核流程）。

### 2.5 多解释并存与标注间关系（v0.5.0 + v0.6.0 完成大半）

- [x] **叙事 / 层级关系**：14 种受控谓词（holds / rides / attacks / faces /
  partOf / contains / nextTo / above / below / leftOf / rightOf / overlaps /
  alternativeInterpretationOf / manual）；RelationsEditor inline 表单创建。
- [x] **空间关系自动推导**：deriveSpatialRelations 按几何推导 6 种空间关系；
  不入库，"采纳"才升级为 manual。
- [x] **画布关联连线**：选中标注时画 manual 实线 + auto 虚线连到所有相关。
- [x] **关系筛选 / 高亮**（v0.6.0 D1）：知识图谱 kind chip + origin chip
  toggle；被排除的边淡化不隐藏。
- [x] **多解释并存 UI**（v0.7.0 F1）：AlternativeInterpretationsView 检测
  alternativeInterpretationOf 关系（双向），并排对比卡片（标签 / 三层语义 /
  来源 / 置信度 / 证据数）。

### 2.6 知识图谱可视化（v0.5.0 + v0.6.0 + v0.7.0 完成）

- [x] **Cytoscape 节点 / 边图**：标注按 structuralLevel 着色，关系按 4 组着色。
- [x] **双向联动**：图上点节点 → 画布选中；画布选中 → 图上节点高亮 + 关联
  边高亮。
- [x] **大图性能**（v0.6.0 D2）：4 layout 切换 + > 100 节点默认 grid +
  节点 size 按 degree 动态映射。
- [x] **共现推荐**（v0.6.0 D6）：基于 annotation.terms 共现矩阵推荐 top 5；
  含 terms 标注 < 5 时静默。
- [x] **中心节点识别 + 群组检测 + 排行榜**（v0.7.0 E4）：4 种中心性算法
  （PageRank / Degree / Betweenness / Closeness）+ MCL 群组检测 + top-N 节点
  金色光环 + 着色 3 模式（按层级 / 按群组 / 按中心度）+ 群组聚拢布局 +
  侧栏排行榜。
- [ ] **更智能的推荐**：当前共现只看 term ↔ term，不看距离 / 关系加权；
  下个版本可纳入 spatial / narrative relations 加权 + 群组成员加权。

### 2.7 学术溯源（v0.6.0 + v0.7.0）

- [x] **processingRuns 写入 IIML**：SAM / YOLO 每次调用追加一条记录，含
  method / model / input 摘要 / output / resultAnnotationIds / 时间 / 错误。
- [x] **AI 处理记录 section**：详情面板可折叠展示选中标注的全部 AI 调用历史。
- [x] **SAM 精修溯源**（v0.7.0 F3）：method=sam-refine 的 processingRun 记录
  upstream annotation id + 原 method + 原 box，链路清晰。
- [ ] **多用户协作 provenance**：当前 createdBy 写死 local-user；多用户
  环境需要登录态 + IIML provenance 字段完整化。

### 2.8 学术导出（v0.6.0 + v0.7.0 完成）

- [x] **COCO JSON**：BBox / Polygon → segmentation + categories（按
  structuralLevel）+ iiml_id 扩展字段保留链路。
- [x] **IIIF Web Annotation**：W3C Web Annotation Data Model；BBox →
  FragmentSelector，Polygon → SvgSelector；body 按 purpose 拆分；motivation
  区分 inscription。
- [x] **`.hpsml` 自定义研究包**（v0.7.0 G2）：format/iiml/context 三层结构；
  IIML 全文 + 拼接方案 + 词表快照 + stone metadata + networkStats；
  解包拆 iiml 字段就是标准 IIML 文档。
- [ ] **.hpsml 解包 / 导入**：backend services 加 hpsml.ts 实装解包 → 导入
  IIML / 拼接方案 / 词表，跨机器协作。

### 2.9 批量任务管理（v0.7.0 G3）

- [x] **任务进度面板**：右下角浮窗 + status running/done/failed/cancelled +
  进度条 + 取消按钮；SAM 批量精修走该队列可中途取消。
- [ ] **多石头并发 YOLO**：当前 YOLO 单 stone 触发；批量"扫所有石头"留
  v0.8.0 做，需要并发控制 + 进度面板支持多任务并行。

### 2.7 类 Git 版本管理（可选，待评估）

- [ ] 标注每次保存形成快照（hash + 作者 + 备注），存入 `data/iiml-history/`。
- [ ] 历史 tab 列出快照，支持回滚 / 查看 diff。

> 是否需要版本管理取决于实际研究流程，待用户判断后再排期。

---

## 3. M4 — 多源资源与导出

### 3.1 多源资源版本切换（v0.7.0 元数据层 + v0.8.0 画布切换 + 坐标变换数据模型）

- [x] **一对象多资源**（v0.7.0 G1）：同一 `culturalObject` 下挂多份 `resources`
  （Mesh3D / OriginalImage / Orthophoto / Rubbing / NormalMap / LineDrawing /
  RTI / PointCloud / Other）；ResourcesEditor UI 可管。
- [x] **画布资源切换 UI**（v0.8.0 I1）：SourceImageView 新增 imageUrl? prop；
  AnnotationWorkspace 新增 activeImageResourceId 状态 + segmented 切换；
  切非 pic/ 资源时禁用 Canny 叠加。
- [x] **从三维模型生成正射图**（v0.8.0 H3）：offscreen Three.js 渲染器；
  4 视图方向；后端落盘 + 自动关联 IIML resources。
- [x] **跨版本坐标变换数据模型**（v0.8.0 I2）：IimlResourceTransform 联合类型
  （orthographic-from-model / homography-4pt / affine-matrix）；正射图生成时
  自动填入变换元数据。
- [ ] **跨版本坐标变换 画布投影实装**（v0.9.0）：读 `resource.transform` 自动
  把 model-frame 标注投影到正射图坐标系显示，投影失败时 fallback 隐藏。
- [x] **资源元数据**（v0.7.0 G1）：description / acquisition / acquiredBy /
  acquiredAt 字段，便于研究溯源。

### 3.2 导出格式扩展（v0.6.0 + v0.7.0 完成 4 种）

- [x] **IIIF Web Annotation**：v0.6.0 实装。
- [x] **COCO JSON**：v0.6.0 实装。
- [x] **`.hpsml` 自定义研究包**：v0.7.0 G2 实装（format/iiml/context 三层）。
- [ ] **PNG + Mask**：原图 + 分割 mask，用于语义分割训练（CV 训练流派备选）。

### 3.3 数据交换与协作

- [ ] **导入 / 合并外部 IIML**：检测同 ID 标注差异，UI 展示三方合并。
- [x] **.hpsml 解包 / 导入**（v0.8.0 I3）：backend/src/services/hpsml.ts +
  POST /api/hpsml/import；前端 AnnotationPanel ListTab 加"导入 .hpsml"按钮；
  支持 overwrite / skip 冲突策略。
- [ ] **.hpsml 三方合并**（v0.9.0）：两个 .hpsml 里同 id 标注差异时 UI 显示
  三方对比（当前 / import / 合并结果）。
- [ ] **多用户多解释合并**：基于 IIML `provenance.author` 字段，多研究者数据可叠加查看。

---

## 3.5 M5 — 领域数据集 + RTI 完整管线 + 跨石头知识库 → v1.0（v0.9 / v0.10 / v0.11 / v1.0）

> 目标：把 WSC3D 从"工程基础设施"升级为"汉画像石数字研究开放平台"。
> 详细论证见 [`THINKING_m5.md`](THINKING_m5.md)。
>
> 用户拍板（2026-05-05）：**数据优先** + **RTI 完整管线（不缩水）** +
> **数据集先内部成熟** + **v1.0 release 含公开数据集**。
>
> 4 阶段 12 个月节奏：

| 阶段 | 时间 | 主轨道 | 阶段产物 |
| --- | --- | --- | --- |
| Phase 1 | Q1 / 月 1-3 | 🅰 数据建设 + 主动学习 | `v0.9.0` — wsc-han-stone-v0（50 stones / 1000 instances）+ YOLOv8 han-v0 微调 |
| Phase 2 | Q2 / 月 4-6 | 🅱 RTI / 拓片 / 高度图完整管线 | `v0.10.0` — 拓片 → 高度图 → 法线 → 重打光全链；.ptm/.rti viewer；AI 摹本 v1 |
| Phase 3 | Q3 / 月 7-9 | 🅲 跨石头知识库 + 检索 | `v0.11.0` — 跨石头图谱 + CLIP 检索 + 文献库 + 词表本土化 |
| Phase 4 | Q4 / 月 10-12 | 🅳 协同治理 + v1.0 收口 | **`v1.0.0`** — 数据集扩到 200 / 5000+，公开 release |

### 3.5.1 🅰 轨道 A：领域数据集 + 领域微调（Phase 1 主线）

> 对标论文 24 + 殷契文渊核心。这是其它一切的"米"，第一优先。

- [ ] **A1 标注 SOP**：13 类高价值汉画像石类（创世主神 / 仙人异士 / 神话帝王圣贤 /
  忠臣义士刺客 / 孝子 / 烈女 / 乐舞百戏 / 车马出行 / 神兽祥瑞 / 天象日月 /
  现实生活场景 / 建筑 / 题刻 / 纹饰边框）+ unknown 兜底；**新增 `motif` 二层
  字段**承载具体故事 / 视觉格套（董永侍父 / 荆轲刺秦王 / 楚昭贞姜 / 二桃杀三士
  ……）
  - [x] **A1.1 SOP v0.3 落盘**：[`docs/han-stone-annotation-SOP.md`](han-stone-annotation-SOP.md)
    （v0.1 9 类 → v0.2 13 类 + motif 二层 + 130+ 受控母题速查 + 5 大产区风格 +
    学术参考文献 → v0.3 30 秒决策树 + 6 大边界判决 + frame/质量门槛 + P0/P1/P2 优先级
    + COCO 导出契约 + 流程图 + FAQ。基础：信立祥 / 巫鸿 / 黑田彰 / 朱浒 / 陈长虹 / 邢义田 / 姜生研究）
  - [x] **A1.2 `annotation.category` + `annotation.motif` 字段实装**：
    `frontend/src/api/client.ts` 加 `IimlHanStoneCategory` 联合类型 13 + 1 个值 +
    `IimlAnnotation.category?` / `motif?` 字段；`backend/src/services/iiml.ts`
    类型 + JSON Schema 同步；新建 `frontend/src/modules/annotation/categories.ts`
    作为 SOP ↔ 代码单一事实源（13 类 + 130+ motif 受控建议）；`AnnotationPanel`
    edit-head 加 category dropdown + 单独 Field 加 motif datalist autocomplete +
    故事类缺 motif 时琥珀色提示；新建 `training.ts` 实现 SOP §11
    `validateAnnotationForTraining` 11 项硬约束 + 1 项 warning，A2 导出按钮直接调用
  - [ ] **A1.3 SOP v0.4 迭代**：标完 P0 6 块武梁祠系列（约 180 个 annotation）
    后回看，类别分布 < 30 实例的类别考虑合并 / 调整；motif 出现频次给 A2 训练池
    导出按钮做置信度；§1.8 边界判决命中率统计
- [x] **A2 主动学习闭环 + 导出按钮**：YOLO 候选 → SAM 精修 → 人工审核 → IIML
  `reviewStatus = approved` 进入"训练池"；`AnnotationPanel` ListTab 头部加
  "导出训练集"按钮 + 本石头训练池命中徽标（✓/⚠/✗ 三档）。后端
  `backend/src/services/training-export.ts` 跨 stoneId 聚合 IIML →
  `validateAnnotationForTraining` 过滤 → 按 stoneId 70/15/15
  确定性划分（djb2 哈希）→ 写 SOP §14 完整目录结构到
  `data/datasets/wsc-han-stone-v0/`；路由 `POST /api/training/export`
- [x] **A3 `wsc-han-stone-v0` 内部数据集结构**：A2 导出契约已落地，目录
  完全符合 SOP §14：
  - `annotations/coco_train.json` / `coco_val.json` / `coco_test.json`（13 类 + IIML extension 字段）
  - `annotations/coco_categories.json`（id 1-14 固定）
  - `annotations/motifs.json`（频次表 + 按 category 拆分）
  - `annotations/splits/stone_split.json`（stoneId → split 完整映射）
  - `iiml/{stoneId}.iiml.json`（完整 IIML 备份）
  - `relations/relations_all.jsonl`（图谱训练用）
  - `SOURCES.csv`（每个 resource 的来源 / 摄影者 / 拓制者 / 授权）
  - `stats.json` + `reports/export_*.csv` + `reports/quality_warnings.csv`
  - `images/original/{stoneId}/`（目录占位，训练时按 SOURCES.csv 链接图像）
  - 当前实测：16 块石头扫描 → 10 标注（多为历史 markdown 导入 / SAM 候选）→
    全部 skipped（`bad-category` / `pre-iconographic-too-short` / `review-status-candidate`），
    符合预期：A1.2 之前的标注无 category 字段不进训练池。第一阶段目标
    50 块石头 / 1000 实例的"实"由 P0 武梁祠系列标完后实现
- [ ] **A4 YOLOv8 / YOLO11 微调**：在 A3 基础上跑微调，权重落
  `ai-service/weights/yolo-han-v1.pt`；AI 服务支持 `/ai/yolo?model=generic|han-v1`
  模型切换；YoloScanDialog 加模型选择 chip
- [ ] **A5 SAM-LoRA 微调**（GPU 资源到位再做，Q4）：让 SAM mask 边缘对石材纹理
  更稳；权重 `ai-service/weights/sam-lora-han.pt`

### 3.5.2 🅱 轨道 B：RTI / 拓片 / 高度图完整管线（Phase 2 主线）

> 对标论文 12 + 25 + 26 + RTI-Learning 半年阅读积累。**用户选择"完整管线"，不缩水**。

- [ ] **B1 拓片 → 高度图**（论文 12 复现）：`/ai/rubbing-to-heightmap?stoneId=...&resourceId=...`，
  灰度 → 梯度场 → Frankot–Chellappa Poisson 积分；输出新 resource type `HeightMap`
- [ ] **B2 高度图 → 法线图 → WebGL 重打光**：高度图梯度 + 光度立体公式 →
  `NormalMap` 资源；前端 `SourceImageView` 多资源切换里加"光照交互"模式
  （鼠标位置 = 光源方向）
- [ ] **B3 RTI 文件 viewer**：直接读 `.ptm` / `.rti` / `.hsh` 系数文件；
  前端 WebGL shader 重打光；这是 RTI-Learning 该交付但 v0.x 没出现的核心
- [ ] **B4 AI 摹本（数字拓片）**：照片 + 法线图 → 二值线图：
  - 第一阶段：HED + 形态学骨架 + 半监督 refine
  - 第二阶段：论文 25 Relic2Contour-style 半监督 GAN（CGF + AGF + CAT + Bi-GTF）
  - 输出 resource type `LineDrawing` 候选
- [ ] **B5 微痕增强**：specular enhancement / Unsharp Normal / curvature 三种通道；
  对照殷契文渊"微痕增强"，作为 IIML 新 resource type `MicroTraceEnhanced`
- [ ] **B6 RTI 采集 SOP**：`docs/rti-capture-SOP.md`，对照论文 31 武梁祠工作流

### 3.5.3 🅲 轨道 C：跨石头知识库 + 图像学检索（Phase 3 主线）

> 对标殷契文渊"图像 + 字形 + 论著"三位一体。让 WSC3D 从"单石标注工具"升级为"全库研究平台"。

- [ ] **C1 跨石头知识图谱**：现在 Cytoscape 只看单 stoneId，扩成
  `data/iiml/*.iiml.json` 全库联合图；`KnowledgeGraphView` 加"全库 / 单石"开关
- [ ] **C2 CLIP / DINOv2 图像志检索**：给一张图（或一条 IIML annotation 的 polygon
  crop）→ 跑 embedding → 全库相似度排序 → 作为"图像志候选释读"推荐
- [ ] **C3 文献库**：仿殷契文渊"3.5 万种论著"，新建 `data/literature/`
  （题录 JSON + DOI + 关联 stoneId / 主题），IIML `evidence.reference` 直接挂这里
- [ ] **C4 受控词汇本土化**：terms.json 升级为 *汉画像石专用* 词表，
  scheme 字段映射 Iconclass / Wikidata / Getty AAT
- [ ] **C5 AI 查重**：同主题母题在不同石头上的复刻自动聚类（C2 embedding +
  几何相似度）

### 3.5.4 🅳 轨道 D：协同治理 + v1.0 收口（Phase 4 主线）

- [ ] **D1 .hpsml 三方合并 UI**（与 §3.3 衔接）
- [ ] **D2 多用户 provenance**：登录态 + IIML `provenance.author` 完整化
- [ ] **D3 标注质量评估**：双标员一致性 (Cohen's κ) + 标注审定流程
- [ ] **D4 v1.0 公开数据集 release**：
  - 数据集扩到 200 块石头 / 5000+ 实例
  - 授权过滤（`SOURCES.csv` 中 `授权状态 != 已确认` 不进公开版）
  - Croissant 元数据（ML Commons 标准）
  - 上 Hugging Face / Zenodo
  - 按 CC-BY-NC 释出 `wsc-han-stone-v1` COCO + IIML 双格式
  - 直接对标殷契文渊三个开放数据集

### 3.5.5 衡量指标（v1.0 vs v0.8.0）

| 指标 | v0.8.0 baseline | v1.0 目标 |
| --- | --- | --- |
| stoneId 数 / 标注实例数 | < 10 / < 200 | 200 / 5000+ |
| YOLO 5 类 mAP@0.5 | 通用 COCO ~0.10 | han-v1 ≥ 0.55 |
| SAM mask IoU vs 人工 | 通用 ~0.78 | LoRA 微调 ≥ 0.85 |
| RTI 通路（资源类型 / 算法） | 8 占位 / 0 | 8 全可用 / 5+ 算法 |
| 跨石头检索 top-5 正确率 | 无 | ≥ 0.70 |
| 用户数 / 标注一致性 κ | 1 / N/A | 3+ / κ ≥ 0.65 |

---

## 4. 已知问题与技术债

### 设计取舍（不算 bug）

- 跨 frame 标注暂不支持就地编辑（v0.3.0 设计取舍）。用户需要切回原 frame 编辑。
- 候选合并目前只取每个多边形的外环，带孔（甜甜圈形状）的合并候选孔洞会被自动填掉。
- 单应性变换假设 4 点对应大致正向矩形且不严格共线；极端共线 / 退化时跨 frame 渲染整体跳过 + 提示重新校准。

### 技术债

- 标注画布在窗口大小剧烈变化时偶发 1 帧错位（v0.2.1 已记录）。
- 钢笔工具尚未支持贝塞尔控制柄。
- 主 chunk 仍 > 600 KB，原因是 Three.js + StoneViewer 随 viewer 首屏同步加载。
- 当前 IIML 文档中的 `culturalObject.dimensions` 字段从 metadata 注入，未来需要与"拼接方案"中的真实拼接尺寸合并。

### 数据兼容

- 旧 IIML 文档没有 `frame` 字段：渲染时按 `"model"` 处理，与历史行为一致。
- 旧 IIML 文档没有 `alignment`：跨 frame 标注被自动隐藏并提示，不会错位显示。
- 旧 IIML 文档中的 `layers` 字段在加载时会被剥离（v0.2.0 已迁移完成）。

---

## 5. 已废弃 / 不再做的方向

| 方向 | 原计划 | 决策 | 理由 |
| --- | --- | --- | --- |
| 3D 模式气泡叠加 | 浏览 / 拼接模式上叠加标注气泡 | 不做 | 与"标注内容只在标注模块出现"原则冲突；演示需求改用导出截图替代。 |
| 拼接 AABB 选边吸附 UI 化 | 高级吸附面板默认折叠 | 暂缓 | 当前用平移 / 旋转 / 长边缩放已够用；如未来需要再单独评估。 |
| 拼接方案对比 | 双方案并排查看 / 切换 | 暂缓 | 实际研究中很少同时持有两个方案。 |
| 拼接合并导出 GLB | 当前拼接合并成单文件 GLB | 暂缓 | 文件体积大、收益低；优先做 IIML 学术导出。 |
| 标注审定流程的全局开关 | candidate / reviewed / approved / rejected 出现在主流程 | 不做 | 仅在 AI 候选 / 合并场景下出现，纯手工标注不显示。 |
| 高清图 PNG 进版本库 | 把 pic/ 转码后的 PNG 提交 | 不做 | 单文件 30+ MB，转码缓存逻辑已稳定，按需重生成即可。 |

---

## 6. 与论文 / 规范的对照

| 来源 | 提示 | 对应工作 | 状态 |
| --- | --- | --- | --- |
| 论文 35 ICON Ontology | 三层解释 + 多解释并存 + 证据资源 | M2-1.1 H/B/C；多解释 M3-2.5 | ✓（v0.7.0 多解释 UI） |
| 论文 24 YOLO（汉画像石增强 YOLOv5） | 类别先聚焦高价值 5-6 个 + 领域微调 | **M5-A1 + M5-A4**（Phase 1） | M5 |
| 论文 25 Relic2Contour | AI 线图区分候选 / 确认 / 废弃 + 半监督 GAN | **M5-B4 第二阶段**（Phase 2） | M5 |
| 论文 26 点云线图 | 几何线图与图像边缘线图互补 | **M5-B2 + M5-B5**（Phase 2） | M5 |
| 论文 34 扩散 LoRA 线图 | 风格化线图严格人工审核 + 小样本 LoRA | M5-B4 远期延伸 | v1.x 后 |
| 论文 12 拓片 → 高度图 | 灰度 → 梯度积分恢复浅浮雕 | **M5-B1**（Phase 2） | M5 |
| 论文 31 武梁祠 3D 数字保护 | 3D + RTI + 图像 + 标注 + 知识图谱 整体工作流 | 全 M5 验证架构 | 持续 ✓ |
| 论文 39 多视图 SIFT + 极线几何 | SfM / MVS 多视图重建 | M5-B3 衍生 | v1.x 后 |
| 论文 40 高精度 3D（明代石碑） | 整体几何 + 真实纹理映射 + 精度元数据 | resource.precision 字段（M5 Phase 1） | M5 |
| 殷契文渊 24 万图像库 | 大规模领域图像库 | **M5-A3 + M5-D4** | M5 |
| 殷契文渊 字形 / 字检测 | 微调专用模型 | **M5-A4** | M5 |
| 殷契文渊 AI 摹本 | 拓片 → 清晰摹本 | **M5-B4** | M5 |
| 殷契文渊 微痕增强 | RTI 类增强 | **M5-B5** | M5 |
| 殷契文渊 协同标注 | 多人协作 + 三方合并 | **M5-D1 + M5-D2** | M5 |
| 殷契文渊 3 个开放数据集 | 公开下载 | **M5-D4 → v1.0** | M5 |
| IIML schema | resource / annotation / relation / processingRun | M2 + M3 全程 | ✓（v0.5.0 / v0.6.0） |
| 知识库 §三元数据架构 | resource / annotation / script 三层分离 | M2 起始落地 | ✓ |
| **新**：4 点单应性对齐 | 跨 frame 投影 | M3-2.2 | ✓（v0.3.0） |
| **新**：候选合并 | polygon-clipping union | M3-2.1 | ✓（v0.3.0） |
| **新**：从 3D 模型生成正射图 | offscreen Three.js + 1:1 对齐 | M4 | ✓（v0.8.0） |
| **新**：跨石头知识图谱 | 全库联合图 | **M5-C1**（Phase 3） | M5 |
| **新**：CLIP / DINOv2 图像志检索 | 全库视觉相似检索 | **M5-C2**（Phase 3） | M5 |
| **新**：文献库 + DOI 关联 | 论著挂 IIML evidence | **M5-C3**（Phase 3） | M5 |
| **新**：AI 查重 / 母题聚类 | 同主题在不同石头上的复刻 | **M5-C5**（Phase 3） | M5 |
