# WSC3D v0.9.0 — 数据可信度加固 · 训练就绪度面板 · 列表批量修复 · AI fallback 分级 · SAM embedding 缓存 · 单元测试底盘

> 发布日期：2026-07-01
> 上一发布：[`v0.8.0`](RELEASE_NOTES_v0.8.0.md) — 图谱 UI 修缮 · 资源独立 tab · 三维生成正射图 · 多资源画布切换 · 跨资源坐标变换 · `.hpsml` 解包

v0.8.0 之前一直在加功能，到这一版功能链已经基本齐了：浏览、拼接、标注、AI 候选、
关系图谱、训练池导出都跑得通。v0.9.0 不再扩功能，而是回头把"数据可信度"和"工程
地基"做扎实——每条标注能不能进训练池、为什么不能、怎么一键修；AI 兜底产出的候选
不能混在真神经网络置信度里；纯函数要有回归网，不能改一个小地方就出隐蔽 bug。

一句话：**从"功能验证型"转向"数据质量型"**。

工作日志（每一步带时间戳）：[`WORK_LOG_v0.9_reinforcement_2026-07-01.md`](WORK_LOG_v0.9_reinforcement_2026-07-01.md)。

---

## 1. 修复 import-md 静默失效

`POST /api/iiml/:stoneId/import-md`（从结构化档案导入标注）一直是个隐形坑：它依赖
catalog 里的 `metadata.layers`，但 catalog 为了防止旧档案标题错位、早就不再解析
Markdown 了，`layers` 恒为空数组。结果接口不报错（因为 metadata 对象存在），但
`flatMap` 跑空数组，**导入 0 条，看起来成功实际没干活**。

这一版在 [iiml.ts](../backend/src/services/iiml.ts) 加了 `loadStoneMetadataFromMarkdown`，
按 stoneId 数字前缀直接去 `画像石结构化分档/` 找 `.md` 文件、用 markdownParser 解析，
不再绕 catalog。找不到档案、或解析不出层级时**抛 `metadata_not_found`**，不再静默。
catalog 的配对逻辑保持不动（那个防标题错位的决策是对的）。

---

## 2. 单元测试底盘（63 个用例）

之前全仓没有一个测试。这一版用 `node:test` + `tsx`（零新依赖，tsx 已经在 devDeps 里）
铺了测试底盘，前后端统一跑 `npm test`。覆盖的都是最容易改出隐蔽 bug 的纯函数：

- **training-validation**（25 例）：SOP §11 的 11 项准入硬约束逐条触发，frame=model
  的三条路径（无对齐 / 有 4 点对齐 / 命中等价正射图），以及默认值推导（BBox 默认 weak 等）。
- **import-md + split**（11 例）：Markdown 解析契约 + djb2 哈希划分的**防泄漏不变量**
  （同一 stoneId 恒定映射到同一桶，50 个 stoneId 至少覆盖两个桶，防哈希退化全进 train）。
- **homography**（14 例）：4 点 DLT roundtrip、矩阵求逆、双向投影回到原点、退化（共线）
  返回 undefined、重投影误差。
- **store**（7 例）：历史 IIML 加载时补 `frame="model"` / 颜色 / 可见性默认、剥 legacy
  字段、撤销重做、删标注同时清悬空关系。
- **sam3-prompts**（6 例）：中英概念词映射（人物→human figure 等）+ 错误格式化。

为了能测训练池划分，把 [training-export.ts](../backend/src/services/training-export.ts)
里的 `djb2Hash01` 和分桶逻辑抽成了导出的纯函数 `bucketForStoneId`，行为不变。

---

## 3. 训练就绪度面板（编辑面板实时反馈）

之前的问题是：编辑时很宽松（schema 允许 additionalProperties），导出训练池时却突然
大批失败，标员不知道自己哪条标注卡在哪。

这一版在标注编辑面板顶部加了**训练就绪度面板**（[AnnotationPanel.tsx](../frontend/src/modules/annotation/AnnotationPanel.tsx)
的 `TrainingReadinessSection`）：

- 复用前端 `training.ts` 的本地校验（无后端 round-trip，标注时实时算）；
- 每条标注显示 ✓ 进池 / ⚠ 进池但有警告 / ✗ 进不了三档徽章；
- 把失败原因展开成**可见的彩色 chips**（红=error、琥珀=warning），每条带原因码和中文
  说明，不只是 hover tooltip；
- 对最常见的两类问题提供一键修复：`review-status-*` → "设为已审核"；
  `bad-category` → "设类别 unknown"。

列表 tab 的整石统计（ready / warned / blocked）和列表行的 TrainingBadge 沿用 v0.8 的，
这次主要补的是**编辑单条时**的反馈。

---

## 4. 列表批量修复

列表 tab 多选标注后，原本只能做几何合并。这一版在合并栏下面加了**批量修复栏**，
4 个下拉：审核状态 / 类别 / 质量 / 训练角色，选一个就对所有选中标注批量设字段。

