# WSC3D v0.4.0 — AI 加深：SAM 多 prompt · AI 线图 · YOLO 批量候选

> 发布日期：2026-05-04
> 对应计划：M3 第二波，见 [`ROADMAP.md`](ROADMAP.md) 第 2 节
> 上一发布：[`v0.3.0`](RELEASE_NOTES_v0.3.0.md) — AI 标注闭环 · 多源底图 · 4 点对齐校准

本次发布是 v0.3.0 之后的深化迭代，目标是把 AI 在标注流程里的"参与度"再拉一个量级：

1. **SAM 多 prompt 工作流**：从"单击立即出"升级为"组合多个正点 / 负点 / box 一次提交"，
   候选精修能力大幅提升
2. **AI 线图叠加**：高清图模式下可叠加半透明 Canny 线图，浅浮雕轮廓辨识效率显著提升
3. **YOLO 批量候选**：一键把整张画像石的 bbox 候选拉出来落入候选 tab，再用 SAM 精修
   形成"AI 启动 → 人工 + AI 协同精修 → 入库"的完整管线

---

## 1. SAM 多 prompt（A1）

### 1.1 后端

`ai-service/app/sam.py · _run_predictor` 现在接收完整 prompts 数组：

- 把所有 `point` 收集成 numpy `point_coords + point_labels`
- 至多 1 个 `box` 与 points 一起送给 mobile-sam SamPredictor.predict
- 多 prompt 时 `multimask_output=False` 避免"小/中/大" 3 mask 启发式干扰
- 启发式选 mask 的参考点改用第一个正点（或 box 中心）
- 响应增加 `promptCounts: { positive, negative, box }` 便于前端写 generation 元数据

### 1.2 前端

`sam.ts` 重构：

```ts
type SamPromptDraft = {
  points: Array<{ uv: UV; label: 0 | 1 }>;
  box?: { startUv: UV; endUv: UV };
};
```

截图路径与高清图路径都接收同一个 draft；UV → 像素的换算放在 sam.ts 里，前端
其他模块不感知。

`AnnotationCanvas` 加了 SAM 采点状态机（`samPromptDraft` + `samBoxLive`）：

- **左键**：加正点
- **右键**：加负点（仅 SAM 工具下；其他工具下右键仍走底图 pan）
- **Shift+左键拖动**：开始 box；mouseup 距离 < 4px 取消（防误触）
- **Enter**：提交；**Esc**：清空；**底部 hud**：撤销上一个 / 清空 / 取消 / 提交

画布的 `SamPromptOverlay`：

- 正点：绿色实心圆
- 负点：红色实心圆 + 中心 ✕
- 已确认 box：黄色虚线矩形
- 拖动中实时 box：更稀疏虚线（与已确认 box 区分）

底部居中 `SamPromptHud` 浮窗（与 calibration-hud 同结构、主色绿）：实时显示
"N 正点 / M 负点 / 1 框"；提交按钮显示"提交 SAM (total)"。

### 1.3 IIML 元数据

每条 SAM 候选的 `generation.prompt` 现在记录：

- `points: [[u, v], ...]`、`labels: [1, 0, 1, ...]`
- `box: [u1, v1, u2, v2]`（如果有）
- `positiveCount / negativeCount`（正负点计数）

为后续写入 IIML `processingRuns[]` 做了完整准备。

---

## 2. AI 线图叠加（A2）

### 2.1 后端

新增 `ai-service/app/canny.py · get_lineart_png(stone_id, low, high, max_edge)`：

- 复用 `sam.get_source_image_png` 拿转码 PNG（避免每次重读 178 MB 的 tif）
- 灰度 → GaussianBlur → cv2.Canny → 输出 RGBA（白线 + alpha 软渐变）
- 落盘缓存到 `ai-service/cache/lineart/{numeric}_canny_l{low}_h{high}_max{max_edge}.png`
- 源 PNG mtime 比缓存新会自动重新生成
- 不同阈值组合各自缓存，前端并发请求互不影响

新增端点 `GET /ai/lineart/{stone_id}?method=canny&low=60&high=140`。

