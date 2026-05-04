# WSC3D v0.7.0 — 紧急修复 · 图谱完善 · 多解释 UI · AI 加深 · 多资源 · .hpsml 包

> 发布日期：2026-05-04
> 对应计划：v0.6.0 浏览器端验收紧急修复 + M3 完结 + M4 起步 + AI 加深
> 上一发布：[`v0.6.0`](RELEASE_NOTES_v0.6.0.md) — M3 收尾 · 学术导出 · 工程瘦身

v0.6.0 验收发现几个紧急问题，先修了，然后接着把 ROADMAP 上挂了几版本的
M3 收尾 + M4 起步 + AI 加深一波做完。这一版交付的东西比较多，按主题分了 4 块：

1. **紧急修复（E）**：保存按钮 dirty 状态 + YOLO 检测不到东西 + 图谱不实用 + 日志统一第一人称
2. **AI 加深（F）**：5 种线图算法 + SAM 自动 prompt（YOLO bbox → polygon）+ 多解释并存 UI
3. **M3 收尾（G3）**：批量任务进度面板（可中途取消）
4. **M4 起步（G1 + G2）**：多资源版本管理 + .hpsml 自定义研究包导出

工作日志：[`WORK_LOG_post_v0.6.0.md`](WORK_LOG_post_v0.6.0.md)。

---

## 1. 紧急修复（E）

### 1.1 保存按钮 dirty 状态修复（E1）

修复方式：让 `immediateDirty` 成为 dirty 状态唯一来源。所有 textarea / input 的
onChange 都调 `markDirty()`，只在 `handleSave` 或切换标注时清掉。这样即使
onBlur commit 后 `draft == annotation`，按钮也仍然亮起。

视觉上把 `.edit-actions` 改成 `position: sticky; bottom: -14px` + 顶部加渐变
遮罩，无论 textarea 内容多长滚到哪里，保存按钮都贴在底部不丢。

### 1.2 YOLO 检测不到东西（E3）

后端 `ai-service/app/yolo.py` 重写：

- **模型加载路径 fallback**：先找 `ai-service/yolov8n.pt`，再找
  `ai-service/weights/yolov8n.pt`，最后才让 ultralytics 自己下
- **CLAHE 预处理**：新增 `_enhance_for_relief(image)`，灰度 + CLAHE 自适应直方图
  均衡化后转 3 通道；汉画像石浮雕拓片必备
- **双跑合并**：`_detections_from_model` 同时跑原图 + CLAHE 增强图，结果按
  IoU 0.55 去重合并，显著降低"什么都没扫到"概率
- **debug 字段**：response 加 `rawDetections` / `classDistribution` /
  `filteredByClass` / `filteredByConf` / `appliedConfThreshold` /
  `enhancedPasses`，前端用来精确诊断
- **默认 conf 0.10**：原 0.25 实测对汉画像石灰度浮雕过严，全部被过滤

前端 `YoloScanDialog`：

- 默认 `classFilter: undefined`（不过滤）+ `confThreshold: 0.10` +
  `maxDetections: 80`
- slider min 改 0.02 step 0.01，能选到极低阈值
- header 文案明确告知 "默认不过滤类别 + 阈值 0.10 + CLAHE 增强双跑"

`App.handleSubmitYoloScan` 在 `detections=0` 时按 debug 字段给**精确原因**：

- `rawDetections=0` → "模型对该图无响应（COCO 通用模型对汉画像石识别困难）"
- `filteredByClass>0` → "扫到 N 个但都不在你勾选类别里。模型实际输出：person×3 dog×2 …"
- `filteredByConf>0` → "扫到 N 个但置信度全低于阈值，把滑杆拉到 0.05 再试"

### 1.3 知识图谱完善（E4）

新建 `frontend/src/modules/annotation/graphMetrics.ts`：

- `computeCentrality(cy, kind)`：包 Cytoscape 自带 4 种中心性算法
  - **PageRank**：被高权重节点指向的节点也高权重（论文最常用）
  - **Degree**：直接邻居最多 = 被最多形象围绕
  - **Betweenness**：处于最多最短路径上 = 桥梁节点
  - **Closeness**：与所有节点平均距离最近 = 群核
- `detectClusters(cy)`：MCL 群组检测（Markov Clustering）

`KnowledgeGraphView` 重写：

