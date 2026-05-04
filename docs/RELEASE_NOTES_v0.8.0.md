# WSC3D v0.8.0 — 图谱 UI 修缮 · 资源独立 tab · 三维生成正射图 · 多资源画布切换 · 跨资源坐标变换 · .hpsml 解包 · 正射图 1:1 对齐与跨资源 SAM/YOLO（J 补丁）

> 发布日期：2026-05-04
> 对应计划：v0.7.0 验收反馈修缮 + v0.8.0 M4 多资源架构落地
> 上一发布：[`v0.7.0`](RELEASE_NOTES_v0.7.0.md) — 紧急修复 · 图谱完善 · 多解释 UI · AI 加深 · 多资源 · .hpsml 包

v0.7.0 浏览器端验收那轮的反馈集中在图谱 UI 挤、"资源"应该独立 tab、以及
没有原图 / 拓片时想用三维模型生成一张正射图当底图。把这波修掉后，顺势把
v0.8.0 规划的 M4 多资源架构三条线也落了地：**多资源画布切换**、**跨资源
坐标变换（数据模型）**、**.hpsml 研究包解包导入**。

这一版的核心是：**这块画像石除了三维模型和 pic/ 下的原图之外，现在也能用
自己生成的正射图、手工注册的拓片 / 法线图 / RTI / 点云作为底图来标注**，
还能把别人（别的研究者 / 别的机器）导出的 .hpsml 一键导进来。

工作日志：[`WORK_LOG_post_v0.7.0.md`](WORK_LOG_post_v0.7.0.md)。

---

## 1. 图谱 UI 修缮（H1）

v0.7.0 的图谱 tab 被反馈：4 行 chip（布局 / 着色 / 中心性 / 类别）字太大挤换行；
PageRank 写英文没看懂；右侧 230px 排行榜侧栏把 canvas 挤窄。

这一版的调整：

- **中心性算法中文化**：权威度（PageRank）/ 邻居数（Degree）/ 桥梁度（Betweenness）
  / 接近度（Closeness）。PageRank 不再露英文；hint 补 "Google PageRank 同款算法"
- **chip 行 4 → 2**：第一行 "布局 + 着色 + 中心"；第二行 "中心性 + 类别 + 来源"。
  每段之间加 `.knowledge-graph-filter-divider` 细竖线视觉分组
- **排行榜从侧栏挪到下方**：`.knowledge-graph-stage` 改 `flex-direction: column`，
  canvas 占整行 `min-height: 380px`；排行榜改横向滚动卡片（每张 172px）
- **群组规模 chip 并入排行榜 head**：不再占独立区块；head 加 `shortHintFor(kind)`
  简短提示（如 "被高权重邻居指向 → 综合权威"）
- **整体字号统一缩小**：chip 从 11.5 → 10.5px，padding 缩；`.knowledge-graph-tab`
  min-height 360 → 520px 让 canvas 更舒展

---

## 2. 资源独立 tab + 三维模型生成正射图（H2 + H3）

### 2.1 "资源" tab

`AnnotationPanel.TabKey` 加 "resources"（Layers 图标 + 中文"资源"）。
原本嵌在 ListTab 顶部的 `ResourcesEditor` 移到这个新 tab 下，可以占满面板高度。

### 2.2 ResourcesEditor 重写：3 个 section

1. **从三维模型生成正射图**：4 个方向 chip（正面 / 背面 / 顶面 / 底面）+
   "生成正射图"按钮
2. **IIML 资源条目**：列出 `doc.resources[]`，每条支持预览图像（160px max-height
   `object-fit: contain`）/ 删除 / 新标签页打开
3. **后端已落盘**：列出 `data/stone-resources/{stoneId}/` 下实际文件；未关联
   的一键"关联"到 IIML resources[]

### 2.3 正射图生成管线

**前端** `frontend/src/modules/annotation/orthophoto.ts`（新建）：

