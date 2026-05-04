# v0.5.0 之后的连续推进工作日志（v0.6.0）

> 在 2026-05-04 上午 11:49 开工。v0.5.0 验收没问题，趁着思路顺接着把
> ROADMAP 里 M3 收尾 + M4 起步那批做掉。每完成一个小节点追加一段，
> 包含：做了什么 / 下一步打算 / 实现方式。
>
> **下次回来续做时优先读本文件 + WORK_LOG_post_v0.4.0.md**。
>
> 主分支：`main` · 远程：`https://github.com/wahonet/WSC3D.git` · 代理：`http://127.0.0.1:18081`
>
> 起点 commit：`2f46c23` (docs(v0.5.0): release notes + README + ROADMAP + 工作日志收尾)

---

## 0. 整体计划与范围

按 ROADMAP `M3 剩余` + `M4 起步` + `工程闭环`，本次 v0.6.0 范围如下：

### 主线 D — M3 收尾 + 学术导出 + 工程小修

按"价值高 / 风险低 / self-contained"排序：

- **D1** 知识图谱关系筛选 / 高亮（kind + origin chip 过滤）
- **D2** Cytoscape 大图性能优化（layout 切换 + 节点 size 按度数）
- **D3** SAM processingRuns 写入 IIML（学术溯源关键字段）
- **D4** AI 处理记录 section（详情面板可折叠展示 processingRuns）
- **D5** StoneViewer lazy 加载（主 chunk < 600 KB 收尾）
- **D6** 共现术语推荐（基于已有 annotation.terms 统计）
- **D7** COCO JSON 导出（最简单的 ML 训练数据格式）
- **D8** IIIF Web Annotation 导出（学术互操作）

### 跳过项（理由）

- **多解释并存 UI 专项**：UI 复杂度大，需要先把交互细节想清楚；alternative
  Interpretation 关系字段已支持，留 v0.7.0 做专门 tab
- **多资源版本切换 (M4-3.1)**：架构改动大（`coordinateSystem.transform`），
  需要先有 RTI / 拓片 / 法线图等真实资源；当前只有原图，做了空架子用处不大
- **Playwright 端到端**：需要稳定 dev server + ai-service，离线不好验证；
  留给在线时统一覆盖
- **YOLO 微调汉画像石专用模型**：需要 1000+ 标注训练集 + 算力，本轮
  做不动

### 操作纪律（与 v0.5.0 一致）

每个子节点：
1. typecheck 全绿
2. `git commit -F .git/COMMIT_EDITMSG_DRAFT`（用文件做 message，避免 PowerShell here-doc 问题）
3. `git -c http.proxy=http://127.0.0.1:18081 -c https.proxy=http://127.0.0.1:18081 push origin main`
4. 工作日志追加一段
5. 删 `.git/COMMIT_EDITMSG_DRAFT`

整体收尾：写 `RELEASE_NOTES_v0.6.0.md`，更新 `README.md` + `ROADMAP.md`。
**不打 git tag**，等版本审过再决定。

---

## 时间线

### 2026-05-04 11:49 · 起点（v0.5.0 验收完成）

工作树 clean。`origin/main` HEAD = `2f46c23`。

下一步：开始 **D1 — 知识图谱关系筛选 / 高亮**。

---

### 2026-05-04 12:05 · D1 完成 — 知识图谱关系筛选

**commit**: `c35c5c1` (feat(annotation): D1 知识图谱关系筛选 / 高亮（kind + origin chip）)

**做了什么**

- KnowledgeGraphView 在 toolbar 与 canvas 之间加一行筛选 chip
- 类别 chip：4 组（叙事 / 层级 / 空间 / 解释）
- 来源 chip：仅显示 doc 中实际出现的 origin（避免空"AI"等无意义选项）
- chip toggle 多选 OR；空集合 = 不过滤；"清除过滤" 链接

**怎么实现的**

- 边 data 新增 kind / origin 字段
- 过滤 useEffect 按 chip 状态批量刷 .is-faded class（cy.batch 包裹）
- .is-faded 不隐藏只淡化（opacity 0.12），保持空间稳定，便于回切对比
- 内容指纹（annotationsKey + relationsKey）变化也触发刷过滤，避免新边未应用

**下一步**

进入 **D2 — Cytoscape 大图性能优化**：layout 切换 + 节点 size 按度数。

