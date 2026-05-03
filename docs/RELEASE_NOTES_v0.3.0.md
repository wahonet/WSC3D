# WSC3D v0.3.0 — AI 标注闭环 · 多源底图 · 4 点对齐校准

> 发布日期：2026-05-04
> 对应计划：M3 第一波（见 [`ROADMAP.md`](ROADMAP.md) 第 2 节）
> 上一发布：[`v0.2.2`](RELEASE_NOTES_v0.2.2.md) — 标注模块 ICON 化与工程小修

本次发布是标注模块自 v0.2.0 重构以来最大的一次能力扩展，三件大事：

1. **AI 标注闭环可用**：SAM 候选从"能出"升级到"能用"，修了致命的坐标系翻转，
   引入了高清图直读路径，候选审阅支持多选合并；
2. **多源底图**：标注画布可以在 **3D 模型** 与 **画像石高清原图** 之间任意切换，
   高清图模式下 SAM 候选与显示天然对齐，识别精度大幅提升；
3. **4 点单应性对齐校准**：用户在两个底图各点 4 对对应点，标注就能在两个坐标系
   之间双向投影 —— 在图上画的标注切回 3D 模型也能看到，反之亦然。

同时把鼠标交互在两种底图上拉齐：滚轮缩放 + 中键 / 右键拖动，再无差异。

---

## 1. 标注模块 · AI 闭环

### 1.1 SAM 高清图路径修复（关键 bug）

旧高清图路径下 SAM 返回的 polygon 在画布上 **上下颠倒**。根因是前后端 v 轴方向
约定不一致：前端 `screenToUV / uvToScreen` 用 v 向下（与图像/屏幕坐标一致），
后端 `_uv_to_pixel_prompt` 与 `_flip_polygon_to_uv` 却假设 "modelBox v 向上"，
入口 / 出口各做一次 y 翻转 —— 结果是点击点送到原图错处分割，分割结果又被反向
画回画布。

修复：删除后端两处 y 翻转，统一约定 "前后端 UV 都 v 向下"。前端注释和 API 文档
同步更正。

### 1.2 高清图直读端点

新增 `GET /ai/source-image/{stone_id}`：

- 在 ai-service 里读 `pic/` 下匹配 `stone_id` 数字前缀的 tif / png / jpg
- PIL 解码后按长边 4096 LANCZOS 缩放，落盘缓存到 `ai-service/cache/source/{n}_max{m}.png`
- 第二次访问直接命中缓存（毫秒级）
- 原图 mtime 比缓存新会自动重新转码

意义：浏览器原生不支持 tif，又不可能把 178 MB 原图塞进 base64；这条路径让前端
可以 `<img src="/ai/source-image/asset-29">` 直接渲染高清原图。

### 1.3 候选合并（polygon union）

引入 `polygon-clipping`（35 KB，专做 2D 多边形布尔运算）。在候选 / 列表两个 tab
都新增 checkbox 多选：

- 选中 ≥ 2 个候选 → 顶部出现"合并选中（N）"按钮
- 几何上对所有源 polygon 做 union，只保留外环（丢孔洞），满足"只要最外面的边缘"
  的诉求
- 合并后的 reviewStatus 用"最保守原则"：任一源是候选 → 结果是候选；否则跟随
  第一个源的状态（避免已 approved 的标注合并后被打回未审）
- 跨 frame（model + image）选中会被拒绝并提示，避免坐标系混淆

针对 SAM 经常把人物身体识别成两片的场景效果显著 —— 选两片合并即得完整轮廓。

### 1.4 候选审阅小改

- 候选卡片左上加 checkbox + `is-selected` 高亮
- 列表 tab 也复用同一套合并工具条，已 approved 标注合并不再走候选审定流程

---

## 2. 标注模块 · 多源底图

### 2.1 高清图视图（`SourceImageView`）

