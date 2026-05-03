# v0.4.0 之后连续推进工作日志

> 由 AI agent 在 2026-05-04 凌晨 5:00 起，**用户睡觉期间**连续推进。
> 每完成一个小节点追加一段，包含：做了什么 / 下一步打算 / 实现方式。
> **下一个接手的 agent 优先读本文件**，再看相关 release notes 与 ROADMAP。
>
> 主分支：`main` · 远程：`https://github.com/wahonet/WSC3D.git` · 代理：`http://127.0.0.1:18081`
>
> 起点 commit：`bb016c5` (docs(v0.4.0): release notes + README + ROADMAP)

---

## 0. 整体计划与范围（agent 自行划定）

用户授权"按你的理解去做"。基于先前讨论给出的方向 B / C，agent 划定本次推进
范围如下（粗略 → 精确，按子节点完成度调整）：

### B：关系与知识图谱（v0.5.0 主线候选）

- **B1** 标注间关系基础（schema + reducer + 创建 / 删除 / 列表 UI）
- **B2** 空间关系自动推导（纯运行时计算，不污染 IIML）
- **B3** 画布上画关联连线（选中标注时高亮关联）
- **B4** 知识图谱 tab（Cytoscape.js 节点 / 边图，与画布双向联动）

### C：工程闭环（搭在 B 之上的稳定性增强）

- **C2** 键盘快捷键（R/E/P/S/V 工具切换，F fit，Ctrl+Z/Y 撤销重做，Delete 删除）
- **C6** 候选 tab 类别 chip 过滤（响应 v0.4.0 已知限制）
- **C5'** alignment 状态在头部画像石下拉里显示（让用户一眼看出哪些石头已校准）

**跳过项**（理由 / 留给后续）：
- B5 共现推荐：当前数据量不足以训出有意义共现，等积累 100+ 标注再做
- C1 Playwright 端到端：单独一个 PR 比较合适，且需要稳定 dev 环境
- C3 批量重命名：纯锦上添花
- C4 代码分割降级：调优类，需要 profile 数据驱动

### 操作纪律

每个子节点：

1. 完成代码 → `npm run typecheck` 全绿
2. `git commit -F .git/COMMIT_EDITMSG_DRAFT` 用文件做 commit message（PowerShell 不支持 here-doc）
3. `git -c http.proxy=http://127.0.0.1:18081 -c https.proxy=http://127.0.0.1:18081 push origin main`
4. 工作日志追加一段
5. 删除 `.git/COMMIT_EDITMSG_DRAFT` 草稿文件

整体收尾：写 `docs/RELEASE_NOTES_v0.5.0.md`，更新 `README.md` 与 `docs/ROADMAP.md`，
最后再 commit + push 一次。**不打 git tag**，留给用户验收后决定。

---

## 时间线

### 2026-05-04 05:00 · 起点（v0.4.0 收尾后）

刚完成 v0.4.0 全部三个子项的发布与文档（A1 SAM 多 prompt + A2 AI Canny 线图
+ A3 YOLO 批量候选）+ 用户确认本次推进方向 B+C。

工作树 clean。当前 main HEAD = `bb016c5`，已与 `origin/main` 同步。

下一步：开始 **B1 — 标注间关系基础**。

---

### 2026-05-04 05:25 · B1 完成 — 标注间关系基础

**commit**: `796f6ee` (feat(annotation): B1 标注间关系基础（IIML relations）)

**做了什么**

- 数据模型：`IimlRelation { id, kind, source, target, note?, origin,
  createdAt? }`，受控 14 种 kind（叙事 / 层级 / 空间 / 解释 4 组），3 种
  origin（manual / spatial-auto / ai-suggest）
- IimlDocument.relations 类型从 `Record<string, unknown>[]` 收紧到
  `IimlRelation[]`
- store reducer 加 add/update/delete-relation；delete-annotation 同步
  清除涉及该标注的关系，避免悬空 source/target
