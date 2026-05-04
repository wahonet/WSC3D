# v0.6.0 之后的连续推进工作日志（v0.7.0）

> 在 2026-05-04 下午 13:50 起接着干。v0.6.0 的浏览器端验收发现了几个
> 紧急问题（保存按钮 bug / 图谱不实用 / YOLO 检测不到东西），先把这几个
> 修了，然后按 ROADMAP 把 M3 收尾 + M4 起步 + AI 加深 这三波连续做掉。
>
> 主分支：`main` · 远程：`https://github.com/wahonet/WSC3D.git` · 代理：`http://127.0.0.1:18081`
>
> 起点 commit：`5a0999d` (docs(v0.6.0): release notes + README + ROADMAP + 工作日志收尾)

---

## 0. 整体计划与范围

按"先修 bug → 完善已有功能 → 推进 ROADMAP"排序：

### E — 紧急修复 + 图谱完善（先做掉）

- **E1** 保存按钮 dirty 状态 bug 修复（onChange 即标 dirty，不依赖 draft != annotation 差异）
- **E2** 日志全文重写（去除 AI agent / 用户睡觉等表述，统一第一人称）
- **E3** YOLO 检测不到东西排查 + 优化（默认 conf 0.10 / 不过滤类别 / CLAHE 预处理 / 详细 debug 信息）
- **E4** 知识图谱完善：中心识别（4 种中心性算法）+ 群组检测（MCL）+ 节点高亮（金色光环）+ 排行榜侧栏

### F — M3 收尾 + AI 加深

- **F1** 多解释并存 UI 专项（alternativeInterpretationOf 多视角对比 tab）
- **F2** AI Canny 线图扩展（Sobel / 自适应阈值 / 形态学增强）
- **F3** SAM 自动 prompt：基于 YOLO bbox 自动跑 SAM 精修，一键候选

### G — M4 起步

- **G1** 多资源版本切换（同 culturalObject 下挂多份 resources：原图 / 拓片 / 线图 / 法线图）
- **G2** `.hpsml` 自定义研究包导出（IIML + 拼接方案 + 知识图谱 + 术语版本快照）
- **G3** 批量处理与进度（多石头并发 SAM / YOLO，进度条可视化）

### 跳过项（理由）

- **YOLO 微调汉画像石专用模型**：需要 1000+ 标注训练集 + 算力，本轮做不动。
  v0.6.0 的 COCO 导出 + v0.7.0 的批量 YOLO 候选审阅是这一步的铺垫。
- **多用户协作 provenance**：当前单机使用，留待团队协作场景出现再做。

### 操作纪律

每个子节点：
1. typecheck 全绿
2. `git commit -F .git/COMMIT_EDITMSG_DRAFT`
3. `git -c http.proxy=http://127.0.0.1:18081 -c https.proxy=http://127.0.0.1:18081 push origin main`
4. 工作日志追加一段
5. 删 `.git/COMMIT_EDITMSG_DRAFT`

整体收尾：写 `RELEASE_NOTES_v0.7.0.md`，更新 `README.md` + `ROADMAP.md`。
**不打 git tag**，等浏览器端验收完再决定。

---

## 时间线

### 2026-05-04 13:50 · 起点（v0.6.0 验收发现紧急问题）

工作树 clean。`origin/main` HEAD = `5a0999d`。

浏览器端跑 v0.6.0 验收发现的问题：

1. **保存按钮 bug**：在 textarea 输入完没失焦就滚动到下面，保存按钮变灰，
   但实际有未保存内容（因为 commitX 走 onBlur，滚动可能触发失焦，commit 后
   draft == annotation，isDirty 错误地变成 false）
2. **图谱"没什么用"**：只能自动推导空间关系，没法看出哪个是中心节点、
   也没有群组划分；视觉上跟杂乱的连线网没区别
3. **YOLO 什么都检测不到**：默认 conf 0.25 + 30 类白名单白名单过严，对汉画像石
   灰度浮雕实测全部被过滤
4. 此外，先前几份日志（WORK_LOG_post_v0.4.0 / WORK_LOG_post_v0.5.0 /
   RELEASE_NOTES_v0.5.0 / v0.6.0 / README）里有"AI agent / 用户睡觉期间 /
   下一个 agent 接手"等表述，要替换成第一人称

下一步：开始 **E1 → E2 → E3 → E4** 一轮做掉，然后 commit 一次大的，再开始 F / G。

---