---

### 2026-05-04 12:20 · D2 完成 — 知识图谱 layout + 节点尺寸

**commit**: `61c4f60` (feat(annotation): D2 知识图谱 layout 切换 + 节点 size 按度数)

**做了什么**

- layout 4 选：cose / concentric / breadthfirst / grid；点 chip 直接
  cy.layout().run() 不重建图
- 节点数 > 100 时默认 grid（cose 慢）；阈值跨越自动切回推荐 layout
- 节点 size 按 degree 动态：`mapData(degree, 0, 12, 22, 50)`
- buildLayoutOptions(name) 封装 4 套配置，未来加 dagre / klay 只动一处

**怎么实现的**

- 节点 data 加 degree 字段（init 时算 source/target 出现次数）
- mapData 是 cytoscape selector 字符串 DSL，TS 类型 number 用 unknown 中转
- layout 切换通过 handleLayoutChange → cy.layout().run()，不进 useEffect
  依赖（用 eslint-disable 注释说明）
- 布局 chip 与 kind chip 同色系区分，避免视觉混乱

**下一步**

进入 **D3 — SAM / YOLO processingRuns 写入 IIML**：

- IIML schema 已有 processingRuns: Array<Record<string, unknown>>
- 每次 SAM 调用后追加一条 record：{ method, model, timestamp, prompt 摘要,
  outputAnnotationId, confidence }
- App.tsx handleSubmitYoloScan 同样写入
- 详情面板下一节 D4 做"AI 处理记录" section 展示

---

### 2026-05-04 12:40 · D3 完成 — processingRuns 写入

**commit**: `b2b2808` (feat(annotation): D3 SAM / YOLO processingRuns 写入 IIML（学术溯源）)

**做了什么**

- IimlProcessingRun 类型上线（id / method / model / input / output /
  confidence / resultAnnotationIds / resourceId / frame / startedAt /
  endedAt / warning? / error?）
- IimlDocument.processingRuns 类型收紧
- store reducer 加 add-processing-run，走 updateDoc 进 undo 栈
- AnnotationCanvas submitSamPrompts 在 finally 报一条 SAM run（成功/失败都报）
- App.tsx handleSubmitYoloScan finally 报一条 YOLO run，含全部
  resultAnnotationIds
- 新增 getProcessingRuns(doc) 防御读

**怎么实现的**

- onProcessingRun callback 模式：AnnotationCanvas → AnnotationWorkspace →
  App.tsx dispatch；与 onCreate / onProcessingRun 同形态，最少改动
- prompt 摘要不存全部坐标避免 doc 膨胀；坐标已在
  annotation.generation.prompt 完整保留
- error 字段统一 fallback：Error.message / String(unknown) / "no-candidate"
- YOLO 区分 no-detection 写 warning，真异常写 error

**下一步**

进入 **D4 — AI 处理记录 section**：

- AnnotationPanel EditTab 末尾加可折叠的"AI 处理记录"
- 列出 processingRuns（按 endedAt 降序）：method · model · 时间 · 状态 ·
  产出几个 annotation（点击跳转）
- 失败 / 无产出的 run 用浅红显示

---

### 2026-05-04 13:00 · D4 完成 — AI 处理记录 section

**commit**: `9c180aa` (feat(annotation): D4 AI 处理记录 section（详情面板可折叠展示）)

**做了什么**

- 新建 ProcessingRunsList 组件：默认折叠的"AI 处理记录"
- 选中 annotation 时只列"产生过该标注的 run"（按 endedAt 降序）
- 每条 run：method 徽章 + model 等宽字体 + 相对时间 + 置信度 + 输入摘要
  + 产出 chip（点击跳转）+ warning / error
- 失败 / 无产出 run 浅红条
- 输入摘要格式化：SAM `+N -M 框 高清图 image` / YOLO `阈值 类别 image`

**怎么实现的**

- formatRelativeTime：< 1 分钟 = "刚刚"，< 1 小时 = "X 分钟前"，> 1 周
  = 完整时间
- formatInput 按字段类型读 input.positiveCount / classFilter 等，未知字段
  跳过（防御历史 doc）
- 复用 RelationsEditor 视觉容器风格

**下一步**

进入 **D5 — StoneViewer lazy 加载**：

