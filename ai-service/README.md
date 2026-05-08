# WSC3D AI Service

标注模块的本地 AI 子服务，提供 SAM 智能分割、YOLO 候选检测、OpenCV 线图、高清图转码与图像质量检查。

当前代码结构：

- `app/main.py`：FastAPI 生命周期与 router 装配。
- `app/routers/`：按 health、inference、imagery、lineart 拆分 HTTP 入口。
- `app/resources.py`：pic/ 图源匹配、资源 URI 反解、PNG/preview 缓存。
- `app/sam.py`、`app/sam3_service.py`、`app/yolo.py`、`app/canny.py`：模型或算法本体。
- `app/quality.py`：图像质量指标计算。

## 启动

```bash
cd ai-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

根目录 `npm run dev` 会通过 `python -m uvicorn app.main:app --port 8010 --reload` 一并启动该服务。

## SAM 模型与权重

- 使用 [MobileSAM](https://github.com/ChaoningZhang/MobileSAM)（`vit_t`，约 39 MB）。
- 启动时在后台线程自动从 `https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt` 下载到
  `ai-service/weights/mobile_sam.pt`；只下载一次，之后直接加载。
- 下载完成前或下载失败时，`/ai/sam` 会自动回退到 OpenCV Canny + 轮廓检测的 fallback
  实现（`model: "mobile-sam-fallback-contour"`），前端候选闭环仍可跑通。
- 若处于断网环境，可手动把权重放到 `ai-service/weights/mobile_sam.pt`，启动时会直接加载。

## SAM3 概念分割

- `/ai/sam3` 使用官方 `sam3` 包，适合文本概念分割，例如“horse”“person”“bird”。
- SAM3 懒加载：只有第一次调用 `/ai/sam3` 时才加载/下载模型，不影响 `/ai/sam` 的 MobileSAM 交互式点选/框选。
- Windows 需要 `triton-windows`；`requirements.txt` 已用平台条件声明，并固定 `torch==2.11.0+cu128` / `torchvision==0.26.0+cu128`。
- 默认优先读取 `ai-service/weights/sam3/sam3.pt`；也可设置 `WSC3D_SAM3_CHECKPOINT` 指向其它本地 checkpoint。
- 若本地 checkpoint 不存在，服务会走 Hugging Face 下载。`facebook/sam3` 是 gated repo，需要先在 Hugging Face 通过访问审批并完成 `hf auth login`。
- 若 Hugging Face 在当前网络下超时，可先手动把 `sam3.pt` 放入 `ai-service/weights/sam3/`；或设置 `WSC3D_SAM3_HF_ENDPOINT` / 系统代理后重启服务再试。
- 本地安装助手：在项目根目录运行 `npm run setup:sam3`；若未登录 Hugging Face，可先设置 `$env:HF_TOKEN='hf_xxx'` 后再运行。
- 不在本机登录 Hugging Face 时，可从已获授权的环境取得 `sam3.pt`，再运行 `powershell -ExecutionPolicy Bypass -File ai-service/scripts/setup-sam3.ps1 -LocalCheckpoint D:\path\to\sam3.pt` 导入本地权重。

请求示例：

```json
{
  "stoneId": "29",
  "textPrompt": "horse",
  "threshold": 0.5,
  "maxResults": 20
}
```

## 健康检查

`GET /ai/health` 返回：

```json
{
  "ok": true,
  "service": "wsc3d-ai",
  "features": ["sam", "sam3", "yolo", "canny"],
  "sam": {
    "ready": true,
    "status": "ready",        // pending | downloading | loading | ready | error
    "model": "mobile-sam-vit-t",
    "detail": "mobile-sam-vit-t"
  },
  "sam3": {
    "ready": false,
    "status": "pending",
    "model": "sam3",
    "detail": ""
  }
}
```

前端在进入标注模式时轮询该端点，根据 `sam.ready` 决定 SAM 工具按钮是否亮起，
并在 `status` 为 `downloading / loading` 时给出"SAM 模型加载中…"的 UI 提示。

## SAM 接口

`POST /ai/sam`

```json
{
  "stoneId": "29",
  "imageBase64": null,
  "imageUri": "/assets/stone-resources/29/ortho-xxx.png",
  "prompts": [
    { "type": "point", "x": 512, "y": 384, "label": 1 }
  ]
}
```

- 输入优先级为 `imageUri > stoneId > imageBase64`。
- `imageUri`：正射图、拓片、法线图等任意本地资源 URI，由 `app/resources.py` 反解为本地文件。
- `stoneId`：按数字前缀从 `pic/` 匹配高清原图。
- `imageBase64`：截图 fallback，适合没有本地图源时临时使用。
- `prompts` 支持 `point` / `box` 以及高清图路径使用的 `point_uv` / `box_uv`，可多 prompt 组合。

返回：

```json
{
  "polygons": [[[u, v, 0], [u, v, 0], ...]],
  "confidence": 0.93,
  "model": "mobile-sam-vit-t"
}
```

坐标是图像归一化 `(u, v) ∈ [0, 1]²`，前端负责把它转换到 WSC3D 的 `modelBox` 归一化空间后写入 IIML。