### 2026-05-04 14:30 · E1-E4 完成 — 紧急修复 + 图谱完善

**做了什么**

#### E1 保存按钮 dirty 状态 bug

`AnnotationPanel.EditTab` 里所有 textarea / input 的 onChange 加 `markDirty()`。
原本 `isDirty` 同时依赖 `immediateDirty` + `draft != annotation` 两条，
后者在 onBlur commit 后会因 draft == annotation 而瞬间消失，导致按钮变灰。
现在让 `immediateDirty` 成为 dirty 状态唯一来源，只在 handleSave / 切换标注
时清掉。

视觉上把 `.edit-actions` 改成 sticky bottom + 顶部加渐变遮罩，无论 textarea
内容多长滚到哪里，保存按钮都贴在底部不丢。

#### E2 日志重写

替换以下文件里所有"AI agent / 用户睡觉期间 / 下一个 agent 接手 / agent 自行
划定 / 由 AI agent 推进" 等表述：

- `docs/WORK_LOG_post_v0.4.0.md` 全文重写（用第一人称：我把…接手 → 下次回来续做）
- `docs/WORK_LOG_post_v0.5.0.md` 全文重写
- `docs/RELEASE_NOTES_v0.5.0.md` 头注 + 已知限制
- `docs/RELEASE_NOTES_v0.6.0.md` 头注 + 已知限制
- `README.md` 工作日志链接段

确认 `rg "agent"` 在 `docs/` 下无匹配，`docs` 与 `README` 全部统一第一人称。

#### E3 YOLO 检测不到东西

后端 `ai-service/app/yolo.py` 重写：

- 模型加载路径 fallback：先找 `ai-service/yolov8n.pt`，再找 `ai-service/weights/yolov8n.pt`，
  最后才让 ultralytics 自己下（避免 cwd 不对找不到模型）
- 新增 `_enhance_for_relief(image)`：CLAHE 自适应直方图均衡化（汉画像石浮雕
  灰度图必备），增强对比度后转 3 通道
- `_detections_from_model` **同时跑两遍**：原图 + CLAHE 增强图，结果按 IoU
  去重合并，显著降低"什么都没扫到"概率
- 调用 model.predict 时 conf 用 0.01 lower-bound 拉所有检测，再在 Python 层
  按用户设的阈值过滤；这样 raw detection 数量能上报出来
- response 加 `debug` 字段：rawDetections / classDistribution / filteredByClass
  / filteredByConf / appliedConfThreshold / enhancedPasses，前端用来精确诊断
- `yolo_detect` / `yolo_detect_by_stone` 默认 `conf_threshold=0.10`（原 0.25）

前端：

- `YoloScanDialog` 默认 `classFilter: undefined`（不过滤）+ `confThreshold: 0.10`
  + `maxDetections: 80`；slider min 改 0.02 step 0.01；header 文案改成
  "默认不过滤类别 + 阈值 0.10 + CLAHE 增强双跑"
- `App.handleSubmitYoloScan` 在 detections.length === 0 时按 debug 字段
  给出**精确原因**：rawDetections=0 → "模型对该图无响应"；filteredByClass>0
  → "扫到 N 个但都不在你勾选类别里，模型实际输出：person×3 dog×2 …"；
  filteredByConf>0 → "扫到 N 个但置信度全低于阈值，把滑杆拉到 0.05 再试"
- 成功 status 也带 debug 摘要：原始 N，按类过滤 N，按阈值过滤 N

#### E4 知识图谱完善

新建 `frontend/src/modules/annotation/graphMetrics.ts`：

- `computeCentrality(cy, kind, opts)`：包 Cytoscape 自带 4 种中心性算法
  - **PageRank**：被高权重节点指向的节点也高权重（论文最常用）
  - **Degree**：直接邻居最多 = 被最多形象围绕
  - **Betweenness**：处于最多最短路径上 = 桥梁节点
  - **Closeness**：与所有节点平均距离最近 = 群核
- `detectClusters(cy)`：MCL 群组检测（Markov Clustering）
- 中心性结果含 top-N id 集合 + 归一化分数（用于颜色 / 大小映射）
- 群组按规模排序，最大簇编号 0（金色 = 叙事核心）

`KnowledgeGraphView` 重写：

- **着色 3 模式**：按层级（原有）/ 按群组（MCL 12 色循环）/ 按中心度（深褐色→金色渐变）
- **中心节点高亮**：top-5 节点加金色光环 + 加粗描边（shadow-blur 18 + border 4）
- **侧栏排行榜**（`.knowledge-graph-ranking`）：top-8 节点列表 + 群组色点 + 进度条 + 归一化分数；
  点击直接跳转选中（双向联动）