- **着色 3 模式**：按层级（原有）/ 按群组（MCL 12 色循环，最大簇是金色 = 叙事核心）/ 按中心度（深褐色→金色渐变）
- **中心节点高亮**：top-5 节点加金色光环 + 加粗描边（`shadow-blur` 18 + `border-width` 4）
- **侧栏排行榜**（`.knowledge-graph-ranking`）：top-8 节点列表 + 群组色点 + 进度条 + 归一化分数；点击直接跳转选中
- **群组聚拢布局**：新增 cluster layout 选项，cose 算法但同簇内 idealEdgeLength=50 + repulsion 280k，跨簇 idealEdgeLength=220 + repulsion 600k；论文式叙事簇可视化
- **节点 size 改用 centrality**：`mapData(centrality, 0, 1, 22, 56)` 替代原本的 degree 映射，封顶 56px
- **中心性算法可切换**：PageRank / Degree / Betweenness / Closeness chip 切换，排行榜同步重排
- toolbar 加 "显示/隐藏排行榜" 按钮 + "群组 N" 节点统计
- 小屏（< 920px）排行榜挪到底部的响应式

### 1.4 日志统一第一人称（E2）

替换以下文件里所有"AI agent / 用户睡觉期间 / 下一个 agent 接手 / agent 自行划定"等表述：

- `docs/WORK_LOG_post_v0.4.0.md` 全文重写
- `docs/WORK_LOG_post_v0.5.0.md` 全文重写
- `docs/RELEASE_NOTES_v0.5.0.md` 头注 + 已知限制
- `docs/RELEASE_NOTES_v0.6.0.md` 头注 + 已知限制
- `README.md` 工作日志链接段

确认 `rg "agent"` 在 `docs/` 下无匹配，全部统一第一人称。

---

## 2. AI 加深（F）

### 2.1 AI 线图扩展（F2）

`ai-service/app/canny.py` 重写为 `_METHOD_DETECTORS` 注册表：

| method | 算法 | 适用场景 |
|---|---|---|
| `canny` | 经典双阈值 | 最快 |
| `canny-plus`（默认） | Canny + 形态学闭运算填补断边 | 汉画像石残损浮雕推荐 |
| `sobel` | Sobel 梯度阈值化 | 对软边缘敏感 |
| `scharr` | Scharr 改进核 | 细节多的浮雕更精细 |
| `morph` | 自适应阈值 + 形态学梯度 | 残损 / 风化更稳，low 当 blockSize 用 |

- `get_lineart_png` 加 `method` 参数；缓存路径加 method 前缀，不同算法各自缓存
- `main.py` 加 `/ai/lineart/methods` 端点列出所有支持的算法
- 前端 `client.ts` 新增 `LineartMethod` 类型 + `lineartMethodOptions`（含 hint）
- `AnnotationWorkspace` 新增"线图参数面板"（layer === "canny" 时显示）：算法 chip 切换 + low/high 滑杆 + 透明度滑杆；morph 算法时 low 改 blockSize 范围（5~51 step 2）

### 2.2 SAM 自动 prompt（F3）

链路：YOLO 找候选位置（recall 高）→ SAM 给精确轮廓（precision 高）。

- `sam.ts` 新增 `refineBBoxWithSam(annotation, stoneId)`：用 annotation.target
  bbox 作为 box prompt 调 `runSamSegmentationBySource`，输出 polygon
- `App.handleRefineWithSam(id)`：单条精修。读 BBox annotation → 调 refineBBoxWithSam →
  patch annotation.target 为 polygon。**保留 label / structuralLevel / 颜色等用户字段**；
  generation.method 改 sam，prompt 加 `refinedFrom: "yolo-bbox"` + 原 box / 原 method 链路
- `App.handleBulkRefineYoloWithSam()`：批量精修所有 reviewStatus=candidate +
  method=yolo + BBox 的候选；串行（CPU SAM 1-2s 一条）
- 单条 + 批量都写一条 method=`sam-refine` 的 processingRun
- `AnnotationPanel ReviewTab` banner 加"SAM 精修全部 YOLO"按钮；`CandidateCard`
  在 YOLO bbox 候选卡片加"SAM 精修"按钮

### 2.3 多解释并存 UI（F1）

新建 `AlternativeInterpretationsView` 组件：

- 检测当前 annotation 是否有 `alternativeInterpretationOf` 关系（双向）
- 展示横向对比卡片（默认折叠，可水平滚动）
- 每张卡片：标签 + 当前标识 + method 来源 chip + 置信度 chip + 证据数 chip +
  三层语义 / 题刻 / 备注
