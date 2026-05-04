# 下一步工作计划

> 当前版本：`v0.6.0` —— 在 v0.5.0（关系网络）基础上完成 M3 收尾 + M4 起步：
> 知识图谱关系筛选 + Cytoscape layout 切换 + 节点 size 按度数 +
> SAM/YOLO processingRuns 写入 IIML + AI 处理记录 section + 共现术语推荐
> + COCO / IIIF Web Annotation 导出 + StoneViewer lazy 加载（主 chunk
> 882 → 477 KB）。
> 标注模块的 AI 调用全程可追溯，且能直接喂 ML 训练 + 与外部博物馆平台互操作。
> 本文档面向 AI IDE 与协作者，按"近期 → 中期 → 远期"列出下一步要做的工作。

---

## 0. 当前已交付（截至 v0.6.0）

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

### AI 子服务（FastAPI）

- `/ai/health`：服务健康检查 + SAM 加载状态轮询（pending / downloading / loading / ready / error）。
- `/ai/sam`：MobileSAM ViT-T 推理；多 prompt（正点 / 负点 / box 一次提交）；`imageBase64` 截图路径与 `stoneId` 高清图路径。
- `/ai/yolo`（v0.4.0 实装）：YOLOv8n COCO 推理；`stoneId` / `imageBase64` 双路径；返回 bbox（带 `bbox_uv` image-normalized 与 SAM polygon 同约定）。
- `/ai/source-image/{stone_id}`（v0.3.0 新增）：tif → PNG 转码 + 落盘缓存（`max_edge` 可调，默认 4096）。
- `/ai/lineart/{stone_id}`（v0.4.0 新增）：Canny 线图 PNG（白线 + alpha），落盘缓存 `cache/lineart/`，预留 `method` 参数扩展 Sobel / HED / Relic2Contour。
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

### 2.3 YOLO 候选检测（已完成 v0.4.0 第一阶段）

- [x] **批量审阅流程**：工具栏 Radar 触发；扫描 → bbox 落入候选 tab → 用 SAM 二次精修。
- [x] **类别过滤 + 置信度阈值**：YoloScanDialog 提供 `classFilter` chip 多选 + 阈值滑杆 + 最大检测数。
- [x] **通用 COCO 模型起点**：默认勾选"通常对汉画像石可用"的 30 种 COCO 子集（人物 / 鸟兽 / 常见物）。
- [ ] **微调汉画像石专用模型**：YOLOv8 在标注积累足够后微调，识别"祥瑞 / 礼器 / 车马 / 建筑"等高价值类（论文 24 提示）。需要先用现有手工 + 半自动标注积累 ~1000 个 bbox 训练集。
- [ ] **候选 tab 类别筛选**：候选数 > 30 时按 label chip 筛选。

### 2.4 AI 线图（已完成 v0.4.0 第一阶段）

- [x] **Canny 线图叠加层**：在高清图模式下半透明叠加，辨识浅浮雕轮廓；后端落盘缓存 + 前端 mini segmented 切换。
- [ ] **Sobel / HED 等其它线图算法**：`/ai/lineart?method=...` 已预留 `method` 参数，扩展时仅添 backend 实现。
- [ ] **Relic2Contour / 论文 25**：等其变成成熟开源模型后接入；当前先占位。
- [ ] **风格化线图严格审核**（论文 34 LoRA 扩散）：所有 AI 生成的线图标记为 candidate，必须人工确认才进入 IIML（当前 Canny 是纯算法不写库，不需要审核流程）。

### 2.5 多解释并存与标注间关系（v0.5.0 + v0.6.0 完成大半）

- [x] **叙事 / 层级关系**：14 种受控谓词（holds / rides / attacks / faces /
  partOf / contains / nextTo / above / below / leftOf / rightOf / overlaps /
  alternativeInterpretationOf / manual）；RelationsEditor inline 表单创建。
- [x] **空间关系自动推导**：deriveSpatialRelations 按几何推导 6 种空间关系；
  不入库，"采纳"才升级为 manual。
- [x] **画布关联连线**：选中标注时画 manual 实线 + auto 虚线连到所有相关。
- [x] **关系筛选 / 高亮**（v0.6.0 D1）：知识图谱 kind chip + origin chip
  toggle；被排除的边淡化不隐藏。
- [ ] **多解释并存 UI**：alternativeInterpretationOf 类型已支持，但 UI 上
  还没专门的"多视角对比"展示（同一区域多个解释并排）；留下个版本做。

### 2.6 知识图谱可视化（v0.5.0 + v0.6.0 完成）