- 独立 offscreen Three.js 渲染器：`WebGLRenderer` + `document.createElement("canvas")`
- GLTFLoader 加载模型 → 算 AABB → `OrthographicCamera` frustum 正好裹住模型 + 5% 留白
- 4 种视图方向（front / back / top / bottom）
- 光照：AmbientLight 0.75 + DirectionalLight 1.0 斜上 45°（拓片摄影棚单灯效果）
- 背景 3 档：light（近拓片纸色 #efe7d8，默认）/ dark / transparent
- 输出 PNG blob + 像素尺寸 + 模型 AABB 尺寸 + frustumScale + view
- 所有 Three.js 资源在 finally 里 dispose + `forceContextLoss()` 防 WebGL context 泄漏

**后端** `backend/src/server.ts`：

- `GET /api/stones/:id/resources`：列出 `data/stone-resources/{stoneId}/` 下所有
  落盘图像
- `POST /api/stones/:id/resources`：接收 PNG（`Content-Type: image/png` 原始二进制
  或 JSON `{ type, imageBase64 }`），落盘为 `{type}-{timestamp}.png`
- 静态托管 `/assets/stone-resources/`
- body size 25MB（3072px 长边 PNG 大约 5-10MB）

生成后自动：`generateOrthoImage` → `uploadStoneResource` → `onAddResource` 加进
IIML → `refreshServerResources` 刷新后端列表。

---

## 3. 多资源画布切换（I1）

`SourceImageView` 新增 `imageUrl?: string` props：默认走 `/ai/source-image/{stoneId}`
（pic/ 原图），传了就用它（任意 doc.resources 里的 image 类资源 URI）。

`AnnotationWorkspace` 新增"资源切换" segmented UI，高清图模式下显示在
source-switch 与 layer-switch 之间：

- 默认"原图"（pic/ 走 `/ai/source-image/`）
- `doc.resources[]` 里 Orthophoto / Rubbing / NormalMap / LineDrawing /
  OriginalImage / RTI / Other 类型的资源都会自动列成 chip
- chip 文案按类型 + 方向生成（"正射·正" / "拓片" / "法线" / ...）
- 切到非 pic/ 资源时强制禁用 Canny 线图叠加（后端 canny 管线只处理 pic/ 原图）

**使用场景**：生成正射图后切到"正射·正"底图，在上面继续标注；或手工注册
外部拓片 URI 后切到"拓片"底图做对照研究。

---

## 4. 跨资源坐标变换（I2）

数据模型层先行，为 v0.9.0 的画布跨资源投影做准备。

`types.ts` 新增 `IimlResourceTransform` 联合类型：

```ts
type IimlResourceTransform =
  | {
      kind: "orthographic-from-model";
      view: "front" | "back" | "top" | "bottom";
      modelAABB: { width: number; height: number; depth: number };
      pixelSize: { width: number; height: number };
      frustumScale: number;
      generatedAt?: string;
    }
  | {
      kind: "homography-4pt";
      controlPoints: Array<{ model: [number, number]; image: [number, number] }>;
      referenceResourceId?: string;
    }
  | {
      kind: "affine-matrix";
      matrix: number[];
      referenceResourceId?: string;
    };
```

`IimlResourceEntry.transform` 字段可选保存变换。

**正射图生成时自动填入** `transform: { kind: "orthographic-from-model", view,
modelAABB, pixelSize, frustumScale }`。这样 modelBox UV ↔ 正射图 UV 就有了
精确可算的对应关系。

ResourcesEditor 卡片上新增 `.resources-item-transform` 金绿色提示条，显示
"正射投影 · 正面 · AABB W×H · frustum 1.05× · 像素 W×H"。

**画布投影实装留 v0.9.0**：v0.8.0 只把跨资源元数据铺好，画布渲染时暂仍按
原 frame 显示（不做跨资源投影），避免引入画布层 bug 影响主流程稳定性。

---

## 5. .hpsml 解包导入（I3）

`backend/src/services/hpsml.ts` 新建 `importHpsmlPackage(root, config,
getCatalog, payload, options)`：