- 新增 `getRelations(doc)` 读 + 防御校验
- 新建 `RelationsEditor` 组件，挂在 EditTab 末尾备注 ↔ 删除按钮之间：
  显示当前标注作为 source (→) / target (←) 的关系；inline 添加表单
  （分组下拉选 kind + 选目标 + 备注）；单条删除；点条目跳到对方
- 预留空间关系候选展示区（B2 注入）

**怎么实现的**

- AnnotationPanelProps 扩 6 个 props（relations / spatialCandidates +
  onAdd/Update/Delete-Relation + onSelectAnnotation 已有）
- AnnotationPanel `<EditTab annotation={selectedAnnotation} {...props} />`
  spread 已有，新 props 自动透传，EditTab 内只显式解构需要的字段
- App.tsx 用 useMemo + getRelations 取出关系列表；spatialCandidates 占位
  空数组（B2 阶段注入推导结果）
- 三个 dispatch action 直接 wire 到 reducer

**下一步**

进入 **B2 — 空间关系自动推导**：
- 新建 `frontend/src/modules/annotation/spatial.ts`：根据所有 annotation
  bbox 中心 + 外接矩形，推导 above/below/leftOf/rightOf/overlaps/nextTo
  6 种空间关系
- 不入库；返回 `SpatialRelationCandidate[]` 给 RelationsEditor 显示
- 用户可通过 "采纳" 按钮升为 manual 关系（B1 已实装该路径）
- 在 App.tsx 替换 `spatialRelationCandidates: []` 为 `useMemo(() =>
  deriveSpatial(doc), ...)`

---

### 2026-05-04 05:35 · B2 完成 — 空间关系自动推导

**commit**: `5eb19b5` (feat(annotation): B2 空间关系自动推导（纯运行时，不入库）)

**做了什么**

- 新建 `frontend/src/modules/annotation/spatial.ts · deriveSpatialRelations`
- 算法：每个标注算外接矩形 → 对每对（i, j）按 4 步优先级判定：
  1. 重叠率 > 15% → `overlaps`
  2. 中心距 < 平均尺寸 × 0.5 → `nextTo`
  3. 主导方向纵向（且距离 > 平均高 × 0.6）→ `above` / `below`
  4. 主导方向横向 → `leftOf` / `rightOf`
- 一对最多 1 条关系，避免淹没 RelationsEditor 候选区
- 跨 frame 不比对（model + image 坐标系不可直接比）
- App.tsx 替换占位：`spatialRelationCandidates = useMemo(() =>
  deriveSpatialRelations(doc.annotations))`

**怎么实现的**

- 用现成的 geometry helpers：`flattenUVs(g)` 把任意几何拍平成顶点；
  `ellipseBoundsToUV(g)` 给 Polygon 椭圆形态加速
- BBox 直接读 4 元；其它形态走顶点扫一遍取 minU/minV/maxU/maxV
- 比较时用 v 向下约定（与画布 / 图像一致）：dy > 0 表示 b 在 a 下方，
  即 a `above` b
- 候选 id 用 `spatial-${aId}-${bId}-${kind}` 稳定排重，已存关系会被
  RelationsEditor `filteredCandidates` 过滤掉，不重复显示

**下一步**

进入 **B3 — 画布关联连线**：
- AnnotationCanvas 内新增 `RelationLines` 子组件
- 选中一个标注时，画从该标注中心到所有相关标注（manual + spatial-auto）
  中心的连线
- 实线 = manual；虚线 = spatial-auto
- pointer-events: none，不影响交互
- 跨 frame 关系：未校准时不画线；已校准时用 H 矩阵把对方中心投影到当前
  画布

---

### 2026-05-04 05:50 · B3 完成 — 画布关联连线

**commit**: `c5ffbf5` (feat(annotation): B3 画布关联连线（选中标注时高亮关系）)

**做了什么**