- 点击卡片头跳转到对应 annotation
- 当前 annotation 自己也作为"view 0"并入对比，方便横向看差异
- 挂在 EditTab 里 RelationsEditor 之上

意义：论文 35 ICON 框架强调"多解释并存"是数字研究档案的核心需求 —— 同一画面
形象（比如某只兽）可能被 A 学者读作"青龙"、B 读作"独角兽"、C 读作"应龙"。
v0.6.0 之前只能在关系列表里看到 "alt" 标签，现在能并排对比、判断哪种解释更可信。

---

## 3. 批量任务进度面板（G3）

新建 `TaskProgressPanel` 组件 + `TaskProgress` 类型（status: running/done/failed/cancelled）：

- 右下角浮窗，最多保留最新 6 条任务
- spinner / 进度条 / 取消 / 移除按钮
- App 持有 `tasks` state + `cancelRequestedRef`（Set）
- `upsertTask(task)` 写任务，`requestCancelTask(id)` 标记取消请求，循环里检查 ref 提前 break
- SAM 批量精修走该队列：每条候选更新 progress = i / N + message = "[3/12] 青龙…"

---

## 4. 多资源版本管理（G1）

`types.ts` 新增 `IimlResourceEntry` 类型 + `add/update/delete-resource` 三个 reducer action。

新建 `ResourcesEditor` 组件挂在 ListTab 顶部：

- 列出 `doc.resources`（type chip + URI + 描述 + 删除按钮）
- "添加" inline 表单：8 种类型（Mesh3D / OriginalImage / Rubbing / NormalMap /
  LineDrawing / RTI / PointCloud / Other）+ URI + 可选描述

提示明确告知：**当前画布仍按 3D 模型 / 高清图 双源显示**，其他资源类型仅作
元数据归档（M4 后续做画布资源切换）。

意义：IIML schema 已有但 v0.6.0 之前 UI 不可见的 `resources[]` 字段现在可管。
导出 IIIF / .hpsml 时全部带出，与外部博物馆平台互操作时多源可见。M4 第二
阶段做"画布资源选择 UI + 按 resource 加载图像"时 metadata 已就位。

---

## 5. .hpsml 自定义研究包导出（G2）

`exporters.ts` 新增 `exportToHpsml(doc, relations, options)`：

```ts
type HpsmlPackage = {
  format: "hpsml";
  formatVersion: "0.1.0";
  package: {
    exportedAt: string;
    exporter: string;
    notes?: string;
    generatorRunId: string;
  };
  iiml: IimlDocument;          // 完整 IIML，向后兼容
  context: {
    stone?: StoneListItem;
    metadata?: StoneMetadata;
    relatedAssemblyPlans: AssemblyPlanRecord[];
    vocabulary: { categories, terms };
    networkStats: {
      annotationCount;
      relationCount;
      processingRunCount;
      relationKindBreakdown;
    };
  };
};
```

- `App.handleExportHpsml`：从 `savedPlans` 过滤含当前 stoneId 的拼接方案；
  vocabulary + metadata 直接传当前快照
- AnnotationPanel ListTab 下载区加 `.hpsml` 按钮（与 JSON / CSV / COCO / IIIF 同级）
- 文件名 `<stoneId>-<ts>.hpsml.json`

意义：项目自有的"研究档案完整包"格式。比单导 IIML 更完整 —— 拼接方案、词表
快照、关系网络统计都打包带走，便于多机协作 + 长期归档 + 多版本对照。
解包时拆 `iiml` 字段就是标准 IIML 文档，向后兼容。

---

## 6. commit 时间线

```
d9e38ab feat(annotation): G1 + G2 多资源版本管理 + .hpsml 自定义研究包导出
e1db714 feat(annotation+ai): F1+F2+F3+G3 多解释 UI / 线图扩展 / SAM 自动 prompt / 任务进度面板
ef1a672 feat(annotation+ai): E1-E4 紧急修复 + 图谱完善 + YOLO 优化 + 日志重写
```

整个 v0.7.0 共 3 次 commit（按子项打包）。

---

## 7. 数据兼容

- 历史 IIML 文档没 `resources[]` 字段：按 `[]` 处理；只有显式 add-resource 才落盘
- 老 IIML 的 `resources[]` 缺字段（无 description / acquisition 等）：UI 容错显示
- annotation.target 几何字段名一直是 `target`（IIML schema 与 W3C Web Annotation
  一致），sam.ts / App.tsx 修复了之前误用 `geometry` 的写法
