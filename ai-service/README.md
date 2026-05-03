# WSC3D AI Service

标注模块的本地 AI 子服务，提供 SAM 智能分割、YOLO 候选检测和 OpenCV Canny 线图。

## 启动

```bash
cd ai-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

根目录 `npm run dev` 会通过 `python -m uvicorn app.main:app --port 8000 --reload` 一并启动该服务。

## SAM 模型与权重

- 使用 [MobileSAM](https://github.com/ChaoningZhang/MobileSAM)（`vit_t`，约 39 MB）。
- 启动时在后台线程自动从 `https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt` 下载到
  `ai-service/weights/mobile_sam.pt`；只下载一次，之后直接加载。
- 下载完成前或下载失败时，`/ai/sam` 会自动回退到 OpenCV Canny + 轮廓检测的 fallback
  实现（`model: "mobile-sam-fallback-contour"`），前端候选闭环仍可跑通。
- 若处于断网环境，可手动把权重放到 `ai-service/weights/mobile_sam.pt`，启动时会直接加载。

## 健康检查

`GET /ai/health` 返回：

```json
{
  "ok": true,
  "service": "wsc3d-ai",
  "features": ["sam", "yolo", "canny"],
  "sam": {
    "ready": true,
    "status": "ready",        // pending | downloading | loading | ready | error
    "model": "mobile-sam-vit-t",
    "detail": "mobile-sam-vit-t"
  }
}
```

前端在进入标注模式时轮询该端点，根据 `sam.ready` 决定 SAM 工具按钮是否亮起，
并在 `status` 为 `downloading / loading` 时给出"SAM 模型加载中…"的 UI 提示。

## SAM 接口

`POST /ai/sam`

```json
{
  "imageBase64": "data:image/png;base64,...",
  "imageUri": null,
  "prompts": [
    { "type": "point", "x": 512, "y": 384, "label": 1 }
  ]
}
```

- `imageBase64`：当前 M2 必填，前端从 Three.js canvas 截图。
- `imageUri`：为 M3-a 资源管理器接入高清图资源预留字段，后端会直接读本地文件，
  避免把 100 MB 原图塞进 base64 请求体。M2 暂未实现，传入会返回 400。
- `prompts`：目前只取第一个 prompt，支持 `point` 和 `box`；多点累积在 SAM 阶段 3 里实现。

返回：

```json
{
  "polygons": [[[u, v, 0], [u, v, 0], ...]],
  "confidence": 0.93,
  "model": "mobile-sam-vit-t"
}
```

坐标是图像归一化 `(u, v) ∈ [0, 1]²`，前端负责把它转换到 WSC3D 的 `modelBox` 归一化空间后写入 IIML。
