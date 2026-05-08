# SAM3 与训练池闭环工作日志

> 日期：2026-05-08  
> 分支：`main` 本地工作树，推送目标 `https://github.com/wahonet/WSC3D.git`  
> 主题：SAM3 CUDA 本地化、概念分割 UI、训练池导出可用性与可见性修复

---

## 1. 背景

标注工作台已经有 MobileSAM 点选、YOLO 候选和训练池导出，但这轮希望在汉画像石上直接输入“人物 / 马 / 鸟 / 车 / 纹饰”等概念，让 SAM3 自动给出候选区域。首次接入时遇到几个现实问题：

- `facebook/sam3` 是 gated repo，国内网络下 Hugging Face 登录和下载不稳定。
- 手动放置 `sam3.pt` 后，CUDA 推理出现 `BFLoat16 and Float` dtype mismatch。
- SAM3 对汉画像石图像上的“人物”不适合用普通 `person`，需要用 `human figure` / `figure` 等提示词扩展。
- 训练集导出虽然能执行，但状态反馈不可见，导出的目录和 CSV/COCO 文件对标注人员不直观。

---

## 2. SAM3 本地 CUDA 接入

### 2.1 运行环境

- AI 服务改为使用 `ai-service/.venv/Scripts/python.exe` 启动。
- `npm run dev` 中 AI 服务端口统一为 `8010`。
- Windows CUDA 环境固定到 PyTorch CUDA 版本，并补充 `triton-windows`。
- 新增 `npm run setup:sam3`，调用 `ai-service/scripts/setup-sam3.ps1`，用于检查 CUDA、导入本地 checkpoint 或走 Hugging Face 下载。

### 2.2 权重策略

SAM3 权重默认读取：

```text
ai-service/weights/sam3/sam3.pt
```

也支持用环境变量覆盖：

```text
WSC3D_SAM3_CHECKPOINT
WSC3D_SAM3_HF_ENDPOINT
```

如果没有本地权重，服务会给出明确错误，提示 gated repo 授权、`hf auth login` 或手动放置 `sam3.pt`。

### 2.3 dtype mismatch 修复

SAM3 在 CUDA 上会使用 BF16 路径。原先 `processor.set_image` / `processor.set_text_prompt` 混用 BF16 与 FP32，导致：

```text
RuntimeError: mat1 and mat2 must have the same dtype, but got BFLoat16 and Float
```

修复方式：

- CUDA 推理时使用 `torch.autocast(device_type="cuda", dtype=torch.bfloat16)` 包裹图像和文本提示。
- 将 BF16 tensor 转 numpy 前先 `.float()`。
- CPU 路径用 `nullcontext()` 保持原样。

验证结果：本地 `/ai/sam3` 不再因 dtype mismatch 失败。

---

## 3. 标注前端的 SAM3 体验

### 3.1 S3 图标与侧边面板

把原来点击 S3 后弹出的浏览器 prompt 改为工具栏侧边小面板：

- 图标改为更强的魔棒形态，带增强符号。
- 面板从 S3 右侧弹出，不再遮挡画布。
- 预置中文概念：
  - 人物 -> `human figure`
  - 马 -> `horse`
  - 鸟 -> `bird`
  - 兽 -> `animal`
  - 车 -> `chariot`
  - 纹饰 -> `decorative pattern`
- 可设置阈值、最大候选数、是否自动扩展提示词。

### 3.2 提示词扩展

实测汉画像石图像中：

- `person`、`human`、`man`、`woman` 容易返回 0。
- `human figure` 和 `figure` 对人物纹样更有效。
- `horse`、`bird` 可用，但阈值仍需灵活调整。

因此前端会在开启“扩展概念”时自动尝试多组提示词和较低阈值，降低“未找到区域”的概率。

---

## 4. 训练池导出语义调整

### 4.1 训练池不是 SAM3 在线训练

SAM3 本身不是在本项目里在线学习的模型。当前闭环是：

1. SAM3 / YOLO 生成候选。
2. 标注人员接受、拒绝或修正候选。
3. 通过训练池导出生成 COCO + IIML 双轨数据。
4. 后续用 YOLO-seg、Mask R-CNN、Mask2Former 等模型训练汉画像石专用模型。

### 4.2 证据源降级为 warning

原先训练准入把 `sources` 作为硬性错误，导致视觉训练数据被学术溯源字段挡住。调整后：

- `no-sources`
- `no-evidence-source`

都从 error 改为 warning。标注仍可进入训练池，但导出报告会保留质量提醒。

### 4.3 当前训练池准入重点

导出报告中最常见的阻塞包括：

- `bad-category`：类别未填。
- `no-terms`：受控术语未填。
- `pre-iconographic-too-short`：前图像志描述不足 10 字。
- `iconographic-too-short`：图像志描述不足 10 字。
- `review-status-candidate`：AI 候选尚未接受。
- `geometry-polygon-too-many-vertices`：轮廓顶点过多。

---

## 5. 导出反馈与目录可见性

### 5.1 状态条合并

原先“已保存”和“标注已保存 / 预检 / 导出结果”分成两个大框，影响右侧面板空间。已改为单条紧凑状态条：

- 左侧显示保存状态。
- 中间显示最近操作反馈。
- 右侧是图标保存按钮。

### 5.2 训练集目录按钮

训练集导出成功后，状态条右侧出现“目录”按钮。点击后调用：

```text
POST /api/training/reveal-dataset
```

在 Windows 上用 `explorer.exe` 打开：

```text
E:\WSC3D\data\datasets\wsc-han-stone-v0
```

同时导出接口返回 `absoluteDatasetDir`，悬停按钮可以看到完整绝对路径。

---

## 6. 验证

- `npm run typecheck` 通过。
- Playwright 验证：
  - SAM3 面板能从 S3 右侧弹出。
  - 预检和导出训练集请求能成功返回。
  - 状态条合并后高度约 38-40px。
  - 导出后出现“目录”按钮，并显示绝对路径。
- 后端直接请求验证：
  - `POST /api/training/export` 返回 `datasetDir` 与 `absoluteDatasetDir`。
  - `POST /api/training/reveal-dataset` 可打开本机目录。

---

## 7. 后续建议

1. 增加“一键把 SAM3 候选批量设为某类”的快速补字段操作，减少训练池准入的人工字段成本。
2. 为 `bad-category / no-terms / 两段说明过短` 提供批量修复面板。
3. 增加 YOLO-seg 训练脚本，将 `data/datasets/wsc-han-stone-v0/annotations/coco_train.json` 转换为训练配置。
4. AI 服务增加自定义 YOLO 权重环境变量，让训练后的汉画像石模型回流到标注工作台。
