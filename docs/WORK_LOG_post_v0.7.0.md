# v0.7.0 之后的连续推进工作日志（v0.8.0）

> v0.7.0 浏览器端验收的第一轮反馈：图谱 UI 排版不合适、PageRank 含义不清、
> 缺"资源"独立 tab、希望有"从三维模型生成正射图"。先把这波修掉，然后往
> v0.8.0 规划的多资源画布切换 / 跨资源坐标变换 / .hpsml 解包导入推进。
>
> 主分支：`main` · 远程：`https://github.com/wahonet/WSC3D.git` · 代理：`http://127.0.0.1:18081`
>
> 起点 commit：`ea995dc` (docs(v0.7.0): release notes + README + ROADMAP + 工作日志收尾)

---

## 0. 整体计划与范围

### H — 紧急修复（v0.7.0 验收反馈）

- **H1** 图谱 UI 排版：字体缩小合并成 2 行；PageRank 中文重命名"权威度"；排行榜从右侧栏挪到图谱下方；canvas 占整行
- **H2** 新增"资源"独立 tab：把 ResourcesEditor 从 ListTab 移出 + 列出后端落盘资源 + "从三维模型生成正射图"按钮
- **H3** 正射图生成管线：前端 Three.js offscreen 渲染（OrthographicCamera + 光照 + 4 种方向）+ 后端 POST/GET `/api/stones/:id/resources` + 落盘 `data/stone-resources/{stoneId}/`

### I — v0.8.0 规划推进

- **I1** 多资源画布切换：SourceImageView / StoneViewer 按 resource 加载图像 / 模型
- **I2** 跨资源坐标变换：`coordinateSystem.transform` 字段，多版本归一到统一坐标空间
- **I3** .hpsml 解包 / 导入：backend/src/services/hpsml.ts 实装
- **I4** 浏览器端验收 Playwright（条件允许时）

---

## 时间线

### 2026-05-04 16:20 · 起点（v0.7.0 验收反馈）

浏览器端跑 v0.7.0 图谱 tab 发现：

1. toolbar 下四行 chip（布局 / 着色 / 中心性 / 类别）太挤，字号 11.5px 导致"着色：按层级 按群组 按中心度 | 中心节点"换行
2. PageRank 是英文术语，用户没看懂含义
3. 图谱 canvas 被右侧 230px 排行榜挤得很窄，汉画像石这种节点 / 边少的情况下完全没必要
4. 希望"资源"独立成 tab，且能一键从 3D 模型生成正射图

下一步：开始 **H1 → H2 → H3** 一波做掉。

---

### 2026-05-04 17:00 · H1 + H2 + H3 完成 — 图谱 UI + 资源 tab + 正射图生成

#### H1 图谱 UI 排版

- graphMetrics.ts：`centralityKindLabels` 改成纯中文 {邻居数 / 桥梁度 / 接近度 / 权威度}；`pageRank` 展示名改 "权威度"；hint 补充 "Google PageRank 同款算法"
- KnowledgeGraphView.tsx：
  - 4 行 chip 合并成 2 行：第一行 "布局 + 着色 + 中心"；第二行 "中心性 + 类别 + 来源"
  - 每行之间加 `.knowledge-graph-filter-divider` 竖线视觉分组
  - "中心节点" chip 文案缩写成 "中心"
  - 排行榜 head 加 `shortHintFor(kind)` 显示简短提示（如 "被高权重邻居指向 → 综合权威"），完整 hint 走 title 悬浮
  - 群组规模 chip 行合并到 ranking head，不再占独立区块
- styles.css：
  - `.knowledge-graph-filters` 字号 12 → 11，chip padding 减小
  - `.knowledge-graph-stage` 改 flex-direction: column，canvas 占整行 min-height 380px
  - `.knowledge-graph-ranking-list` 改横向滚动 grid，每张 card 172px 宽
  - `.knowledge-graph-tab` min-height 360 → 520px

#### H2 资源 tab 独立化

- AnnotationPanel.tsx：TabKey 加 "resources"，label "资源"（Layers 图标）
- ListTab 里原本嵌入的 ResourcesEditor 移除
- AnnotationPanel tab body 加 "resources" 分支，渲染 ResourcesEditor（props 补 stone + onStatusMessage）

#### H3 正射图生成管线

**前端 `orthophoto.ts`**（新建）：

