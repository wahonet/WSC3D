# WSC3D v0.5.0 — 关系网络 · 知识图谱 · 工程闭环

> 发布日期：2026-05-04
> 对应计划：M3 第三波（关系网络）+ 工程稳定性
> 上一发布：[`v0.4.0`](RELEASE_NOTES_v0.4.0.md) — AI 加深：SAM 多 prompt · AI 线图 · YOLO 批量候选

v0.4.0 收尾后那两天事少，把先前讨论里挂着的两条线连续做掉：

1. **关系网络（B）**：从"独立标注"升级为"叙事网络" —— 标注间关系基础 + 空间关系
   自动推导 + 画布关联连线 + Cytoscape 知识图谱
2. **工程闭环（C）**：键盘快捷键 + 候选类别 chip 过滤 + alignment 状态在画像石
   下拉里显示

工作日志与时间线：[`WORK_LOG_post_v0.4.0.md`](WORK_LOG_post_v0.4.0.md)。

---

## 1. 关系网络（B 方向）

### 1.1 标注间关系基础（B1）

数据模型：

```ts
type IimlRelation = {
  id: string;
  kind: IimlRelationKind;  // 14 种受控词，分 4 组
  source: string;          // annotation id
  target: string;
  note?: string;
  origin: "manual" | "spatial-auto" | "ai-suggest";
  createdAt?: string;
  createdBy?: string;
};
```

受控关系词表（14 种 / 4 组）：

| 组 | kind |
|---|---|
| 叙事 narrative | holds / rides / attacks / faces |
| 层级 hierarchy | partOf / contains |
| 空间 spatial | nextTo / above / below / leftOf / rightOf / overlaps |
| 解释 interpret | alternativeInterpretationOf / manual |

UI：

- `RelationsEditor` 组件挂在 EditTab 末尾备注与删除按钮之间
- 显示当前标注作为 source（→）/ target（←）的关系列表
- inline 表单：分组下拉选 kind + 选目标标注 + 备注（可选）→ 写入 IIML
- 单条删除；点关系条目跳到对方标注
- store reducer 增 `add-relation` / `update-relation` / `delete-relation`
- delete-annotation 同步清掉涉及该标注的关系，避免悬空 source / target

### 1.2 空间关系自动推导（B2）

新增 `frontend/src/modules/annotation/spatial.ts · deriveSpatialRelations`。

**算法（纯运行时，不入库）**：

1. 每个标注算外接矩形 → 中心
2. 对每对标注按 4 步优先级判定：
   - 重叠率 > 15% → `overlaps`
   - 中心距 < 平均尺寸 × 0.5 → `nextTo`
   - 主导方向纵向（且距离 > 平均高 × 0.6）→ `above` / `below`
   - 否则横向 → `leftOf` / `rightOf`
3. 一对至多生成 1 条候选（避免噪声淹没 RelationsEditor）
4. 跨 frame（model + image）不比对（坐标系不可直接比）

候选通过 `RelationsEditor` 的"采纳"按钮升为 manual 关系入库（B1 已实装路径）。

### 1.3 画布关联连线（B3）

`AnnotationCanvas` 内新增 `RelationLines` 子组件：

- 选中标注 → 从其几何中心画线到所有相关标注几何中心
- manual 关系：橙色实线（粗 2）
- 自动 / AI 关系：青色虚线（粗 1.5，dash [6, 4]）
- 起点 + 各目标都有小圆点
- `listening={false}` 不拦截事件
- 跨 frame 关系：对方在 displayAnnotations 里（已校准 + 投影成功）才画线

复用 `displayAnnotations` 已经做完的"跨 frame 投影 + 过滤"逻辑：对方不在表里
就视为不可见 / 不可投影，不画错位线。

### 1.4 知识图谱 tab（B4）

新增依赖：`cytoscape ^3.x` + `@types/cytoscape`（dev）。

新建 `KnowledgeGraphView` 组件，AnnotationPanel 加 "图谱" tab（Network 图标
+ 关系数 badge）：

- 节点 = 标注，按 `structuralLevel` 着色（8 档）
- 边 = 关系，按 4 组（叙事 / 层级 / 空间 / 解释）着色
- `origin != "manual"` 的边显示虚线 + 半透明
- 默认 cose 力导向布局；提供"适应窗口"+ "重新布局"按钮

**双向联动**：