- AnnotationCanvas 加可选 `relations` prop（默认 []，向后兼容）
- 新增 `RelationLines` 子组件，渲染在 Stage 内、与 SamPromptOverlay /
  CalibrationOverlay 同层
- 选中标注 → 从其几何中心画线到所有相关标注几何中心：
  * manual 关系：橙色实线（粗 2）
  * 自动 / AI 建议关系：青色虚线（粗 1.5，dash [6, 4]）
  * 起点端 + 各目标端都有小圆点
  * `listening={false}` 不拦截事件
- 跨 frame 关系：对方在 displayAnnotations 里（已校准 + 投影成功）才画线，
  否则跳过 —— 避免画到错位位置（与 B1 RelationsEditor "采纳" 流程相容）
- AnnotationWorkspace 用 `getRelations(doc)` 取关系，下发给 AnnotationCanvas
- 与 RelationsEditor 共享同一份 `doc.relations`

**怎么实现的**

- 复用 `displayAnnotations` 已经做完的"跨 frame 投影 + 过滤"逻辑：直接从中查
  对方标注，对方不在表里就视为不可见 / 不可投影
- 复用 `geometryCenter()` + `uvToScreen()` 取屏幕坐标
- 用 react-konva `<Group>` + `<Line>` + `<Circle>`，与已有 SAM / Calibration
  overlay 共用画布层

**下一步**

进入 **B4 — 知识图谱 tab**：
- 安装 `cytoscape` + `react-cytoscapejs` + 类型
- 新建 `KnowledgeGraphView` 组件：
  * 节点 = annotations（按 structuralLevel 着色）
  * 边 = doc.relations（按 kind 着色）
  * 选中节点 → 通过 onSelectAnnotation 让画布也选中
  * 默认布局 cose（力导向）；提供"重新布局"按钮
- AnnotationPanel 加新 tab "图谱"（在 列表 / 候选 / 标注 同级）
- 如果 React 19 与 react-cytoscapejs 类型有冲突，回退到直接 use cytoscape
  + useRef + useEffect

---

### 2026-05-04 06:10 · B4 完成 — 知识图谱 tab

**commit**: `64aef4e` (feat(annotation): B4 知识图谱 tab（Cytoscape.js 节点-边图）)

**做了什么**

- 新增依赖：`cytoscape ^3.x` + `@types/cytoscape`（dev）
- 不用 `react-cytoscapejs`：React 19 兼容性 + 完全控制 cy 生命周期需求
- 新建 `KnowledgeGraphView` 组件，AnnotationPanel 加 "图谱" tab
  （Network 图标 + 关系数 badge）
- 节点 = 标注，按 structuralLevel 着色（8 档）
- 边 = 关系，按 4 组（叙事 / 层级 / 空间 / 解释）着色
- origin != "manual" 的边显示虚线 + 半透明
- 默认 cose 力导向布局 + "适应窗口" / "重新布局" 按钮
- 双向联动：图上点节点 → 画布同步选中；画布选中 → 图上节点高亮（.is-selected）
  + 关联边高亮（.is-incident）

**怎么实现的**

- 直接调 cytoscape API：useRef + useEffect 接管 mount / destroy
- 用内容指纹（annotationsKey + relationsKey）做 useEffect 依赖：纯
  selectionId 变化只刷高亮（cy.batch + addClass / removeClass），不重建
  图，避免 layout 抖动
- onSelect 用 ref 持有，cy 监听器永远拿到最新回调，不重绑
- 防御性过滤：边两端必须都是已知 annotation；历史 doc 里悬空 source/
  target 自动跳过
- 图区高度 320 min；toolbar 显示节点 / 边数 + 操作按钮

**下一步**

B 方向 4 个子项全部完成，进入 **C 工程闭环**：
- C2 键盘快捷键（R/E/P/S/V/F/Ctrl+Z/Y/Delete/Esc）
- C6 候选 tab 类别 chip 过滤
- C5' alignment 状态在画像石下拉里显示