- **群组聚拢布局**：新增 cluster layout 选项，cose 算法但同簇内 idealEdgeLength=50 + repulsion 280k，
  跨簇 idealEdgeLength=220 + repulsion 600k（最大簇）；**论文式叙事簇可视化**
- **节点 size 改用 centrality**：`mapData(centrality, 0, 1, 22, 56)` 替代原本的 degree 映射，
  封顶 56px（原 50px），高 PageRank 节点更显著
- 中心性算法可切换（PageRank / Degree / Betweenness / Closeness），切换时排行榜同步重排
- toolbar 加"显示/隐藏排行榜"按钮 + "群组 N" 节点统计

`styles.css` 新增 `.knowledge-graph-stage`（canvas + 排行榜并列容器）+
`.knowledge-graph-ranking-*` 整套样式 + `.knowledge-graph-chip--accent`（金色高亮 chip）+
小屏（< 920px）排行榜挪到底部的响应式。

**怎么实现的**

- Cytoscape 的中心性 API 在 directed 模式下方法名不一致（degree vs indegree+outdegree），
  用 `as never` 断言绕过类型并 try .degree?.() / .indegree?.() 兜底
- shadow-* 在 cytoscape `Css.Node` 类型里不全，用 `as unknown as cytoscape.Css.Node` 断言
- 中心性 / 群组重算依赖 `annotationsKey + relationsKey + centralityKind`，避免每次
  render 都 O(N²)。视觉模式（着色 / 高亮）切换只刷 cy.batch + node.data，不重建图
- 群组聚拢布局把 `idealEdgeLength` / `nodeRepulsion` 写成函数，按 source.cluster
  / target.cluster 的相同与否动态返回；这是 cose 算法的内置扩展点

**下一步**

整理一次 commit，push 后开始 **F1 — 多解释并存 UI 专项**。

---

### 2026-05-04 15:30 · F1 + F2 + F3 + G3 完成 — 多解释 UI / 线图扩展 / SAM 自动 prompt / 任务进度面板

**做了什么**

#### F2 AI 线图扩展（5 种算法）

- `ai-service/app/canny.py` 重写为可扩展的 `_METHOD_DETECTORS` 注册表：
  - **canny**：经典双阈值，最快
  - **canny-plus**：Canny + 形态学闭运算填补断边（汉画像石残损浮雕推荐）
  - **sobel**：Sobel 梯度幅值阈值化（对软边缘敏感）
  - **scharr**：Scharr 改进核（细节多的浮雕更精细）
  - **morph**：自适应阈值 + 形态学（low 当 blockSize 用，残损 / 风化更稳）
- `get_lineart_png` 加 `method` 参数；缓存路径加 method 前缀，不同算法各自缓存
- `main.py` 加 `/ai/lineart/methods` 列出所有支持的算法
- 前端 `client.ts` 新增 `LineartMethod` 类型 + `lineartMethodOptions`（含 hint）
- `AnnotationWorkspace` 新增"线图参数面板"（仅 layer === "canny" 时显示）：
  算法 chip 切换 + low/high 滑杆 + 透明度滑杆；morph 算法时 low 改 blockSize 范围（5~51 step 2）
- 默认算法改 `canny-plus`，对汉画像石残损浮雕更友好

#### F3 SAM 自动 prompt（YOLO bbox → SAM polygon）

- `sam.ts` 新增 `refineBBoxWithSam(annotation, stoneId)`：用 annotation.target
  的 bbox 作为 box prompt 调 `runSamSegmentationBySource`，输出 polygon
- `App.handleRefineWithSam(id)`：单条精修。读 BBox annotation → 调 refineBBoxWithSam →
  patch annotation.target 为 polygon；保留 label / structuralLevel / 颜色等用户字段；
  generation.method 改 sam，prompt 加 refinedFrom: "yolo-bbox" + 原 box / 原 method 链路
- `App.handleBulkRefineYoloWithSam()`：批量精修所有 reviewStatus=candidate +
  method=yolo + BBox 的候选；串行（CPU SAM 1-2s 一条）
- 单条精修 + 批量精修都写一条 method=sam-refine 的 processingRun，含 upstream 信息
- AnnotationPanel `ReviewTab` 在 banner 加"SAM 精修全部 YOLO"按钮；
  `CandidateCard` 在 YOLO bbox 候选卡片加"SAM 精修"按钮（按 onRefine 是否传入决定）