- 用 `<img>` + 自维护的 `ViewState { scale, offsetX, offsetY }` 渲染 PNG
- 滚轮：以光标为中心缩放（fit×0.5 ~ fit×30）
- 中键 / 右键拖动：平移
- 父级 `fitToken` 递增（工具栏"重置视角"按钮）：复位到 contain-fit 状态
- 窗口尺寸变化时不强制重置 viewState，避免用户调好的视角被 ResizeObserver 弄丢
- 始终向 `AnnotationCanvas` 输出当前 transform 后的 4 角 → 标注 UV 坐标系就是
  这张图自身的归一化坐标

### 2.2 工作区切换 UI

`AnnotationWorkspace` 持有 `sourceMode: "model" | "image"` 状态，画布右上角浮动
segmented 切换条；切到高清图时 `StoneViewer` 卸载、`SourceImageView` 挂载（共享
同一个 `ScreenProjection` 协议，AnnotationCanvas 不感知底图来源）。

第一次切到高清图模式有 1~3 秒解码 + 缓存写盘的等待，之后秒开。

---

## 3. 标注模块 · 4 点对齐校准

### 3.1 数据模型

- `IimlAnnotation` 加可选 `frame: "image" | "model"`，缺省视为 `"model"`，向后兼容
- `IimlDocument.culturalObject.alignment` 持久化标定结果：`controlPoints[]`
  存 4 对 `{ modelUv, imageUv }`；`version / calibratedAt / calibratedBy` 记录元信息
- 后端 IIML schema 已经是 `additionalProperties: true`，新字段无破坏性落盘

### 3.2 几何核心（`homography.ts`）

- `solveHomography(src, dst)`：4 点 DLT 构造 8×8 线性方程组 + 高斯消元（带主元）
  求 3×3 单应性矩阵；选择 8 元（h[8]=1）而非 SVD —— 我们标定的是大致正向矩形，
  浏览器里写稳定 SVD 不划算
- `applyHomography(H, point)`：齐次坐标投影 + 归一化
- `invertMat3`：3×3 求逆（adjugate / det）
- `buildAlignmentMatrices(alignment)`：从 IIML alignment 一步算出双向矩阵

### 3.3 跨 frame 渲染

`AnnotationCanvas` 收到 `sourceMode + alignment`，每条标注按 `frame === sourceMode`
决定渲染策略：

| annotation.frame | sourceMode | alignment | 渲染 |
| --- | --- | --- | --- |
| 与 sourceMode 同 | — | — | 实色实线，可拖动 / 改尺寸 |
| 与 sourceMode 异 | — | 已校准 | 稀疏虚线 + 半透明（投影态），仅可点选 |
| 与 sourceMode 异 | — | 未校准 | 跳过；画布顶部居中提示"有 N 个标注未对齐" |

跨 frame 标注暂不支持就地拖拽 / 改尺寸 —— 避免反向解算坐标的复杂度，用户切回
原 frame 编辑即可。

### 3.4 标定流程

工具栏新增 `Crosshair` 按钮（已校准时右下角青色圆点提示），点击进入"乒乓式"
4 对点采集：

1. 自动切到 3D 模型，提示"在 3D 模型上点第 1/4 个特征点"
2. 收满 4 个后自动切到高清图，让用户点对应位置
3. 8 个点齐了进入 review，画布同时显示当前 frame 的 4 个橙色编号点 + 用现场
   解算的 H 把对面 frame 的点投影过来的青色虚化点 —— 重合度即标定精度
4. 底部浮窗按钮：保存对齐 / 重新采集 / 撤销上一点 / 切到对面底图 / 取消

保存即写入 IIML 并随 doc 自动持久化。再次进入标定按钮即可重新校准。

---

## 4. 视图交互一致化

历史问题：标注画布在最上层（z-index: 15），原本只在 3D 模型模式下转发滚轮和
中键 pointerdown 给 OrbitControls；右键 pan 没接，高清图模式更是完全没有 pan/zoom。

本版统一：

- `findStoneCanvas` 拆成 `findViewportTarget`（找 `.three-stage canvas` 或
  `.source-image-stage`）和 `findStoneCanvas`（仅给 SAM 截图回退用）
- 滚轮、中键 + 右键 pointerdown 都转发到 `findViewportTarget` 的结果
- 3D 模型模式：右键 pan 由 OrbitControls 默认 `RIGHT=PAN` 接住；OrbitControls
  会自动 preventDefault contextmenu，不弹菜单