- [x] **Cytoscape 节点 / 边图**：标注按 structuralLevel 着色，关系按 4 组着色。
- [x] **双向联动**：图上点节点 → 画布选中；画布选中 → 图上节点高亮 + 关联
  边高亮。
- [x] **大图性能**（v0.6.0 D2）：4 layout 切换 + > 100 节点默认 grid +
  节点 size 按 degree 动态映射。
- [x] **共现推荐**（v0.6.0 D6）：基于 annotation.terms 共现矩阵推荐 top 5；
  含 terms 标注 < 5 时静默。
- [ ] **更智能的推荐**：当前共现只看 term ↔ term，不看"距离 / 关系" 加权；
  下个版本可纳入 spatial / narrative relations 加权。

### 2.7 学术溯源（v0.6.0 新增 - D3 + D4）

- [x] **processingRuns 写入 IIML**：SAM / YOLO 每次调用追加一条记录，含
  method / model / input 摘要 / output / resultAnnotationIds / 时间 / 错误。
- [x] **AI 处理记录 section**：详情面板可折叠展示选中标注的全部 AI 调用历史。
- [ ] **多用户协作 provenance**：当前 createdBy 写死 "local-user"；多用户
  环境需要登录态 + IIML provenance 字段完整化。

### 2.8 学术导出（v0.6.0 新增 - D7 + D8，部分 M4）

- [x] **COCO JSON**：BBox / Polygon → segmentation + categories（按
  structuralLevel）+ iiml_id 扩展字段保留链路。
- [x] **IIIF Web Annotation**：W3C Web Annotation Data Model；BBox →
  FragmentSelector，Polygon → SvgSelector；body 按 purpose 拆分；motivation
  区分 inscription。
- [ ] **`.hpsml` 自定义研究包**：扩展 IIML 加入拼接方案、知识图谱、术语版本快照
  等，作为"研究档案完整包"。M4 范围。

### 2.7 类 Git 版本管理（可选，待评估）

- [ ] 标注每次保存形成快照（hash + 作者 + 备注），存入 `data/iiml-history/`。
- [ ] 历史 tab 列出快照，支持回滚 / 查看 diff。

> 是否需要版本管理取决于实际研究流程，待用户判断后再排期。

---

## 3. M4 — 多源资源与导出

### 3.1 多源资源版本切换

- [ ] **一对象多资源**：同一 `culturalObject` 下挂多份 `resources`（原图 / RTI / 拓片 / 线图 / 法线图 / 网格）。
- [ ] **画布资源切换 UI**：在右上角"底图切换条"基础上扩展为多选项，标注 `resourceId` 绑定到具体版本。
- [ ] **跨版本坐标变换**：`coordinateSystem.transform` 字段，所有版本最终归一到一个统一坐标空间。
- [ ] **资源元数据**：拍摄方式、设备、分辨率、采集者，便于研究溯源。

### 3.2 导出格式扩展

- [ ] **IIIF Web Annotation**：与外部文物平台互操作。
- [ ] **COCO JSON**：用于目标检测模型训练。
- [ ] **PNG + Mask**：原图 + 分割 mask，用于语义分割训练。
- [ ] **`.hpsml` 自定义研究包**：扩展 IIML，加入拼接方案、知识图谱、术语版本快照等，作为"研究档案完整包"。

### 3.3 数据交换与协作

- [ ] **导入 / 合并外部 IIML**：检测同 ID 标注差异，UI 展示三方合并。
- [ ] **多用户多解释合并**：基于 IIML `provenance.author` 字段，多研究者数据可叠加查看。

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
| 论文 35 ICON Ontology | 三层解释 + 多解释并存 + 证据资源 | M2-1.1 H/B/C；多解释 M3-2.5 | 三层 ✓；多解释待做 |
| 论文 24 YOLO | 仅作 candidate，类别先聚焦高价值 5-6 个 | M3-2.3 | 待做 |
| 论文 25 Relic2Contour | AI 线图区分候选 / 确认 / 废弃 | M3-2.4 | 待做 |
| 论文 26 点云线图 | 几何线图与图像边缘线图互补 | M3-2.4 + M4 资源版本 | 待做 |
| 论文 34 扩散 LoRA 线图 | 风格化线图严格人工审核 | M3-2.4 | 待做 |
| IIML schema | resource / annotation / relation / processingRun | M2 + M3 全程 | annotation ✓；relation / processingRun 待做 |
| 知识库 §三元数据架构 | resource / annotation / script 三层分离 | M2 起始落地 | annotation ✓ |
| **新**：论文 / 规范以外的工程产物 | 4 点单应性对齐 | M3-2.2 | ✓（v0.3.0） |
| **新**：候选合并 | polygon-clipping union | M3-2.1 | ✓（v0.3.0） |