- 把 StoneViewer / OrbitControls / GLTFLoader 用 React.lazy() 包裹
- 接受首次 viewer mode 的 1-2s loading 闪烁
- 主 chunk 目标降到 < 600 KB（v0.4.0 release notes 的已知限制）

---

### 2026-05-04 13:15 · D5 完成 — 主 chunk < 600 KB ✓

**commit**: `585d46a` (perf(app): D5 StoneViewer 改 lazy 加载，主 chunk 从 882 KB 降到 477 KB)

**做了什么**

- App.tsx 把 StoneViewer 改 `import type` + `lazy(() => ...)`
- viewer 模式下 `<StoneViewer>` 包 Suspense fallback "正在加载浏览模块..."
- AnnotationWorkspace / AssemblyWorkspace 内部仍同步 import StoneViewer，
  rollup 自动把共享 Three.js 切到 ViewCube chunk

**实测构建产物（gzip）**

| chunk | 之前 | 现在 |
|---|---|---|
| index.js | 882 KB (234 gzip) | **477 KB (144 gzip)** ← 主 chunk |
| StoneViewer | - | 10 KB (4 gzip)（薄壳） |
| ViewCube | - | 404 KB (103 gzip)（含 Three / Orbit / GLTF） |
| AnnotationPanel | 23 KB | 485 KB (155 gzip)（含 cytoscape） |
| AnnotationWorkspace | 336 KB | 346 KB |

主 chunk 减小 46%。AnnotationPanel 涨是 D2 cytoscape ~150 KB 的代价，但
它本身仍 lazy 不影响首屏。**达成 v0.4.0 release notes 已知限制 #5。**

**怎么实现的**

- `import type` 让 TS 类型保留但运行时不导入实体
- viewer 模式包 Suspense；annotation / assembly 模式已经在自己的 Suspense
  下，StoneViewer chunk 与 ViewCube chunk 共享，不会重复下载

**下一步**

进入 **D6 — 共现术语推荐**：

- 基于 doc 中所有 annotation.semantics.terms 统计共现矩阵
- TermPicker 在搜索框旁加"建议"chip 行：列出与"当前标注已有 terms"
  共现频次最高的 5 个术语
- 点 chip 直接加进当前 annotation.terms
- 数据少时（< 5 个标注）静默不显示

---

### 2026-05-04 13:35 · D6 完成 — 共现术语推荐

**commit**: `411ef5a` (feat(annotation): D6 共现术语推荐（基于已有标注 terms 统计）)

**做了什么**

- 新建 cooccurrence.ts · recommendCooccurringTerms：
  * 扫所有 annotation 构 term ↔ term 共现矩阵
  * 当前已有 termIds = T，candidate score = sum_{s∈T} cooc[s][candidate]
  * 取 top 5
  * 当前无 terms 时退化为全局频次推荐
  * 含 terms 标注 < 5 时返回空（避免噪声）
- TermPicker 加 suggestedTerms prop + chip 行
- AnnotationPanel EditTab useMemo 算 suggestedTerms 并下发
- chip 视觉青色（与已存关系 auto 同色）；query 非空时隐藏避免占空间

**怎么实现的**

- 共现矩阵用 Map<id, Map<id, count>>，对称写入；O(M*K²) M < 200 几毫秒
- vocabularyTerms 做 id → term 的 Map 加速查找
- 已选 terms 自动排除（不再推荐自己）

**下一步**

进入 **D7 — COCO JSON 导出**：

- 按 COCO 格式（images / annotations / categories）导出当前 doc
- bbox 直接用；polygon 转 segmentation
- structuralLevel 作为 categories
- 列表 tab "下载" 区加 COCO 按钮

---

### 2026-05-04 14:00 · D7 + D8 完成 — COCO / IIIF 导出

**commit**: `d6685c3` (feat(annotation): D7 + D8 COCO JSON / IIIF Web Annotation 导出)

由于 D7 / D8 都是导出功能、共享 exporters.ts 文件、UI 都在 ListTab 下载区，
合并成一个 commit 完成。

**做了什么**

- 新建 frontend/src/modules/annotation/exporters.ts:
  * exportToCoco(doc, opts)：标准 COCO 格式
  * exportToIiifAnnotationPage(doc, opts)：W3C Web Annotation Data Model
  * downloadJson(payload, name) 工具函数
