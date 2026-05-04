# v0.5.0 之后连续推进工作日志（v0.6.0）

> 由 AI agent 在 2026-05-04 上午 11:49 起，**用户睡觉期间**连续推进。
> 用户已验收 v0.5.0，授权 "继续做下一步，不要停"。
> 每完成一个小节点追加一段，包含：做了什么 / 下一步打算 / 实现方式。
>
> **下一个接手的 agent 优先读本文件 + WORK_LOG_post_v0.4.0.md**。
>
> 主分支：`main` · 远程：`https://github.com/wahonet/WSC3D.git` · 代理：`http://127.0.0.1:18081`
>
> 起点 commit：`2f46c23` (docs(v0.5.0): release notes + README + ROADMAP + 工作日志收尾)

---

## 0. 整体计划与范围

按 ROADMAP `M3 剩余` + `M4 起步` + `工程闭环`，agent 自行划定 v0.6.0 范围如下：

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

- **多解释并存 UI 专项**：UI 复杂度大，需要用户设计讨论；alternative
  Interpretation 关系字段已支持，留 v0.7.0 做专门 tab
- **多资源版本切换 (M4-3.1)**：架构改动大（`coordinateSystem.transform`），
  需要先有 RTI / 拓片 / 法线图等真实资源；当前只有原图，做了空架子用处不大
- **Playwright 端到端**：需要稳定 dev server + ai-service，agent 离线
  无法验证；留给用户/下个 agent 在线时做
- **YOLO 微调汉画像石专用模型**：需要 1000+ 标注训练集 + 算力，不在 agent
  能做范围

### 操作纪律（与 v0.5.0 一致）

每个子节点：
1. typecheck 全绿
2. `git commit -F .git/COMMIT_EDITMSG_DRAFT`（用文件做 message，避免 PowerShell here-doc 问题）
3. `git -c http.proxy=http://127.0.0.1:18081 -c https.proxy=http://127.0.0.1:18081 push origin main`
4. 工作日志追加一段
5. 删 `.git/COMMIT_EDITMSG_DRAFT`

整体收尾：写 `RELEASE_NOTES_v0.6.0.md`，更新 `README.md` + `ROADMAP.md`。
**不打 git tag**，留给用户。

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