- 高清图模式：`SourceImageView` 自己实现 wheel + pointer 监听，pointer state 用
  ref（不依赖 pointerId 严格匹配，兼容 AnnotationCanvas 转发的合成 PointerEvent）

最终两种底图下行为完全一致：左键标注、滚轮缩放、中键 / 右键平移、中键画
contextmenu 不弹。

---

## 5. 工程

- 新增依赖：`polygon-clipping@^0.15.7`（用于候选合并）
- 新增前端文件：`SourceImageView.tsx`、`homography.ts`、`merge.ts`、`sam.ts`
- ai-service 新增端点 `/ai/source-image/{stone_id}` + 缓存目录 `ai-service/cache/`
- `pic/`、`ai-service/cache/` 加入 `.gitignore`，源 tif 与转码 PNG 都不进版本库
- typecheck + lint + 生产 build 全绿

---

## 6. 数据兼容

- 历史标注没有 `frame` 字段：渲染时按 `"model"` 处理，与 3D 模型模式行为一致，
  老数据无感
- 历史 doc 没有 `alignment`：跨 frame 标注直接跳过显示并提示，行为退化为
  "只显示当前 frame 的标注"

---

## 7. 已知限制

- 跨 frame 标注暂不支持就地编辑（设计取舍，详见 §3.3）；用户切回原 frame 即可
- 单应性变换假设 4 点对应大致正向矩形且不严格共线；极端共线 / 退化情况下
  `solveHomography` 返回 undefined，跨 frame 渲染整体跳过 + 提示重新校准
- 候选合并目前只取每个多边形的外环；带孔（甜甜圈形状）的合并候选孔洞会被
  自动填掉。汉画像石浮雕场景几乎不会有真"环形主体"，不阻塞使用
- pic/ 目录下当前只有 1 张高清图（`29东汉武氏祠左石室后壁小龛西侧画像石.tif`）；
  其它画像石需要补齐高清原图后才能用高清图模式
- 主 chunk 体积仍然 800+ KB（gzip 245 KB），引入 `polygon-clipping` 之后未做
  额外的 chunk 拆分

---

## 8. 验收要点

1. **SAM 候选不再上下颠倒**：进标注模块 → 切到高清图 → 点 SAM 工具 → 点击图上
   任意人物，候选 polygon 应严格贴合所点的图案
2. **高清图模式对齐**：同 1，候选轮廓应精确贴合，不再有"识别得对但位置错"的
   现象
3. **多选合并**：候选 / 列表 tab 任一，勾选 ≥ 2 条多边形 → 顶部"合并选中"按钮
   亮起 → 点击 → 原条目消失、出现合并标注（label 为"SAM 合并候选"或"合并标注"）
4. **对齐校准**：工具栏 Crosshair 按钮 → 在 3D 模型上点 4 个角 → 自动切到高清图
   再点 4 个对应角 → review 阶段切回 3D 模型，看到橙色 + 青色编号点重合度
   → 保存对齐 → 工具栏按钮右下出现青色小圆点（已校准标记）
5. **跨 frame 显示**：在高清图上画一个矩形 → 切回 3D 模型，应看到该矩形以稀疏
   虚线 + 半透明形态投影到 3D 视图上的对应位置（前提是已完成 §4 的对齐）
6. **视图交互一致**：3D 模型 / 高清图两个模式下分别测：滚轮缩放 / 中键拖动 /
   右键拖动；都应该顺滑、不弹右键菜单

---

## 9. 下一步

完整规划见 [`ROADMAP.md`](ROADMAP.md)。简要：

- M3 剩余：YOLO 候选检测、AI 线图（Canny / Relic2Contour）、多解释并存、
  标注间关系（IIML relations）、知识图谱可视化
- M4：多资源版本切换（原图 / RTI / 拓片 / 线图）、IIIF / COCO / .hpsml 导出

本次 **未自动打 git tag**，等待 QA 验收后由用户决定是否打 `v0.3.0` tag。