- AnnotationPanel ListTab 下载区加 COCO / IIIF 按钮
- App.tsx 加 handleExportCoco / handleExportIiif；用
  selectedStone.metadata.dimensions 作为 imageSize 默认值；缺省 1000×1000

**怎么实现的**

COCO:

- BBox → bbox=[x, y, w, h] 像素 + area = w*h
- Polygon → segmentation=[[x1,y1,x2,y2,...]] + 外接 bbox + shoelace 算 area
- Point/LineString 跳过（COCO 不支持）
- categories 用 8 档 structuralLevel + iiml_id / iiml_label 扩展字段保留 IIML 链路

IIIF:

- BBox → FragmentSelector#xywh=...
- Polygon → SvgSelector + svg path（M/L 段）
- Point → 8x8 FragmentSelector
- body 按 purpose 拆分：tagging / describing / identifying / classifying /
  transcribing；motivation: inscription level → "transcribing" 其它 → "tagging"
- generator 标记 WSC3D + method/model 让 SAM/YOLO 来源可追溯

**下一步**

D 全部完成。进入 **FINAL 收尾**：

- 写 docs/RELEASE_NOTES_v0.6.0.md
- 更新 README.md + ROADMAP.md
- 一次最终 commit + push

---

### 2026-05-04 14:25 · FINAL 收尾完成

**做了什么**

- 写 `docs/RELEASE_NOTES_v0.6.0.md`：详尽覆盖 D1-D8 + 性能数据 + 验收 + 已知限制
- 更新 `README.md`：当前版本 v0.6.0；模块概览补"AI 处理记录全程可溯源 / Cytoscape 含 layout 切换 / 关系筛选 / 共现术语推荐 / COCO·IIIF·IIML·CSV 四种导出"；版本表加 v0.6.0；WORK_LOG 链接补 v0.5.0
- 更新 `docs/ROADMAP.md`：v0.6.0 已交付摘要；M3-2.5 关系筛选打勾；M3-2.6 大图性能 + 共现推荐打勾；新增 2.7 学术溯源 + 2.8 学术导出节

**整体收尾**

本次连续推进 commit 清单（最新在上）：

```
?         docs(v0.6.0): release notes + README + ROADMAP（即将提交）
5ce94c7 docs(work-log): D7+D8 完成 — COCO / IIIF 导出
d6685c3 feat(annotation): D7 + D8 COCO JSON / IIIF Web Annotation 导出
e51f7d5 docs(work-log): D6 完成 — 共现术语推荐
411ef5a feat(annotation): D6 共现术语推荐
3cabbda docs(work-log): D5 完成 — 主 chunk < 600 KB
585d46a perf(app): D5 StoneViewer lazy 加载 882→477 KB
c0ec6db docs(work-log): D4 完成 — AI 处理记录 section
9c180aa feat(annotation): D4 AI 处理记录 section
d85163f docs(work-log): D3 完成 — processingRuns 写入
b2b2808 feat(annotation): D3 SAM / YOLO processingRuns 写入 IIML
e541f3e docs(work-log): D2 完成 — 图谱 layout + 节点尺寸
61c4f60 feat(annotation): D2 知识图谱 layout 切换 + 节点 size 按度数
fcc0f73 docs(work-log): D1 完成 — 知识图谱关系筛选
c35c5c1 feat(annotation): D1 知识图谱关系筛选 / 高亮
```

未打 git tag（按惯例留给版本审完再决定）。

**接力交接**

下次回来续做时优先读：

1. 本工作日志（`WORK_LOG_post_v0.5.0.md`）—— 完整时间线 + 每个子项实现细节
2. `RELEASE_NOTES_v0.6.0.md` —— 整体功能 + 验收 + 已知限制
3. `ROADMAP.md` 第 2.5–2.8 节 —— 剩余可做项

**typecheck 全程绿**，但 **未做浏览器端到端测试**，验收时跑
`RELEASE_NOTES_v0.6.0.md` §8 的 8 条验收清单。

下一波建议（按价值）：

- **立即 / 1 周内**：v0.6.0 端到端验收 + 修浏览器侧 bug
- **2-4 周**：M3-2.5 多解释并存 UI 专项 + M3-2.6 推荐加权
- **长线 M4**：多资源版本切换（原图 / RTI / 拓片 / 线图）+ `.hpsml` 包

工作日志结束。