- .hpsml 包 = IIML 超集；外部消费方按 `format === "hpsml"` 识别后取 `.iiml`
  字段就是标准 IIML
- yolov8n.pt（6.5 MB 权重）已加进 `.gitignore`：运行时由 ultralytics 自动下载或
  手动放置

---

## 8. 验收要点

进标注模式后依次试：

1. **保存按钮**：选某标注 → 在标签 / 前图像志输入文字 → 滚动到面板底部 →
   保存按钮应仍然亮（金色），点保存后才变灰
2. **YOLO 检测**：工具栏 Radar 触发 YOLO dialog → 默认 conf 0.10 + 类别全空 →
   开始扫描 → 候选 tab 应有结果（即使 COCO 类与汉画像石不匹配也应能看到 raw
   detection）；如果 detections=0，status 应给精确原因
3. **图谱中心识别**：图谱 tab → 中心性 chip 切到 PageRank → top-5 节点应有
   金色光环 → 着色切到"按群组" → 同簇节点同色（最大簇金色）→ 着色切到
   "按中心度" → 高分节点深金色 → 布局切到"群组聚拢" → 同簇节点抱团
4. **图谱排行榜**：右侧排行榜应列出 top-8 节点 + 进度条；点击跳转选中
5. **SAM 自动 prompt**：先跑 YOLO 拿一批 bbox 候选 → 候选 tab 单条卡片应有
   "SAM 精修"按钮 → 点击后 status 应显示 "SAM 精修中..."  → 完成后 bbox 升级
   为 polygon；banner "SAM 精修全部 YOLO" 应能批量处理
6. **任务进度面板**：批量 SAM 精修时右下角应出现进度面板 → 进度条按 i/N 推进 →
   点"取消"应能在当前候选完成后停止；任务完成后状态变 done / cancelled / failed
7. **多解释 UI**：选两条标注 → 用 RelationsEditor 加 alternativeInterpretationOf
   关系 → 选其中一条 → EditTab 应出现"多视角解释"折叠条 → 展开看到对比卡片
8. **线图算法**：高清图模式 → +线图 → 应出现线图参数面板 → 切换 5 种算法应
   立即看到画布上线图变化
9. **资源版本**：list tab 顶部应有"资源版本"折叠条 → "添加" → 选类型 + URI →
   提交后列表新增一行
10. **.hpsml 导出**：list tab 下载区点 .hpsml → 下载 `<stoneId>-<ts>.hpsml.json` →
    打开看 format/iiml/context 结构正确

---

## 9. 已知限制

- 本次发布所有功能已经过 typecheck，但 **未做浏览器端到端测试**
- YOLO 在汉画像石灰度浮雕上的识别精度仍受限于 COCO 通用模型；CLAHE 双跑只能提升
  recall，**真要精准识别还是需要专门微调汉画像石模型**（M3-2.3 长线项）
- 中心性算法在大图（> 500 节点）上 betweennessCentrality 复杂度 O(N³) 会有
  几秒延迟；当前默认 PageRank 速度可控
- 群组检测 MCL 在某些退化图上会抛错，已 fallback 到连通分量
- 多资源版本管理只做了元数据 UI，**画布资源切换 UI 留 v0.8.0**（需要在 SourceImageView /
  StoneViewer 加资源选择 + 按 resource.uri 加载图像 / 模型，工程量较大）
- .hpsml 解包 / 导入功能（backend/services/hpsml.ts）**未实装**，当前只能导出
- shadow-blur / shadow-color 等 cytoscape 样式属性 TS 类型不全，用了
  `as unknown as cytoscape.Css.Node` 断言

---

## 10. 下一步

详细规划见 [`ROADMAP.md`](ROADMAP.md)。简要：

- **立即 / 1 周内**：v0.7.0 端到端验收 + 修浏览器侧 bug
- **2-4 周（v0.8.0 候选）**：
  - 多资源画布切换：SourceImageView + StoneViewer 接入按 resource 加载
  - 跨资源坐标变换：`coordinateSystem.transform` 字段 + 多资源标注投影
  - .hpsml 解包 / 导入：backend services 加 hpsml.ts
- **长线（v1.0 路线）**：YOLO 微调汉画像石专用模型（需要先用 v0.7.0 的 COCO
  导出积累 1000+ 标注训练集）；多用户协作 provenance；图谱节点 bilinear
  interpolation 群组识别加权

本次 **未打 git tag**，等浏览器端验收完再决定是否打 `v0.7.0` tag。
