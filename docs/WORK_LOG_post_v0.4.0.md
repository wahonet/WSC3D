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