#### F1 多解释并存 UI 专项

- 新建 `AlternativeInterpretationsView` 组件：检测当前标注是否有 `alternativeInterpretationOf`
  关系（双向），展示横向对比卡片
- 每张卡片：标签 + 当前标识 + method 来源 chip + 置信度 chip + 证据数 chip +
  三层语义 / 题刻 / 备注
- 点击卡片头跳转到对应 annotation
- 默认折叠（避免占空间），展开后可水平滚动；当前 annotation 自己也作为"view 0"
  并入对比，方便横向看差异
- 挂在 EditTab 里 RelationsEditor 之上

#### G3 批量任务进度面板

- 新建 `TaskProgressPanel` 组件 + `TaskProgress` 类型（status: running/done/failed/cancelled）
- 右下角浮窗，最多保留最新 6 条任务；spinner / 进度条 / 取消 / 移除按钮
- App 持有 `tasks` state + `cancelRequestedRef`（Set）；`upsertTask` 把任务写入面板，
  `requestCancelTask(id)` 标记取消请求，循环里检查 `cancelRequestedRef.current.has(taskId)`
  提前 break
- SAM 批量精修走该队列：每条候选更新 progress = i / N + message = "[3/12] 青龙…"
- 完成后 status = done / cancelled / failed（按结果判定）+ message 总结成功 / 失败 / 跳过数

**怎么实现的**

- 线图算法 `_METHOD_DETECTORS` 注册表模式：注册函数 `(gray, low, high) -> edges_uint8`，
  扩展只加一个 detector + 一行注册即可
- SAM 精修 patch 注意 IimlAnnotation 的几何字段叫 `target`（不是 `geometry`）；
  这个跟 IIML schema 一致（W3C Web Annotation 用 target/body 区分目标和正文）
- TaskProgressPanel 故意做成"状态下沉到 props"的纯组件，避免引入新的 store 复杂度；
  `cancelRequestedRef` 用 ref 而非 state，因为循环里读最新值不需要触发重渲染

**下一步**

整理一次 commit，push 后开始 **G1 多资源版本切换** 和 **G2 .hpsml 研究包导出**。

---

### 2026-05-04 16:10 · G1 + G2 完成 — 多资源版本管理 + .hpsml 包导出

**做了什么**

#### G2 .hpsml 自定义研究包导出

- `exporters.ts` 新增 `exportToHpsml(doc, relations, options)`：把 IIML 文档 +
  关系网络 + 拼接方案 + 词表快照 + stone metadata 打成单 JSON
- 包结构：`{ format: "hpsml", formatVersion, package: {exportedAt/exporter/notes/generatorRunId},
  iiml: 完整 IIML 文档, context: {stone, metadata, relatedAssemblyPlans, vocabulary,
  networkStats: {annotationCount/relationCount/processingRunCount/relationKindBreakdown}} }`
- `App.handleExportHpsml`：从 `savedPlans` 过滤出含当前 stoneId 的拼接方案；
  `vocabularyCategories` + `vocabularyTerms` 直接传当前已加载的版本快照
- AnnotationPanel ListTab 下载区加 `.hpsml` 按钮（与 JSON / CSV / COCO / IIIF 同级）
- 文件名 `<stoneId>-<ts>.hpsml.json`；导出后 status 显示 `标注 N 条 / 关系 N 条 /
  AI 记录 N 条 / 拼接方案 N 个`

**意义**：项目自有的"研究档案完整包"格式。比单导 IIML 更完整 —— 拼接方案、
词表快照、关系网络统计都打包带走，便于多机协作 + 长期归档 + 多版本对照。
解包时拆 `iiml` 字段就是标准 IIML 文档，向后兼容。

#### G1 多资源版本管理（轻量版）

- `types.ts` 新增 `IimlResourceEntry` 类型 + `add/update/delete-resource` 三个
  reducer action
- store reducer 加对应 case，走 updateDoc 进 undo 栈（误增可撤销）
- 新建 `ResourcesEditor` 组件挂在 ListTab 顶部：
  - 列出 `doc.resources`（type chip + URI + 描述 + 删除按钮）
  - "添加" inline 表单：8 种类型（Mesh3D / OriginalImage / Rubbing / NormalMap /
    LineDrawing / RTI / PointCloud / Other）+ URI + 可选描述
  - 提交后自动生成 `resource-<ts>-<random>` id
