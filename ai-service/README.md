# WSC3D AI Service

标注模块的本地 AI 子服务，提供 SAM 智能分割、YOLO 候选检测和 OpenCV Canny 线图。

## 启动

```bash
cd ai-service
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

根目录 `npm run dev` 会尝试通过 `python -m uvicorn ai-service.app.main:app --port 8000 --reload` 同时启动该服务。