- **校验**：`format === "hpsml"` + `formatVersion`（不同版本告警继续尝试）
- **解 stoneId 优先级**：`options.stoneId` > `context.stone.id` >
  `iiml.documentId` 的前缀（`{stoneId}:iiml`）
- **IIML 主体**：直接走 `saveIimlDoc`（完整 ajv 校验，写入
  `data/iiml/{stoneId}.iiml.json`）
- **拼接方案**：写入 `data/assembly-plans/`；冲突时生成新 id +
  `importedFromHpsml: true` 标记
- **冲突策略** `options.conflictStrategy`：
  - `"overwrite"`（默认）：直接覆盖本机已有
  - `"skip"`：若本机已存在则跳过 IIML 部分

后端端点：`POST /api/hpsml/import?stoneId=...&conflict=overwrite|skip`
（body = 完整 .hpsml JSON）

前端：

- `client.ts` 加 `importHpsmlPackage(payload, options)` + `HpsmlImportSummary` 类型
- `AnnotationPanel` ListTab 下载区加"导入 .hpsml"按钮
- `App.handleImportHpsml`：用隐藏 `<input type="file" accept=".json,.hpsml">`
  触发文件选择，解析 JSON 后调 API；若导入的是当前 `stoneId`，自动重新拉 IIML
  让画布刷新

返回 summary：

```json
{
  "stoneId": "asset-29",
  "imported": {
    "iiml": true,
    "annotations": 42,
    "relations": 18,
    "processingRuns": 6,
    "resources": 3,
    "assemblyPlans": 2
  },
  "skipped": { "iiml": false, "assemblyPlans": 0 },
  "warnings": []
}
```

---

## 6. commit 时间线

```
8cb7236 feat(annotation+backend): I1+I2+I3 多资源画布切换 + 跨资源坐标变换 + .hpsml 解包导入
8fb2583 feat(annotation+backend): H1+H2+H3 图谱 UI + 资源 tab 独立 + 三维模型生成正射图
ea995dc docs(v0.7.0): release notes + README + ROADMAP + 工作日志收尾
```

H 和 I 共 2 次 feat commit + 1 次 docs 收尾 commit（v0.7.0 → v0.8.0 共 3 次）。

---

## 7. 数据兼容

- 历史 IIML 文档没 `resources[*].transform` 字段：按 `undefined` 处理，UI 容错显示
- 历史 IIML 文档没 `resources[*].type === "Orthophoto"`：跨资源切换 UI 只显示
  已存在的类型，不影响主流程
- `.hpsml` v0.1.0 formatVersion：导入时校验；未来 formatVersion 变化时先告警
  再尝试兼容导入
- `data/stone-resources/{stoneId}/` 目录不入库（`.gitignore` 已有 `data/` 但
  该子目录按需建立；多机协作时通过 .hpsml 包或单独 rsync）

---

## 8. 验收要点

进标注模式后依次试：

1. **图谱 UI**：图谱 tab → 布局 / 着色 / 中心 chip 一行完整显示不换行；
   中心性下方是 "权威度 / 邻居数 / 桥梁度 / 接近度"；canvas 占整行变大；
   排行榜在 canvas 下方横向滚动
2. **资源 tab**：右侧 panel 应有 "资源" tab，点开看到 3 个 section
3. **生成正射图**：资源 tab → 选 "正面" → 点 "生成正射图" → 等 3-8 秒 →
   IIML 资源条目区应新增一条 Orthophoto，缩略图显示生成的正射图；卡片下方
   应有金绿色 "坐标变换 · 正射投影 · 正面 · AABB ... · frustum 1.05× · 像素 ..."
   提示条
4. **多资源画布切换**：标注模式 → 切到高清图 → canvas 右上角 source-switch
   下方应出现 "底图 原图 正射·正" 的资源切换条 → 点 "正射·正" → 画布显示
   正射图；+线图 按钮自动置灰
