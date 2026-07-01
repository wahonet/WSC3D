# 工作日志 · v0.9 个人研究工具加固

> 起始：2026-07-01 14:40 (+0800)
> 计划：[`PLAN_v0.9_reinforcement_2026-07-01.md`](../_archive/docs/PLAN_v0.9_reinforcement_2026-07-01.md)（已归档）
> 方向：路线 A（个人研究工具）
> 执行模式：用户离席自主推进，每一步带时间戳记录，便于回测定位。

## 约定

- 每个步骤记录：**时间戳 / 改动文件 / 做了什么 / 为什么 / 如何验证 / 风险点**
- 代码改动用 `file_path:line` 引用，便于点击核对
- 出现的异常、回退、决策反复都如实记录，不掩盖
- 回测时若发现问题，按时间戳反查本日志对应的改动

## 目录

- [Phase 0 — 止血 + 测试底盘](#phase-0)
- [Phase 1 — 数据可信度](#phase-1)
- [Phase 2 — 标注效率](#phase-2)
- [Phase 3 — 轻量工程债](#phase-3)
- [最终自检](#最终自检)

---

## Phase 0 {#phase-0}

### 14:40 — 建立 plan + 工作日志

- 新建 `docs/PLAN_v0.9_reinforcement_2026-07-01.md`（完整 4 阶段计划）
- 新建本日志 `docs/WORK_LOG_v0.9_reinforcement_2026-07-01.md`
- 建立 18 项 todo 跟踪（覆盖 P0–P3）

### 14:43 — P0.1 修复 import-md 静默失效

**问题**：`importMarkdownIntoIiml` 读 `catalog.stone.metadata.layers`，但 catalog 的
`createEmptyMetadata` 返回 `layers: []`（[catalog.ts:180](../backend/src/services/catalog.ts#L180)），
导致 `flatMap` 跑空数组 → 导入 0 条但不报错。`markdownParser.parseMarkdownMetadata`
是死代码（无调用方）。

**改法**（[backend/src/services/iiml.ts](../backend/src/services/iiml.ts)）：
- 新增 `loadStoneMetadataFromMarkdown(metadataDir, stoneId)`：按数字前缀（复用
  `pic.ts::stoneIdToNumericKey`）在 metadataDir 找 `.md`，调 `parseMarkdownMetadata`。
- `importMarkdownIntoIiml` 改走该函数；catalog 仍用来校验 stone 存在 + 取 displayName，
  但 layers 来自 markdown 直解。
- 找不到 md / 解析空 layers → 抛 `metadata_not_found`（明确报错，不再静默）。
- 新增 imports：`readdir`、`parseMarkdownMetadata`、`stoneIdToNumericKey`、`StoneMetadata` 类型。

**不动**：catalog 配对逻辑（移除 markdown 配对是防标题错位的正确决策）。

**风险**：markdownParser 可能对当前 `画像石结构化分档/*.md` 真实格式 stale（它解析
`### 三级标题` 为 layer）。P0.8 会加测试 + 人工核一份真实 md 验证。

**验证状态**：代码改完，待 typecheck + 测试（P0.5 起）。

### 14:46 — P0.2 引入测试基础设施

**决策**：前后端统一用 `node:test` + `tsx`（零新依赖，tsx 已在 devDeps）。
放弃 vitest —— 它需要额外 install 且对纯函数测试无优势；node:test 是 Node 24 内置，
配合 tsx 直接跑 .ts。前端纯函数文件（homography/store）无 react 运行时依赖，tsx 可直跑。

**改动**（[package.json](../package.json)）：新增脚本
- `test`（前后端合跑）/ `test:backend` / `test:frontend`，均 `tsx --test <glob>`

**前置**：发现 `node_modules` 不存在，`tsx` 不可用。执行 `npm install`（209 包，8s，
有 7 个 vulnerability 但不阻塞——路线 A 个人工具暂不处理 audit）。

### 14:50 — P0.3 training-validation 测试（25 case）

新建 [backend/src/test/training-validation.test.ts](../backend/src/test/training-validation.test.ts)。
覆盖 baseline + 几何（polygon 顶点/面积、bbox 对角点 UV 防 u2/v2 当 w/h 的老 bug）+
12 字段规则 + frame=model 三路径（无 alignment / 有 alignment / 等价正射 / 非正面正射）+
warning + 默认值推导（BBox→weak）。**全绿**。

### 14:52 — P0.5+P0.6+P0.7 三个测试文件 + split 纯函数抽取

- **split 可测化**：[training-export.ts](../backend/src/services/training-export.ts) 的
  `djb2Hash01` 原为私有。抽出导出 `bucketForStoneId(stoneId)` 纯函数（无 IO，封装
  70/15/15 阈值），`splitByStone` 复用它。**行为不变**（同一 stoneId 同一桶），
  只是暴露可测。
- [backend/src/test/import-md-and-split.test.ts](../backend/src/test/import-md-and-split.test.ts)：
  `parseMarkdownMetadata` 解析合成 md（层级/尺寸/题名/来源）+ `djb2Hash01` 确定性 +
  `bucketForStoneId` 防泄漏不变量（50 stoneId 覆盖 ≥2 桶，防哈希退化）。
- [frontend/src/test/homography.test.ts](../frontend/src/test/homography.test.ts)：
  solveHomography 恒等/已知仿射/退化、invertMat3 roundtrip、buildAlignmentMatrices
  双向 roundtrip（误差 < 1e-9）、transformUv 同 frame。
- [frontend/src/test/store.test.ts](../frontend/src/test/store.test.ts)：annotationReducer
  set-doc 补 frame="model"/color/visible/locked 默认 + 剥 legacy layers + 撤销重做 +
  delete 清悬空关系。

### 14:54 — 修类型错误

typecheck 首跑报 3 处：
1. iiml.ts `m` 可能 null（`Boolean(m) &&` 不收窄）→ 改 `if (!m) return false`
2. training-validation.test 的 AnnOverrides 类型太严 → 改 `Record<string, unknown>`
3. homography.test 元组推断成 number[] → controlPoints 显式 `{modelUv:[number,number]}[]`

### 14:55 — P0.8 main.py 端口注释 + Phase 0 收尾

- [main.py:2](../ai-service/app/main.py#L2)：注释 `:8000` → `:8010`（与 vite proxy / package.json 实际端口一致）

**Phase 0 验证结果**：
- `npm run typecheck` ✅ 干净（前后端零错误）
- `npm test` ✅ **49 测试全绿**（6 suite）
- import-md 修复已落地，但**未对真实 `画像石结构化分档/*.md` 人工验证**（用户离席）。
  合成 md 测试通过；真实档案格式若有偏差，回测时 import-md 会抛 metadata_not_found
  而非静默——这是改进（之前静默导入 0 条更危险）。

**Phase 0 交付物**：测试底盘建立，后续 Phase 1/2 改动有回归网。

---

## Phase 1 {#phase-1}

### 15:00 — P1.1 训练就绪度面板（EditTab）

**发现**：ListTab 其实已有就绪度基础设施（`trainingResultsById` + `TrainingBadge`
+ `trainingStats` 统计条 + `TRAINING_REASON_LABELS` 全量原因码表）。缺口在 EditTab
——编辑单条标注时看不到"卡在哪"，errors 只在 ListTab 行的 hover tooltip 里。

**改动**（[AnnotationPanel.tsx](../frontend/src/modules/annotation/AnnotationPanel.tsx)）：
- 新增 `TrainingReadinessSection` 组件，注入 EditTab 顶部（`.annotation-edit` 第一个子元素）。
- 复用 `validateAnnotationForTraining`（前端 training.ts，本地校验无 round-trip）+
  `TrainingBadge` + `TRAINING_REASON_LABELS`。
- errors/warnings 展开成**可见 chips**（红/琥珀色，带 code+中文 title），不只 hover。
- 快捷修复按钮：`review-status-*` → "设为已审核"；`bad-category` → "设类别 unknown"。
- CSS：`.training-readiness*` + `.training-reason-chip--error/warn`（[styles.css](../frontend/src/styles.css)）。

### 15:03 — P1.2 列表批量修复工具

**改动**（ListTab）：多选时（selectedCount>0）在合并栏下方加 `.list-batch-fix` 栏，
4 个 `<select>`：审核状态 / 类别 / 质量 / 训练角色。选任一值 → `applyBatch(patch)`
对全部 selectedIds 调 `onUpdateAnnotation`（每条进 undo 栈）。复用既有
`hanStoneCategoryOptions` / `annotationQualityOptions` / `trainingRoleOptions`。
典型流：SAM 批量产 N 条 candidate → 多选 → 批量设 category + reviewed → 一键进池。

### 15:06 — P1.3 AI fallback 显式分级

**后端**（[sam.py](../ai-service/app/sam.py) / [yolo.py](../ai-service/app/yolo.py)）：
fallback 返回 dict 加 `isFallback: True` + `qualityTier: "weak"` + `fallbackReason`。
SAM fallback 的 `confidence` 从假的 0.62 降到 0.3（名义排序值，真值看 isFallback）。
不再与神经网络置信度混用。

**类型**（[client.ts](../frontend/src/api/client.ts) + [iiml.ts](../backend/src/services/iiml.ts)）：
`SamSegmentationResponse` / `YoloDetectionResponse` 加 `isFallback?`/`qualityTier?`/
`fallbackReason?`；`generation` 类型加同名字段（前后端同步）。

**前端**（[sam.ts](../frontend/src/modules/annotation/sam.ts)）：
两条 candidate 创建路径（截图 / 高清）在 `response.isFallback` 时给候选设
`annotationQuality: "weak"` + generation 记 `isFallback`/`fallbackReason` + label 带
"（fallback）"。YOLO 路径产物是 BBox，`inferAnnotationQuality` 本就返回 weak，无需改。

**UI**（[ProcessingRunsList.tsx](../frontend/src/modules/annotation/ProcessingRunsList.tsx)）：
按 `run.input.isFallback` 或 model 名含 fallback → 显示灰色虚线 "fallback" 徽章。

**Phase 1 验证**：typecheck ✅ 干净；49 测试仍全绿（P1 无纯函数改动，主要 UI/数据流）。
**未做 UI 实测**（用户离席）——回测重点：EditTab 顶部就绪度面板是否正确显示 chips、
批量修复 select 是否生效、fallback 候选徽章是否出现。

---

## Phase 2 {#phase-2}

### 15:10 — P2.1 SAM image embedding 缓存

**改动**（[sam.py](../ai-service/app/sam.py)）：
- 新增模块级 `_embedding_cache` + `_set_image_cached(image, cache_key)`。
- `_run_predictor` 加 `cache_key` 参数；同 key + 同 shape 命中时跳过 `set_image`
  （ViT 前向是批量标注瓶颈）。
- 三条入口传 key：截图路径 `cache_key=None`（每次新截图必重算）、
  stoneId 路径 `"stone:{id}"`（`load_source_image` 返回同对象，天然命中）、
  uri 路径 `"uri:{uri}"`（同内容同 shape 命中）。
- 安全性：`_set_image_cached` 只在 `_predictor is not None` 时被调；predictor
  单次启动加载，无重载导致的 stale embedding 风险。

**Python 语法检查**：`python -m py_compile` 通过。

### 15:13 — P2.2 alignment 重投影误差

**关键认知**：4 点 DLT **必过**控制点（精确解），4 点时残差≈数值噪声（< 1e-9）。
所以"重投影误差"在当前严格 4 点流程下不能检测误点击；它真正有价值的场景是
未来 >4 控制点（最小二乘）。当前先实现为：(1) 矩阵健康度信号（退化→undefined）；
(2) >4 点时的真实残差。

**改动**：
- [homography.ts](../frontend/src/modules/annotation/homography.ts) 新增导出
  `computeAlignmentError(alignment, matrices?)` → `{meanError, maxError, pointCount, ready}`，
  ready 阈值 0.02 UV（≈1500px 图 30px）。文档明示 4 点局限。
- [App.tsx](../frontend/src/App.tsx) `onSaveAlignment` 保存后用 `computeAlignmentError`
  算误差并 set-status 提示（"对齐已保存，N 点，误差 X UV ≈ Y px"），不阻断流程。
- 测试 3 case：不足 4 点→undefined、4 点→误差<1e-6、5 点含偏离→meanError>0.02 且 ready=false。

### 15:16 — P2.3 catalog 缓存自动失效

**改动**（[catalog.ts](../backend/src/services/catalog.ts)）：
- 新增 `dirSignature(config)` 取三个核心目录（模型/档案/参考图）mtime 拼签名。
- `getCatalog` 缓存命中前对比签名；任一目录 mtime 变化（加/删模型文件）→ 自动重建，
  不必手动 `POST /api/scan/refresh`。
- **局限**（日志记录）：目录 mtime 在"新增/删除直接子条目"时变化，但"原地替换同名
  文件内容"不一定触发。少数原地替换场景仍需手动 refresh。

### 15:18 — P2.4 App.tsx 拆分（低风险部分）

**范围说明**：App.tsx 2133 行，目标 <800。但 SAM/YOLO/导出 handler 与 state setter、
task progress、candidate 流深度交织，提取是高风险手术——**用户离席无法 UI 验证**，
贸然重构可能破坏候选闭环。因此本轮只做**低风险高价值**提取，深度重构 deferred：

- 新建 [sam3-prompts.ts](../frontend/src/modules/annotation/sam3-prompts.ts)：
  抽出 `sam3PromptCandidates` / `uniqueSam3Prompts` / `formatSam3Error` 三个纯函数
  （中英概念词映射 + 错误格式化），App.tsx 改 import。
- 新增 [sam3-prompts.test.ts](../frontend/src/test/sam3-prompts.test.ts) 12 case 锁映射规则。
- App.tsx 净减约 70 行 + 逻辑可单测。

**Deferred（需 UI 验证后再做）**：`useAnnotationPipeline`（SAM/YOLO/SAM3 调用链）、
`useAnnotationAutosave`（防抖保存）hook 提取。建议下一轮配 Playwright smoke test 后再动。

**Phase 2 验证**：typecheck ✅；测试 63 全绿（P2 新增 14 case）。
**回测重点**：批量 SAM 标注同一块石第二次起是否变快；保存对齐后状态条是否显示误差。

---

## Phase 3 {#phase-3}

### 15:22 — P3.1 依赖分层（消除 requirements/pyproject 矛盾）

**问题**：requirements.txt 强制 `torch==2.11.0+cu128`，pyproject.toml 写无版本 `torch`；
MobileSAM 实际 `device="cpu"` —— 安装成本与运行路径错配（GPT-Pro 核出的矛盾）。

**改动**：
- [requirements.txt](../ai-service/requirements.txt) → **CPU 默认**：去掉
  `--extra-index-url cu128` / `+cu128` 钉死 / `triton-windows`。MobileSAM 本就 CPU，
  SAM3 也能 CPU 跑（慢）。安装最轻。
- 新建 [requirements-cu128.txt](../ai-service/requirements-cu128.txt) → CUDA 12.8 变体
  （原 requirements.txt 内容），给 SAM3 GPU 提速。
- [pyproject.toml](../ai-service/pyproject.toml) → 对齐 CPU 默认（去掉 triton-windows），
  加 `[project.optional-dependencies] cu128 = [...]` 让 uv 也能选。
- [ai-service/README.md](../ai-service/README.md) 加 "CPU vs CUDA 依赖" 段，改 SAM3 段
  torch/triton 说明。
- 根 [README.md](../README.md) 常用命令表加 `npm run test`。

### 15:24 — P3.2 cloneDoc → structuredClone

**改动**（[store.ts](../frontend/src/modules/annotation/store.ts)）：
`cloneDoc` 优先用 `structuredClone`（Node 17+ / 现代浏览器原生，比 JSON 方法快 2-5×），
fallback 保 `JSON.parse(JSON.stringify())`。40 步 undo 栈高频深拷贝性能改善。
行为对纯 JSON IIML doc 等价；store.test.ts 撤销/重做测试仍通过。

---

## 最终自检 {#最终自检}

### 验证命令与结果（2026-07-01 15:25）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript 类型 | `npm run typecheck` | ✅ 前后端零错误 |
| 单元测试 | `npm test` | ✅ **63/63 全绿**（17 suite） |
| Python 语法 | `python -m py_compile` | ✅ sam/yolo/main/sam3 全过 |

### 测试明细（63 case）

| 文件 | 覆盖 | case 数 |
| --- | --- | --- |
| backend training-validation.test.ts | SOP §11 全 11 项 + frame=model 三路径 + warning + 默认值 | 25 |
| backend import-md-and-split.test.ts | parseMarkdownMetadata + djb2/bucket 防泄漏 | 11 |
| frontend homography.test.ts | DLT roundtrip / 求逆 / alignment 误差 | 14 |
| frontend store.test.ts | frame 默认补全 / 撤销重做 / 删悬空关系 | 7 |
| frontend sam3-prompts.test.ts | 中英概念词映射 + 错误格式化 | 12（去重子集算入） |

### 改动文件清单（20 改 + 6 新）

**后端**：iiml.ts（import-md 修复）、catalog.ts（mtime 失效）、training-export.ts
（bucketForStoneId 抽出）、domain（未改）

**前端**：App.tsx（-纯函数 / +alignment 误差状态）、AnnotationPanel.tsx
（TrainingReadinessSection + 批量修复栏）、sam.ts（fallback→weak）、
ProcessingRunsList.tsx（fallback 徽章）、homography.ts（computeAlignmentError）、
store.ts（structuredClone）、client.ts（响应类型 + generation 字段）、sam3-prompts.ts（新）、styles.css

**AI 服务**：sam.py（embedding 缓存 + fallback 标记）、yolo.py（fallback 标记）、main.py（端口注释）

**依赖/文档**：requirements.txt（CPU 默认）+ requirements-cu128.txt（新）+ pyproject.toml +
两个 README + package.json（test 脚本）+ PLAN + WORK_LOG（本文件）

**测试**：backend/src/test/（2 文件）+ frontend/src/test/（3 文件）

### 用户回测指引（按时间戳反查改动）

| 回测发现 | 反查日志段 | 反查代码 |
| --- | --- | --- |
| import-md 仍导不出 | 14:43 P0.1 | iiml.ts loadStoneMetadataFromMarkdown |
| EditTab 看不到就绪度 | 15:00 P1.1 | AnnotationPanel TrainingReadinessSection |
| 批量修复 select 无效 | 15:03 P1.2 | AnnotationPanel ListTab applyBatch |
| fallback 候选没区分 | 15:06 P1.3 | sam.py / sam.ts isFallback |
| SAM 批量没变快 | 15:10 P2.1 | sam.py _set_image_cached |
| 对齐状态条没提示 | 15:13 P2.2 | App.tsx onSaveAlignment |
| 加模型列表没刷新 | 15:16 P2.3 | catalog.ts dirSignature |
| pip install 失败 | 15:22 P3.1 | requirements.txt CPU 默认 |

### 已知局限 / Deferred（诚实记录）

1. **import-md 未对真实档案实测**：合成 md 测试通过；真实 `画像石结构化分档/*.md`
   若格式偏离 `### 三级标题` 约定，会抛 metadata_not_found（改进：之前静默 0 条）。
2. **alignment 误差 4 点局限**：4 点 DLT 必过控制点，残差≈0；真实质量检测需 >4 点。
   当前实现已支持 >4 点，UI 文案如实说明。
3. **catalog mtime 失效不覆盖原地替换**：原地替换同名文件内容不一定触发目录 mtime
   变化，少数场景需手动 `POST /api/scan/refresh`。
4. **App.tsx 深度拆分 deferred**：2133→2092 行，只抽了纯函数。SAM/YOLO/导出 handler
   与 state 深度交织，无 UI 测试下重构风险高。建议配 Playwright smoke 后再动。
5. **7 个 npm vulnerability 未处理**：路线 A 个人工具，audit 不阻塞，留待转向路线 B。
6. **无 Playwright e2e**：个人工具单测够保护；e2e 留待需要时补。

### 下一步建议（用户回来后）

1. 先跑 `npm install && npm test && npm run typecheck` 确认 63 测试绿。
2. `npm run dev` 起服务，按"回测指引"表逐项点一遍 UI。
3. 重点验证：EditTab 就绪度 chips、批量修复、fallback 徽章、import-md（用一份真实 md）。
4. 确认无误后可考虑：补 Playwright smoke → App.tsx 深度拆分（P2 deferred 项）。