- 图上点节点 → onSelectAnnotation(id)，画布同步选中
- 画布选中 → 图上节点高亮（`.is-selected`）+ 关联边高亮（`.is-incident`）

工程取舍：

- 不用 react-cytoscapejs：React 19 兼容性 + 完全控制 cy 生命周期需求
- 内容指纹（annotationsKey + relationsKey）作为 useEffect 依赖：纯
  selectionId 变化只刷高亮，不重建图，避免 layout 抖动
- onSelect 用 ref 持有，cy 监听器永远拿到最新回调，不重绑

---

## 2. 工程闭环（C 方向）

### 2.1 键盘快捷键（C2）

App.tsx 顶层 useEffect 监听 window keydown，仅在 isAnnotationActive 时激活：

| 键位 | 行为 |
|---|---|
| `V` | select 工具 |
| `R` | rect 工具 |
| `E` | ellipse 工具 |
| `N` | poi**N**t 工具（s 给 SAM 占用） |
| `P` | pen 工具 |
| `S` | SAM 工具（仅 samStatus.ready 时） |
| `F` | 重置视角 |
| `Ctrl+Z` / `Cmd+Z` | undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | redo |

`Esc` / `Delete` / `Enter` 仍由 AnnotationCanvas 内部监听处理（清 SAM 采点
/ 清 pen / 提交 SAM / 删选中），全局层不重复。

防误触：

- 焦点在 input / textarea / select / contenteditable 时全部静默
- 标定流程（activeTool === "calibrate"）中不让工具切换键抢走
- SAM 未就绪时 S 键静默忽略

### 2.2 候选 tab 类别 chip 过滤（C6）

ReviewTab banner 下方加一组类别 chip：

- chip 数据：`candidates.map(a => a.label)` 去重 + 计数
- 点击 toggle 过滤，多选 OR；labelFilter 空 = 不过滤
- 候选数变动后自动剔除已不存在的 label
- "清除过滤" 链接靠右
- 当前过滤集合下没候选时显示提示

响应 v0.4.0 已知限制 #4：候选数 > 30 时浏览压力大。

### 2.3 alignment 状态在画像石下拉里显示（C5'）

后端：

- `iiml.ts · listAlignments(projectRoot)` 扫 `data/iiml/*.iiml.json`，仅解析
  `culturalObject.alignment.controlPoints` 做最小校验（≥ 4 点）
- 新端点 `GET /api/iiml/alignments` 返回 `{ stoneId: hasAlignment }` map

前端：

- `client.ts · fetchAlignmentStatuses()` 一次性拉所有状态
- App.tsx 启动时 prefetch；保存 / 清除对齐时同步更新本地 map
- 头部画像石下拉 option 文本前加 `✓ ` / `  ` 两字符前缀

---

## 3. 工程

### 3.1 新增依赖

- `cytoscape ^3.x`：知识图谱节点 / 边渲染（约 150 KB）
- `@types/cytoscape`（dev）

### 3.2 文件改动

新增：

- `frontend/src/modules/annotation/RelationsEditor.tsx`
- `frontend/src/modules/annotation/spatial.ts`
- `frontend/src/modules/annotation/KnowledgeGraphView.tsx`
- `docs/WORK_LOG_post_v0.4.0.md`（连续推进时间线，下次回来续做时先读这个）

修改：

- `frontend/src/api/client.ts`：IimlRelation 类型 + fetchAlignmentStatuses
- `frontend/src/modules/annotation/types.ts`：桥接 IimlRelation*
- `frontend/src/modules/annotation/store.ts`：reducer 加 3 个新 action +
  getRelations 工具
- `frontend/src/modules/annotation/AnnotationPanel.tsx`：加图谱 tab + 类别
  chip 过滤 + RelationsEditor 接入
- `frontend/src/modules/annotation/AnnotationCanvas.tsx`：加 relations prop
  + RelationLines
- `frontend/src/modules/annotation/AnnotationWorkspace.tsx`：getRelations
  下发给 Canvas
- `frontend/src/App.tsx`：annotationRelations + spatialCandidates +
  alignmentStatuses + 全局键盘监听
- `backend/src/services/iiml.ts`：listAlignments + IimlRelation 类型
- `backend/src/server.ts`：/api/iiml/alignments 路由
- `frontend/src/styles.css`：relations / knowledge-graph / review-filter-chip 样式

### 3.3 commit 时间线