5. **.hpsml 导入**：先从 v0.7.0 导出的 .hpsml 文件 → 列表 tab 下载区点 "导入
   .hpsml" → 选文件 → status 显示 "已导入 .hpsml（stoneId=xxx）：IIML 写入、
   标注 N / 关系 N / 拼接方案 N" → 若是当前画像石，画布自动刷新
6. **后端已落盘刷新**：资源 tab 第 3 个 section 应列出生成过的正射图文件；
   点 "刷新" 应扫描 `data/stone-resources/{stoneId}/` 重新列出

---

## 9. J 补丁：正射图 1:1 对齐 + 跨资源 SAM / YOLO

收到用户反馈"生成的正射还有白边、SAM / YOLO 只能跑 pic/、正射和 3D 模型标注
不同步"之后在当天补的 J 补丁。核心思路是让正射图从生成开始就**严格对齐 3D
模型 AABB**，这样正射图 UV 数值上等于 modelBox UV，跨资源标注同步不需要再做
数学变换。

### 9.1 正射图 frustumScale 1.05 → 1.0

- `frontend/src/modules/annotation/orthophoto.ts`：生成 frustum 从"AABB × 1.05
  留白"改为"严格贴 AABB"。生成的 PNG 紧贴模型边缘，没有白边
- 返回值增加 `equivalentToModel: boolean`；view=front + frustumScale=1.0 满足
  时为 true，表示该正射图图像 UV 与 modelBox UV 完全 1:1 对应
- `IimlResourceTransform.orthographic-from-model` 也加 `equivalentToModel?: boolean`
  字段跟随持久化；老数据（没有该字段）通过 view=front + |frustumScale-1|<1e-3
  的兜底判据也能识别为等价

### 9.2 SAM / YOLO 后端接 imageUri

- `ai-service/app/sam.py`：新增 `sam_segment_by_uri(uri, prompts_uv)`。URI 解析
  支持 `/assets/stone-resources/...` → `<repo>/data/stone-resources/...` 本地
  路径反解；不走 HTTP，不依赖 backend 在线
- `ai-service/app/yolo.py`：对应加 `yolo_detect_by_uri(uri, ...)`
- `ai-service/app/main.py`：`SamRequest` / `YoloRequest` schema 加 `imageUri`
  字段；路由优先级 **imageUri > stoneId > imageBase64**
- 这条新路径的坐标系是"图像 UV"；当图像 UV 与 modelBox UV 等价时，前端直接
  当 model frame 坐标用，不需要额外变换

### 9.3 前端 AI 调用随资源走

- `frontend/src/api/client.ts`：`runSamSegmentationBySource` / `runYoloDetection`
  参数加 `imageUri?: string`；SAM 路径要求 imageUri 或 stoneId 至少给一个
- `frontend/src/modules/annotation/sam.ts`：`refineBBoxWithSam` 和
  `requestSamCandidateWithSource` 加 `imageUri` 参数；传了就走 imageUri 分支
- `frontend/src/modules/annotation/AnnotationCanvas.tsx`：新增 `activeImageUri`
  prop；SAM 手动 prompt 提交时透传过去
- `frontend/src/modules/annotation/AnnotationWorkspace.tsx`：新增
  `onActiveImageResourceChange` 回调，把当前底图资源（id / uri / type /
  equivalentToModel）告诉 App 层，让 YOLO 批量扫描 / SAM 精修都能拿到正确的
  imageUri
- `frontend/src/App.tsx`：
  - `handleSubmitYoloScan` 读 `activeImageResource.uri` 作为 YOLO 输入；候选
    `frame` 按 equivalentToModel 决定（等价时记 model，否则跟随 sourceMode）
  - `handleRefineWithSam` 从 `annotation.resourceId` 反查资源 URI，在原资源上
    跑 SAM 精修，不错位到 pic/

### 9.4 跨资源标注自动同步（等价正射图）

- `AnnotationWorkspace` 新增派生状态 `activeResourceEquivalentToModel`
  （`transform.equivalentToModel === true` 或 view=front + frustumScale≈1）