- `generateOrthoImage(modelUrl, options)`：独立 offscreen Three.js 渲染器
  - `WebGLRenderer` + offscreen canvas（document.createElement）
  - 加载 GLTF → 算 AABB → `OrthographicCamera` frustum 正好裹住模型 + 5% 留白
  - 4 种视图方向：front（+Z）/ back（-Z）/ top（+Y）/ bottom（-Y）
  - 光照：AmbientLight 0.75 + DirectionalLight 1.0（斜上 45° 单光源，拓片摄影棚效果）
  - 背景色 3 档：light（近拓片纸色 #efe7d8）/ dark / transparent
  - 输出 PNG blob + 像素尺寸 + 模型 AABB 尺寸
- 所有 Three.js 资源在 finally 里 dispose + `forceContextLoss()` 避免 WebGL context 泄漏

**后端 `backend/src/server.ts`**：

- 新增 `/api/stones/:id/resources` 两个端点：
  - GET 列出 `data/stone-resources/{stoneId}/` 下所有落盘图像
  - POST 接收 PNG（Content-Type: image/png 原始二进制 或 JSON { type, imageBase64 }），落盘为 `{type}-{timestamp}.png`
- 静态托管 `data/stone-resources/` → `/assets/stone-resources/`
- 文件名约定：`{type}-{timestamp}.png` 方便 GET 列表时按 type 过滤
- body size 限制改 25MB（3072px 长边 PNG 大约 5-10MB）

**前端 `api/client.ts`**：

- 新增 `StoneResourceEntry` 类型 + `listStoneResources(stoneId)` + `uploadStoneResource(stoneId, payload, options)`
- uploadStoneResource 同时支持 Blob（走 raw image/png）和 { imageBase64 }（走 JSON）两种 payload

**前端 `ResourcesEditor.tsx`** 重写：

- 挂在独立 "resources" tab 下，分 3 个 section：
  1. **从三维模型生成正射图**：4 个方向 chip + "生成正射图"按钮
  2. **IIML 资源条目**：列出 doc.resources[]，每条支持预览图像 / 删除 / 新标签打开原图
  3. **后端已落盘**：列出 data/stone-resources/{stoneId}/ 下所有文件，未关联的一键"关联"到 IIML resources[]
- 卡片显示 160px max-height 缩略图（`object-fit: contain`）
- 生成正射图完整流程：`generateOrthoImage` → `uploadStoneResource` → `onAddResource` 加进 IIML resources → `refreshServerResources` 刷新后端列表

#### 验证

- npm run typecheck 全程绿（前后端都过）
- 未做浏览器端手动测试（下一步）

**下一步**

commit + push 这一波，然后开始 **I1 多资源画布切换**。

---

### 2026-05-04 17:40 · I1 + I2 + I3 完成 — 多资源画布切换 + 跨资源坐标变换 + .hpsml 解包

#### I1 多资源画布切换

- SourceImageView 新增 `imageUrl?: string` props：默认走 `/ai/source-image/{stoneId}`
  （pic/ 原图），传了就用它（任意 doc.resources 里的 image 类资源 URI）
- 切换 stoneId 或 imageUrl 都重置 viewState 走 fit
- AnnotationWorkspace 新增 `activeImageResourceId` 状态 + `imageLikeResources` 派生：
  从 doc.resources 过滤 Orthophoto / Rubbing / NormalMap / LineDrawing / OriginalImage /
  RTI / Other 类型作为可选底图
- 高清图模式下 source-switch 下方新增"资源切换" segmented UI，chip 文案按类型
  + 方向生成（"正射·正" / "拓片" / "法线" / ...）
- 切到非 pic/ 资源时强制禁用 Canny 线图叠加（后端 canny 管线只处理 pic/ 原图）
- 资源列表变动时自动清掉无效的 activeImageResourceId
- CSS：`.annotation-resource-switch` 插入 source-switch 和 layer-switch 之间，
  layer-switch / lineart-panel 位置下移 40px 避免重叠

#### I2 跨资源坐标变换（数据模型层）

- `types.ts` 新增 `IimlResourceTransform` 联合类型，3 种 kind：
  - `orthographic-from-model`：view / modelAABB / pixelSize / frustumScale，
    纯线性仿射（modelBox UV ↔ 正射图 UV）
  - `homography-4pt`：4 对对应点，同 alignment 但绑到资源
  - `affine-matrix`：显式 3×3 矩阵
- `IimlResourceEntry.transform` 字段（可选）保存变换
- `orthophoto.ts` 的 `OrthoImageResult` 返回 `frustumScale` + `view`
- `ResourcesEditor` 生成正射图时自动填入 `transform: { kind: "orthographic-from-model", ... }`
- 资源卡片上增加 `.resources-item-transform` 提示条（金绿色边框），显示
  "正射投影 · 正面 · AABB WxH · frustum 1.05× · 像素 WxH"

