# WSC3D AI Service

标注模块的本地 AI 子服务（FastAPI，127.0.0.1:8010）。当前主线是三件事：

- **SAM3 文本概念分割**（`/ai/sam3`，平台唯一 AI 标注入口，懒加载）；
- **mask 合成**（`/ai/mask/compose`，人工补笔/擦除后的形态学清理与重新矢量化）；
- **图像服务**（tif→PNG 转码缓存、缩略图预览、5 种线图算法、图像质量检查）。

旧的 MobileSAM 交互分割（`/ai/sam`）、YOLO 批量检测（`/ai/yolo`）、base64 Canny（`/ai/canny`）已从主流程下线，默认返回 **410 Gone**；迁移旧数据或调试时设环境变量 `WSC3D_LEGACY_AI=1` 临时恢复（同时会恢复启动时的 MobileSAM 预加载和 health 里的旧 feature 上报）。

## 端点一览

```
GET    /ai/health                       健康检查 + SAM3 加载状态
POST   /ai/sam3                         SAM3 文本概念分割
POST   /ai/mask/compose                 mask 合成：几何 + 笔画 → 清理 → 矢量化
GET    /ai/source-image/{stone_id}      高清原图 tif→PNG 转码缓存（face 参数选面位）
GET    /ai/pic-preview                  pic 文件缩略图预览（绑定工作台用）
GET    /ai/quality/{stone_id}           图像质量指标（分辨率 / 曝光 / 清晰度）
GET    /ai/lineart/{stone_id}           线图 PNG（canny/sobel/scharr/morph/canny-plus）
GET    /ai/lineart/methods              支持的线图方法
POST   /ai/sam                          [legacy] 默认 410
POST   /ai/yolo                         [legacy] 默认 410
POST   /ai/canny                        [legacy] 默认 410
```

## 代码结构

- `app/main.py`：FastAPI 装配（仅 legacy 开启时预加载 MobileSAM）。
- `app/routers/`：按 health、inference、imagery、lineart 拆分 HTTP 入口。
- `app/sam3_service.py`：SAM3 概念分割（懒加载 + 线程锁，权重策略见下）。
- `app/mask_ops.py`：mask 合成——几何栅格化、add/erase 笔画叠加、闭/开运算、去小岛、填小洞、矢量化回带洞多边形，可选返回 mask / 抠图 / 缩略图 PNG。
- `app/resources.py`：pic/ 图源匹配（数字前缀 + 可选 `-面位`）、资源 URI 反解、source/preview 落盘缓存。
- `app/canny.py`：5 种线图算法本体 + 按 `stoneId×算法×阈值` 落盘缓存。
- `app/quality.py`：图像质量指标计算。
- `app/schemas.py` / `app/utils.py`：请求模型与公共工具。
- `app/sam.py`、`app/yolo.py`：[legacy] MobileSAM / YOLOv8n，默认不加载。

## 启动

```bash
cd ai-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt        # CPU 默认
uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

根目录 `npm run dev` 会通过 `.venv` 里的 python 一并启动该服务。

### CPU vs CUDA 依赖

- **CPU 默认**（`requirements.txt`）：安装最轻，不拉几个 GB 的 CUDA wheel。SAM3 在 CPU 上能跑但较慢。
- **CUDA 12.8 变体**（`requirements-cu128.txt`）：有 NVIDIA GPU 时换用 `pip install -r requirements-cu128.txt`，给 SAM3 推理提速（含 `torch==2.11.0+cu128` / `torchvision==0.26.0+cu128` / `triton-windows`）。
- `pyproject.toml` 与两个 requirements 文件保持对齐，CUDA 相关包只出现在 cu128 变体里。

## SAM3 概念分割

- `/ai/sam3` 使用官方 `sam3` 包做文本概念分割，例如 "horse" "person" "bird"（前端会把中文概念词自动扩展成英文同义词再提交）。
- **懒加载**：只有第一次调用 `/ai/sam3` 时才加载模型，不拖慢服务启动。
- 输入三选一，优先级 `imageUri > stoneId > imageBase64`：`imageUri` 支持正射图、拓片等任意本地资源 URI；`stoneId` 按数字前缀从 `pic/` 匹配高清原图。
- 权重查找顺序：先读本地 `ai-service/weights/sam3/sam3.pt`（可用 `WSC3D_SAM3_CHECKPOINT` 指向别处）；不存在则走 Hugging Face 下载。`facebook/sam3` 是 gated repo，需要先通过访问审批并完成 `hf auth login`。
- HF 网络不通时：手动把 `sam3.pt` 放进 `ai-service/weights/sam3/`，或设置 `WSC3D_SAM3_HF_ENDPOINT` / 系统代理后重启再试。
- 设备选择：`WSC3D_SAM3_DEVICE` 显式指定，否则自动探测 CUDA，不可用回落 CPU；CUDA 推理使用 bfloat16 autocast。
- 本地安装助手：项目根目录运行 `npm run setup:sam3`；未登录 HF 时可先设 `$env:HF_TOKEN='hf_xxx'`。也可从已授权环境拿到 `sam3.pt` 后运行 `powershell -ExecutionPolicy Bypass -File ai-service/scripts/setup-sam3.ps1 -LocalCheckpoint D:\path\to\sam3.pt` 导入。

请求示例：

```json
{
  "stoneId": "29",
  "textPrompt": "horse",
  "threshold": 0.5,
  "maxResults": 20
}
```

返回 `polygons`（归一化 UV 多边形）、`detections[{polygon,bbox,score}]`、`confidence`（top1 分数）与 `coordinateSystem`（`image-uv` 或 `modelbox-uv`，取决于输入来源）。

## 健康检查

`GET /ai/health` 返回：

```json
{
  "ok": true,
  "service": "wsc3d-ai",
  "features": ["sam3", "mask-compose", "lineart"],
  "sam3": {
    "ready": false,
    "status": "pending",     // pending | loading | ready | error
    "model": "sam3",
    "detail": ""
  },
  "legacyAi": false
}
```

设 `WSC3D_LEGACY_AI=1` 后，`features` 扩展为 `["sam3", "mask-compose", "lineart", "sam", "yolo", "canny"]`，并额外返回 MobileSAM 的 `sam` 状态。前端进入标注模式时轮询该端点决定 AI 工具是否亮起。

## 目录环境变量

- `WSC3D_PIC_DIR`：高清原图目录，默认 `<项目根>/pic`。
- `WSC3D_ROOT`：项目根，用于相对 URI 反解。
- 缓存落在 `ai-service/cache/`（source / preview / lineart 三类，按源文件 mtime 失效）。

## Legacy：MobileSAM / YOLO / Canny

代码保留但默认下线，仅在 `WSC3D_LEGACY_AI=1` 时可用：

- **MobileSAM**（`vit_t`，约 39 MB）：启动时后台线程自动从 GitHub 下载权重到 `ai-service/weights/mobile_sam.pt`，只下载一次；模型不可用时自动回退 OpenCV 轮廓 fallback。支持 `point` / `box` / `point_uv` / `box_uv` 多 prompt 组合，带按图源 key 的 embedding 内存缓存。
- **YOLOv8n**：原图 + CLAHE 增强图双跑后按 IoU 去重，权重优先读 `ai-service/yolov8n.pt`。
- **Canny**：base64 输入的单次线图，已被 `/ai/lineart/{stone_id}` 的缓存版取代。

历史标注文档里 `generation.method = "sam" / "yolo"` 的数据在前端仍正常显示与导出。
