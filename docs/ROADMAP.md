# 下一步工作计划

> 当前版本：`v0.3.0` —— 在 v0.2.2（M2 ICON 化）基础上完成 M3 第一波：SAM 标注闭环、多源底图（3D / 高清图）、4 点对齐校准、视图交互一致化。
> 本文档面向 AI IDE 与协作者，按"近期 → 中期 → 远期"列出下一步要做的工作。

---

## 0. 当前已交付（截至 v0.3.0）

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
- **SAM 智能分割**：单击对象出多边形候选；高清图直读路径（`stoneId` + MobileSAM ViT-T）+ 当前视角截图回退。
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

### AI 子服务（FastAPI）

- `/ai/health`：服务健康检查 + SAM 加载状态轮询（pending / downloading / loading / ready / error）。
- `/ai/sam`：MobileSAM ViT-T 推理；支持 `imageBase64` 截图路径与 `stoneId` 高清图路径。
- `/ai/source-image/{stone_id}`（v0.3.0 新增）：tif → PNG 转码 + 落盘缓存（`max_edge` 可调，默认 4096）。
- `/ai/yolo`、`/ai/canny`：占位接口（M3 后续启用）。

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

## 2. M3 — AI 标注接入与多解释（进行中）

### 2.1 SAM 智能分割（已完成 v0.3.0）

- [x] **阶段 1**：MobileSAM ViT-T 启动时自动从 GitHub 拉取权重（`weights/mobile_sam.pt`）；单点 prompt；OpenCV Canny fallback。
- [x] **阶段 2**：高清图直读路径（`stoneId` + 后端 PIL 解码 + tif→PNG 转码缓存）；前后端 v 轴方向统一；多 mask 候选启发式（丢面积 > 50% 的"场景级"大块、必须包含 prompt 点、选最紧凑那个）。
- [x] **候选合并**（polygon union）：候选 / 列表两个 tab 都支持。
- [ ] **阶段 3**：多 prompt 点累积（含负点）+ box prompt；处理运行记录写入 IIML `processingRuns`。

### 2.2 多源底图与对齐校准（已完成 v0.3.0）

- [x] **3D 模型 / 高清图**双底图切换。
- [x] **4 点单应性对齐校准**：`culturalObject.alignment` + 跨 frame 标注按 H 矩阵投影显示。
- [ ] **更精细的对齐**：4 点扩展到 N 点（≥ 4），用 SVD 而不是 8 元 DLT 求解，提升标定精度；当前 4 点对小型不规则画像石已足够。
- [ ] **跨 frame 标注就地编辑**：当前跨 frame 标注只能查看，需要切回原 frame 编辑。如确有研究流程上的需要（如在 3D 上拖动一个图坐标系标注），再加反向投影路径。

### 2.3 YOLO 候选检测

- [ ] **批量审阅流程**：扫描 → 列表展示候选 → 单条 Approve / Reject / Edit → 进入正式标注。
- [ ] **类别从高价值 5–6 个开始**（论文 24）：人物、车马、鸟兽、建筑、礼器。
- [ ] **类别置信度阈值**：UI 暴露调整滑杆，避免一次倾倒大量低置信度候选。

### 2.4 AI 线图

- [ ] **Canny 线图层**：作为可切换的图像层（与 3D / 高清图互斥），便于辨识浅浮雕轮廓。
- [ ] **Relic2Contour / 论文 25**：当其变成成熟开源模型后接入；当前先占位。
- [ ] **风格化线图严格审核**（论文 34 LoRA 扩散）：所有 AI 线图标记为 candidate，必须人工确认才进入 IIML。

### 2.5 多解释并存与标注间关系

- [ ] **多解释并存**：同一区域可保留不同研究者的释读，用 `relations.alternativeInterpretationOf` 表达。
- [ ] **叙事关系**：`holds / rides / attacks / partOf / contains` 等受控谓词，UI 用拖拽连线 + 关系类型选择器。
- [ ] **空间关系自动推导**：`above / below / leftOf / rightOf / overlaps` 由几何自动判定，作为知识图谱的边。

### 2.6 知识图谱可视化

- [ ] 右侧增加"知识图谱" tab，[Cytoscape.js](https://js.cytoscape.org/) 渲染节点 / 边图。节点点击 → 画布上高亮对应标注。
- [ ] **共现推荐**：标注完"西王母"后，自动推荐"玉兔 / 九尾狐 / 三足乌"等共现术语。
- [ ] **关系筛选 / 高亮**：选某个关系类型时，只显示对应的边。

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