典型用法：SAM 一次产出 20 条 candidate → 列表多选 → 批量设类别 + 批量设"已审核" →
20 条一次性从"进不了池"变成"可训练"。每条改动都进 undo 栈，操作可回退。

---

## 5. AI fallback 显式分级

SAM/YOLO 在权重没下载好、或推理失败时会退回 OpenCV Canny 轮廓兜底，保证流程不断。
但兜底产出的候选之前返回的是 `confidence: 0.62`、`model: "...-fallback-contour"`，
**这个 0.62 不是神经网络置信度**，混在真候选里容易让人误判质量。

这一版的处理：

- **AI 服务**（[sam.py](../ai-service/app/sam.py) / [yolo.py](../ai-service/app/yolo.py)）：
  fallback 返回值加 `isFallback: True` + `qualityTier: "weak"` + `fallbackReason`，
  confidence 改成名义低值（不再用假的 0.62）。
- **类型**（前后端 `generation` 字段）：加 `isFallback` / `fallbackReason` / `qualityTier`。
- **前端**（[sam.ts](../frontend/src/modules/annotation/sam.ts)）：fallback 候选自动设
  `annotationQuality: "weak"`，标签带"（fallback）"。
- **处理记录面板**（[ProcessingRunsList.tsx](../frontend/src/modules/annotation/ProcessingRunsList.tsx)）：
  fallback 的 run 显示灰色虚线 "fallback" 徽章，和真神经网络候选区分开。

这样人审升级 reviewStatus 后，fallback 标注仍保留 weak 标记，训练导出时 gold/silver
池不会收，避免低质量兜底轮廓污染训练集。

---

## 6. SAM image embedding 缓存

批量标注同一块石头时，每次 prompt 都要重跑一次 `set_image`（MobileSAM 的 ViT 前向），
这是最大的耗时瓶颈。实际上同一张图的 embedding 是可以复用的。

这一版在 [sam.py](../ai-service/app/sam.py) 加了 `_embedding_cache` + `_set_image_cached`：
按 `cache_key`（stoneId / 资源 URI）+ 图像 shape 命中时跳过 `set_image`，第二次起同一块
石头的 prompt 只做轻量的 mask decode。截图路径（每次新截图）不缓存。`load_source_image`
本来就对同 stoneId 返回同一数组对象，shape 比对很便宜。

---

## 7. 对齐重投影误差 + catalog 自动失效

两个小但实在的改进：

- **对齐重投影误差**（[homography.ts](../frontend/src/modules/annotation/homography.ts)）：
  新增 `computeAlignmentError`，保存 4 点对齐时算一次重投影残差显示在状态条上
  （"对齐已保存，4 点，误差 0.0003 UV ≈ 0 px"）。需要说明的局限：4 点 DLT 必过控制点，
  所以 4 点时残差≈数值噪声，真正反映标定质量要等以后支持 >4 控制点（函数已经支持）。
- **catalog 自动失效**（[catalog.ts](../backend/src/services/catalog.ts)）：之前加了新模型
  必须手动 `POST /api/scan/refresh` 才能刷出来。现在缓存时记下三个核心目录的 mtime 签名，
  下次请求对比，任一目录 mtime 变了（加/删模型文件）就自动重建。

---

## 8. 依赖分层 + 工程小修

- **CPU / CUDA 依赖分开**：之前 `requirements.txt` 强制 `torch==2.11.0+cu128`，但
  MobileSAM 实际跑在 CPU 上，无 CUDA 的机器装不动。这一版 `requirements.txt` 改 CPU
  默认（去掉 +cu128 钉死和 triton-windows），新建 `requirements-cu128.txt` 给 SAM3 GPU
  提速用，`pyproject.toml` 对齐并加 `[optional-dependencies] cu128`。
- **cloneDoc → structuredClone**：撤销栈的深拷贝从 `JSON.parse(JSON.stringify())`
  换成原生 `structuredClone`（带 JSON fallback），40 步 undo 高频拷贝下更快。
- **App.tsx 抽纯函数**：把 SAM3 概念词映射、错误格式化抽到 [sam3-prompts.ts](../frontend/src/modules/annotation/sam3-prompts.ts)，
  配测试锁住映射规则。深度拆分（handler 提取成 hook）留给以后配 Playwright e2e 再动。
- **main.py 端口注释**：从 `:8000` 改成 `:8010`，和实际运行端口一致。

---

## 验证

- `npm run typecheck` ✅ 前后端零错误
- `npm test` ✅ 63/63 全绿（17 个 suite）
- `python -m py_compile` ✅ 改过的 Python 文件全部通过

## 下一版可能的方向

- 画布上的跨资源投影（读 `resource.transform` 把标注直接投影到当前底图）；
- 配 Playwright 端到端测试后，把 App.tsx 的 SAM/YOLO/导出 handler 深度拆成 hook；
- 用积累的 COCO 导出微调一个汉画像石专用检测器；
- AI 线图接入 HED / Relic2Contour 深度学习方法。