```
a7c37b8 docs(work-log): C5' 完成 — alignment 状态显示
2d9bf06 feat(annotation): C5' alignment 状态在画像石下拉里显示
d6fa740 docs(work-log): C6 完成 — 候选类别 chip 过滤
cab90ac feat(annotation): C6 候选 tab 类别 chip 过滤
6b0f50d docs(work-log): C2 完成 — 键盘快捷键
3598918 feat(annotation): C2 键盘快捷键（工具切换 / 撤销重做 / fit 视角）
0381d5f docs(work-log): B4 完成 — 知识图谱 tab
64aef4e feat(annotation): B4 知识图谱 tab（Cytoscape.js 节点-边图）
7cd55e0 docs(work-log): B3 完成 — 画布关联连线
c5ffbf5 feat(annotation): B3 画布关联连线（选中标注时高亮关系）
2cfa943 docs(work-log): B2 完成 — 空间关系自动推导
5eb19b5 feat(annotation): B2 空间关系自动推导（纯运行时，不入库）
b7cea87 docs(work-log): B1 完成 — 标注间关系基础
796f6ee feat(annotation): B1 标注间关系基础（IIML relations）
```

---

## 4. 数据兼容

- 历史 IIML 文档没 `relations` 字段：按 `[]` 处理；新建关系才落盘
- 已存关系字段不全（缺 origin / createdAt 等）：`getRelations(doc)` 防御过滤
- delete-annotation 自动清涉及该标注的关系，避免悬空 source / target
- alignmentStatuses 状态仅前端 UI 提示，IIML 文档不变

---

## 5. 验收要点

进标注模式后依次试：

1. **添加关系**：选某条标注 → 详情面板末尾 RelationsEditor → 点 "+ 添加" →
   选 kind + 选目标 → 保存 → 列表出现一行 →（默认）画布上画橙色实线
2. **空间关系自动推导**：在多个标注中选一个 → 详情面板下方"空间关系自动推导"
   区列出推导出的关系（above/below 等）→ 点 "采纳" 升级为 manual
3. **关联连线**：选某条有关系的标注 → 画布上画橙色实线（manual）+ 青色虚线
   （自动）连到所有相关标注；点空白 deselect 后线消失
4. **知识图谱**：标注面板切到"图谱" tab → 看到节点（按层级着色）+ 边（按
   4 组着色）；点节点 → 画布同步选中；点空白 → 画布 deselect
5. **键盘快捷键**：在画布有焦点（先点画布）后按 R/E/P/N/S/V/F 测工具切换；
   `Ctrl+Z` 撤销新建标注；在 input 里按 R 不应触发工具切换
6. **候选类别过滤**：候选 tab 至少有 2 种 label 时 chip 出现；点 "person"
   chip → 列表只剩 person 候选；点 "清除过滤" 恢复
7. **画像石下拉对齐标记**：头部下拉 → 已校准的画像石名称前有 "✓ " 前缀

---

## 6. 已知限制

- 本次发布所有功能已经过 typecheck，但 **未做浏览器 / 端到端测试**；
  浏览器验收时如发现 UI 异常，参考 `docs/WORK_LOG_post_v0.4.0.md`
  找改动位置
- KnowledgeGraphView 在标注 / 关系数 > 200 时 cose 布局可能慢 1-2s；后续可加
  按数量切换布局（concentric / breadthfirst）
- 类别 chip 过滤目前只对候选 tab 生效；列表 tab 的 alignment / structural 分组
  过滤留待下个版本
- alignment 状态前缀用 ASCII 字符 "✓ " 而非 SVG 圆点，主要因为 HTML
  `<option>` 不支持复杂 markup
- B1 RelationsEditor 表单暂不支持"反向方向" toggle（必须先选当前标注作为
  source；要建"X holds 当前"得切到 X 上反向操作）

---

## 7. 下一步

详细规划见 [`ROADMAP.md`](ROADMAP.md)。简要：

- M3 收尾：共现术语推荐（基于 relations + terms 数据）；多解释并存的 UI
  专项打磨
- M4：多资源版本切换（原图 / RTI / 拓片 / 线图 / 法线图）、IIIF Web
  Annotation / COCO JSON / `.hpsml` 自定义研究包导出
- 工程：Playwright 端到端覆盖（SAM 多 prompt + YOLO + 合并 + 校准 + 关系
  + 图谱）；YOLO 微调汉画像石专用模型

本次 **未打 git tag**，等浏览器端验收完再决定是否打 `v0.5.0` tag。