- `effectiveSourceMode = sourceMode === "image" && activeResourceEquivalentToModel
  ? "model" : sourceMode`：在等价正射图上，画布按 model 坐标系处理
- 传给 AnnotationCanvas 的 `sourceMode` 用 effectiveSourceMode → 在等价正射图
  上新建的标注 frame="model"，3D 模型视图自动能看到；反过来 model frame 的
  历史标注也直接在等价正射图上显示
- UI 额外提示：等价正射图顶部有一枚绿色徽章"此图与 3D 模型坐标系已对齐 ·
  标注自动双向同步"（`.annotation-resource-aligned-hint` 样式）
- 非等价资源（top/bottom/back 方向、或 frustumScale 不是 1.0 的老数据）仍按
  image frame 处理，用户可走已有的 4 点单应性标定跨 frame 投影；**这部分的
  自动反投影留 v0.9.0**（画布层按 resource.transform 投影任意资源坐标）

### 9.5 验收

- 生成正射图：图像紧贴模型 AABB，无白边
- 在等价正射图底图上 SAM 框选 → 候选直接出现在 3D 模型视图上（切回 3D 模型
  模式可见）
- 在 3D 模型上已有的标注 → 切到等价正射图底图自动出现在同样的位置
- YOLO 批量扫描：在正射图底图上点扫描，扫的是正射图而非 pic/ 原图；候选
  resourceId 指向正射资源，SAM 精修时走该资源的 imageUri

---

## 10. 已知限制

- 本次发布所有功能已经过 typecheck，但 **未做浏览器端到端测试**
- 正射图生成依赖 WebGL 2.0 和 GLTFLoader；某些浏览器 / GPU 驱动对 offscreen
  context 支持不佳时会失败（目前异常走 status 提示，不阻塞主流程）
- **J 补丁后**：等价正射图（view=front + frustumScale=1.0）的跨 3D ↔ 正射
  双向标注同步已实现；非等价资源（top/bottom 方向 / 拓片 / 法线图）的画布
  跨资源投影仍留 v0.9.0（目前靠 annotation.frame + 4 点标定做跨 frame）
- .hpsml 解包 **只支持 overwrite / skip 两种冲突策略**；三方合并 IIML（保留
  双方的 annotation 差异）留 v0.9.0
- 多资源切换的 activeImageResourceId **不进 IIML 持久化**，切了石头 / 刷新
  浏览器会回到默认 pic/ 原图；这是设计（资源切换是临时视图状态）
- Canny 线图后端管线只处理 pic/ 原图，切到非 pic/ 资源时前端强制禁用 +线图；
  想要正射图的线图需要 v0.9.0 扩展 canny 管线支持任意 URI
- 老正射图（v0.8.0 H3 生成、frustumScale=1.05）不会被自动识别为等价；重新
  生成一次即可（生成按钮已默认 frustumScale=1.0）

---

## 11. 下一步（v0.9.0 候选）

详细规划见 [`ROADMAP.md`](ROADMAP.md)。简要：

- **画布跨资源投影**：读 `resource.transform`，在切换底图时自动把标注按变换
  投影到当前资源坐标系显示；正射图 ↔ pic/ 原图互投影；拓片 ↔ 正射图投影
- **资源选择持久化**：把 `activeImageResourceId` / `activeAnnotationResourceId`
  存进 IIML 或 localStorage，跨会话记住
- **.hpsml 三方合并**：两个 .hpsml 里的同 id 标注差异时 UI 显示三方对比
- **canny 管线支持任意 URI**：`/ai/lineart/...` 支持 resourceId 参数，对正射 /
  拓片也能生成线图叠加
- **ortho-from-model 反投影**：v0.8.0 只有 modelBox UV → 正射图 UV 正向映射；
  反过来（正射图上点到 model UV）留 v0.9.0 做

本次 **未打 git tag**，等浏览器端验收完再决定是否打 `v0.8.0` tag。