### 2.2 前端

`SourceImageView` 加 `layer: "source" | "canny"` + `cannyOptions` props：

- `layer === "canny"` 时在原 `<img>` 之上叠加同 transform 的 Canny PNG
- `mix-blend-mode: screen` 让白线在暗色画像石上视觉通透
- `pointer-events: none` 不影响原有 pan / zoom 交互
- 缩放、平移、对齐校准等所有现有逻辑无影响（线图与原图像素一一对应，共享坐标系）

`AnnotationWorkspace` 在 `sourceMode === "image"` 时画布右上角 `source-switch`
下方再叠一个 mini segmented "原图 / +线图"。`imageLayer` 状态由 Workspace 持有，
不进 IIML 文档（纯视图态）。

---

## 3. YOLO 批量候选（A3）

### 3.1 后端

重写 `ai-service/app/yolo.py`：

- 模块级懒加载 YOLO 模型（`_load_model` 线程安全），避免每次推理重新加载
- `yolo_detect(image_base64, ...)` 走截图路径
- `yolo_detect_by_stone(stone_id, ...)` 走 `pic/` 高清图（复用 `get_source_image_png` 缓存）
- 输出统一加 `bbox_uv`（image-normalized，v 向下，与 SAM polygon 同约定）
- 失败时退化为 cv2.Canny 轮廓候选（model="yolo-fallback-contour"）

`POST /ai/yolo` 同时支持 `stoneId / imageBase64 / classFilter / confThreshold /
maxDetections`，结构与 SamRequest 同型。

### 3.2 前端

新增 `YoloScanDialog` 组件：

- 类别过滤：默认勾选 `yoloCocoUsefulClasses`（人物 / 鸟兽 / 常见物 30 种 COCO 子集）
- 置信度阈值：0.05 ~ 0.95，默认 0.25
- 最大检测数：5 ~ 200，默认 60
- 提交时 dialog 内置忙状态防双击；明确告知"通用模型作 SAM 二次精修起点"

工具栏加 `Radar` 图标按钮触发 dialog。

`App.tsx · handleSubmitYoloScan` 把 detections 转 candidate IimlAnnotation：

```ts
{
  type: "BBox",
  coordinates: detection.bbox_uv,  // 直接当 BBox UV
  reviewStatus: "candidate",
  frame: 当前 sourceMode,
  generation: {
    method: "yolo",
    model: "yolov8n",
    confidence: detection.confidence,
    prompt: { stoneId, classFilter, confThreshold, label }
  }
}
```

每个候选自动落入候选 tab，可与 SAM 候选一起多选合并、单条 SAM 精修。

---

## 4. 工程

### 4.1 新增依赖 / 模块

- 新增前端：`YoloScanDialog.tsx`
- 后端：`yolo.py` 重写、`canny.py` 重写、`main.py` 加 `/ai/lineart`、`/ai/yolo` 改型
- 没有新 npm 依赖（polygon-clipping 在 v0.3.0 已加）；ultralytics 在 v0.3.0 之前的 `requirements.txt` 已存在

### 4.2 缓存

`ai-service/cache/` 现在有两个子目录（都 gitignore）：

- `source/`：高清图 tif → PNG 转码缓存（v0.3.0 引入）
- `lineart/`：基于 source 缓存的 Canny PNG（本版引入）

YOLO 不需要单独缓存（一次推理 < 10s，候选直接落入 IIML）。

---

## 5. 一个完整的 v0.4.0 标注工作流

> 假设你刚拿到一块新画像石的 3D 模型 + 高清图。

1. **进标注模式**，画布右上切到"高清图"
2. **工具栏 `Radar` 按钮** → YOLO 批量扫描 → dialog 设阈值（人物 / 鸟兽 / 常见物
   保留勾选）→ 几秒后落入 ~30 个 BBox 候选