**画布投影实装留 v0.9.0**：v0.8.0 只把跨资源元数据铺好，画布渲染时暂仍按
原 frame 显示（不做跨资源投影），避免引入画布层 bug

#### I3 .hpsml 解包导入

- `backend/src/services/hpsml.ts` 新建：
  - `importHpsmlPackage(root, config, getCatalog, payload, options)` 解包
  - 校验 `format === "hpsml"` + `formatVersion`（不同版本告警继续尝试）
  - 解 stoneId：options.stoneId > context.stone.id > iiml.documentId 前缀
  - IIML 主体直接走 `saveIimlDoc`（完整 ajv 校验）
  - 拼接方案导入 `data/assembly-plans/`，冲突时生成新 id + `importedFromHpsml` 标记
  - conflictStrategy: overwrite（默认）/ skip；skip 模式探测本机已存在则跳过 iiml
- `server.ts` 加 `POST /api/hpsml/import?stoneId=...&conflict=overwrite|skip`
- `client.ts` 加 `importHpsmlPackage(payload, options)` + `HpsmlImportSummary` 类型
- `AnnotationPanel` ListTab 下载区加"导入 .hpsml"按钮
- `App.handleImportHpsml`：用隐藏 `<input type="file" accept=".json,.hpsml">` 触发
  文件选择，解析 JSON 后调 API；若导入的是当前 stoneId，重新拉 IIML 让画布刷新

#### 验证

- npm run typecheck 全程绿（前后端都过）
- 未做浏览器端手动测试，需要在 v0.8.0 收尾验收

**下一步**

写 v0.8.0 release notes + 更新 README + ROADMAP，最后 commit + push 一次完成
本轮交付。

---

### 2026-05-04 18:10 · FINAL 收尾完成

**做了什么**

- 写 `docs/RELEASE_NOTES_v0.8.0.md`：详尽覆盖 H1+H2+H3（图谱 UI / 资源 tab /
  正射图生成）+ I1+I2+I3（多资源画布切换 / 跨资源坐标变换数据模型 /
  .hpsml 解包导入）共 6 个子项；验收要点 6 条 + 已知限制 + v0.9.0 候选
- 更新 `README.md`：当前版本 v0.8.0；模块概览合并 v0.7.0 + v0.8.0 全部功能
  + 版本表加 v0.8.0 + 工作日志链接补 v0.7.0 + 下一步改 v0.9.0 候选
- 更新 `docs/ROADMAP.md`：header 改"截至 v0.8.0"；已交付清单加"图谱 UI 修缮
  + 资源独立 tab + 正射图生成 + 多资源架构"段；3.1 多资源切换 / 3.3 数据交换
  协作条目打勾；加新 v0.9.0 项（画布投影 / 三方合并）

**整体收尾**

本次 v0.8.0 推进 commit 清单（最新在上）：

```
?         docs(v0.8.0): release notes + README + ROADMAP + 工作日志收尾（即将提交）
8cb7236 feat(annotation+backend): I1+I2+I3 多资源画布切换 + 跨资源坐标变换 + .hpsml 解包导入
8fb2583 feat(annotation+backend): H1+H2+H3 图谱 UI + 资源 tab 独立 + 三维模型生成正射图
```

2 次 feat commit + 1 次 docs 收尾 commit。未打 git tag。

**接力交接**

下次回来续做时优先读：

1. 本工作日志（`WORK_LOG_post_v0.7.0.md`）—— 完整 H/I 时间线 + 每个子项实现细节
2. `RELEASE_NOTES_v0.8.0.md` —— 整体功能 + 验收 6 条 + 已知限制
3. `ROADMAP.md` 第 3.1（多资源）/ 3.3（数据交换）节 —— 剩余可做项

**typecheck 全程绿**，但 **未做浏览器端到端测试**，验收时跑
`RELEASE_NOTES_v0.8.0.md` §8 的 6 条验收清单。

下一波（v0.9.0）建议按价值：

- **立即 / 1 周内**：v0.8.0 端到端验收 + 修浏览器侧 bug
- **2-4 周**：画布跨资源投影实装（读 `resource.transform` → AnnotationCanvas
  按变换显示标注）；canny 管线支持任意 URI（正射图 / 拓片叠线图）
- **中期**：.hpsml 三方合并 UI；资源选择状态持久化
- **长线**：YOLO 微调汉画像石专用模型（v0.7.0 的 SAM 批量精修 + v0.8.0 的正射
  图能加速积累训练数据）；HED / Relic2Contour 深度学习线图

工作日志结束。