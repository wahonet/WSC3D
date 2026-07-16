# 标注模块

图像志标注工作台：Konva 双底图画布（3D 模型 / 高清多资源）、SAM3 概念分割候选审阅、人工几何补正（矩形/圆/点/钢笔）、mask 补笔/擦除、4 点单应性对齐、受控术语与图像志三层文本、关系网络与 cytoscape 知识图谱、训练池准入校验与五种学术导出。

主要组件：

- `AnnotationWorkspace.tsx` 工作区（双底图 + 多资源切换 + 标定/mask 会话），画布在 `AnnotationCanvas.tsx`；
- `IimlPanel.tsx` 右侧 IIML 四层主面板（物理 → 视觉 → 图像学 → 文化，数据模型在 `iiml-layers.ts`）；
- `RegionEditor.tsx` 选中区域深编辑（类别/结构层级/审核状态/母题、三层文本与题刻、受控术语 `TermPicker`、证据源 `SourcesEditor`、训练细节、多解释 `AlternativeInterpretationsView`、关系 `RelationsEditor`、AI 记录 `ProcessingRunsList`）；
- 状态机在 `store.ts`（useReducer + undo 栈），编排逻辑在 `src/app/annotation/useAnnotationLogic.tsx`，容器在 `src/app/workspaces/AnnotationContainer.tsx`。