3. **候选 tab** 里浏览，把肯定不是研究对象的批量拒绝（人物边的 "umbrella" 之类）
4. **画布右上切到 "+线图"** → 浅浮雕轮廓被白线突出 → 切回"原图"或保持线图模式都行
5. **每个候选 BBox 上点 SAM 工具**，左键正点核心、右键负点排除背景、必要时 Shift
   拖框限定区域 → Enter 提交 → 候选 BBox 升级为精确 polygon
6. **多选合并**：被切成多片的人物（左半身 + 右半身）勾选 → "合并选中" → 自动并集
7. **接受 / 重命名 / 写图像志三层**：在标注详情面板写前图像志 / 图像志 / 图像学
8. **切到 3D 模型模式查看**：如果之前完成了 4 点对齐校准，所有标注都能投影到 3D
   模型上；没校准就先点工具栏 Crosshair 做一次

---

## 6. 已知限制 / 待改进

- **YOLO 模型偏弱**：COCO 80 类对汉画像石"祥瑞 / 礼器 / 车马"识别精度低；专门
  针对汉画像石微调留给后续版本（M3 后续阶段）
- **AI 线图只支持 Canny**：Sobel / HED / Relic2Contour 留给后续版本，端点已留
  `method` 参数预留扩展
- **SAM 多 prompt 暂不显示 prompt 编号**：用户想"撤销倒数第二个点"得连续按多次
  撤销；后续可以加 hover 悬浮删除单点的能力
- **YOLO 候选无类别过滤 UI**：候选 tab 不能按 label 筛选；候选数 > 30 时浏览压力
  大，下个版本会在候选 tab 加类别 chip 过滤
- 主 chunk 仍 > 600 KB；引入 YoloScanDialog 后基本持平
- ai-service 未 hot-reload 时改动 `yolo.py / canny.py / sam.py / main.py` 后需
  重启服务（带 `--reload` 启动则自动）

---

## 7. 数据兼容

- 历史 SAM 候选的 `generation.prompt` 缺少 `positiveCount / negativeCount` 字段：
  渲染 / 列表显示无影响；需要这些字段做 processingRuns 时按缺省值 1 / 0 处理
- 新增的 YOLO 候选 `generation.method = "yolo"`：与 SAM 候选可在候选 tab 同 list
  审阅，UI 通过 `label` 与 `model` 字段区分来源
- IIML schema 已经允许 `additionalProperties`，所有新字段无破坏性落盘

---

## 8. 验收要点

进标注模式后依次试：

1. **SAM 多 prompt**：高清图模式下点 SAM → 左键点 2 个正点 + 右键点 1 个负点 →
   Enter 提交 → 候选轮廓应同时满足"包含 2 个正点 / 排除 1 个负点"
2. **SAM box+点组合**：Shift+左键拖动出框框住一个完整人物 → 在框内点 1 个负点排
   除背景的衣饰阴影 → Enter 提交 → 候选边缘应紧贴人物轮廓
3. **AI 线图**：切到高清图 → "+线图" → 应看到白色 Canny 线条叠加在原图上突出
   浅浮雕轮廓；切回"原图"线图消失
4. **YOLO 扫描**：工具栏 Radar → 默认设置开始扫描 → 几秒后候选 tab 出现 N 个
   "YOLO 候选：person / horse / ..." 等条目
5. **闭环**：YOLO 出的 BBox 候选 → 接受为正式标注，或在画布上用 SAM 工具点开
   它再二次精修；与 SAM 候选混合多选合并应该正常

---

## 9. 下一步

完整规划见 [`ROADMAP.md`](ROADMAP.md)。简要：

- M3 剩余：标注间关系（IIML relations）、空间关系自动推导、多解释并存、
  知识图谱可视化（Cytoscape.js）、共现术语推荐
- M4：多资源版本切换（原图 / RTI / 拓片 / 线图 / 法线图）、IIIF / COCO / `.hpsml`
  导出
- 工程：Playwright 端到端覆盖 SAM 多 prompt + YOLO + 合并 + 校准 全流程；主
  chunk 进一步拆分（StoneViewer 也 lazy）

本次 **未自动打 git tag**，等待 QA 验收后由用户决定是否打 `v0.4.0` tag。