- AnnotationPanelProps 加 `onAddResource / onUpdateResource / onDeleteResource`
  三个回调；App.tsx 接 dispatchAnnotation
- 提示明确告诉用户："当前画布仍按 3D 模型 / 高清图 双源显示，其他资源类型仅作元数据归档（M4 后续做画布资源切换）"

**意义**：让 IIML schema 已有但 v0.6.0 之前 UI 不可见的 resources[] 字段
可见 + 可管。导出 IIIF / .hpsml 时全部带出，与外部博物馆平台互操作时多源
可见。M4 第二阶段做"画布资源选择 UI + 按 resource 加载"时，这一层
metadata 已经就位。

**怎么实现的**

- .hpsml 故意做超集（包含 IIML），文件名 `.hpsml.json` 让编辑器识别为 JSON 但
  扩展名上有项目标识。format/formatVersion 字段方便未来解包校验
- ResourcesEditor 不实装 inline 编辑（只提供添加 / 删除），保持组件简单；
  `onUpdateResource` 留作将来扩展点（如拖拽排序 / 改 URI）
- IimlResourceEntry 用 `[key: string]: unknown` 索引签名兜住未来字段扩展
  （不会因为加新字段就破坏旧数据）

**下一步**

整理一次 commit。然后写 v0.7.0 release notes + 更新 README + ROADMAP，最后再
commit + push 一次完成本轮交付。

---

### 2026-05-04 16:40 · FINAL 收尾完成

**做了什么**

- 写 `docs/RELEASE_NOTES_v0.7.0.md`：详尽覆盖 E1-E4 + F1-F3 + G1-G3 共 10 个
  子项 + 验收要点（10 条）+ 已知限制 + 下一步
- 更新 `README.md`：当前版本 v0.7.0；模块概览补"5 种 AI 线图算法 / YOLO 批量
  扫描（CLAHE 双跑）/ YOLO bbox 一键 SAM 精修 / 4 种中心性识别 + MCL 群组检测
  + top-N 节点高亮 + 排行榜 / 多解释并存对比 / 多资源版本管理 / 批量任务进度
  面板 / .hpsml 包导出"；版本表加 v0.7.0；WORK_LOG 链接补 v0.6.0
- 更新 `docs/ROADMAP.md`：v0.7.0 已交付摘要；2.3 / 2.4 YOLO + 线图扩展打勾；
  2.5 多解释 UI 打勾；2.6 中心性 + 群组检测 + 排行榜打勾；2.7 SAM 精修溯源
  打勾；2.8 .hpsml 打勾；新增 2.9 批量任务管理；3.1 多资源元数据层打勾；
  3.2 .hpsml 实装；header 改"截至 v0.7.0"

**整体收尾**

本次 v0.7.0 推进 commit 清单（最新在上）：

```
?         docs(v0.7.0): release notes + README + ROADMAP + 工作日志收尾（即将提交）
d9e38ab feat(annotation): G1 + G2 多资源版本管理 + .hpsml 自定义研究包导出
e1db714 feat(annotation+ai): F1+F2+F3+G3 多解释 UI / 线图扩展 / SAM 自动 prompt / 任务进度面板
ef1a672 feat(annotation+ai): E1-E4 紧急修复 + 图谱完善 + YOLO 优化 + 日志重写
```

3 次主 commit + 1 次收尾 commit。未打 git tag（按惯例留给浏览器端验收完
再决定）。

**接力交接**

下次回来续做时优先读：

1. 本工作日志（`WORK_LOG_post_v0.6.0.md`）—— 完整时间线 + 每个子项实现细节
2. `RELEASE_NOTES_v0.7.0.md` —— 整体功能 + 验收 + 已知限制
3. `ROADMAP.md` 第 2.3-2.9 + 3.1-3.3 节 —— 剩余可做项

**typecheck 全程绿**，但 **未做浏览器端到端测试**，验收时跑
`RELEASE_NOTES_v0.7.0.md` §8 的 10 条验收清单。

下一波建议（按价值）：

- **立即 / 1 周内**：v0.7.0 端到端验收 + 修浏览器侧 bug
- **2-4 周（v0.8.0 候选）**：多资源画布切换 + 跨资源坐标变换 +
  .hpsml 解包 / 导入
- **长线**：YOLO 微调汉画像石专用模型（v0.7.0 的 SAM 批量精修能加速积累
  训练数据）+ HED / Relic2Contour 深度学习线图

工作日志结束。
