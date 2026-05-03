from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, Field

from .canny import canny_line
from .sam import sam_segment
from .utils import ok_response
from .yolo import yolo_detect

app = FastAPI(title="WSC3D AI Service", version="0.1.0")


class SamPrompt(BaseModel):
    type: str
    x: float | None = None
    y: float | None = None
    label: int | None = 1
    bbox: list[float] | None = None


class SamRequest(BaseModel):
    imageBase64: str
    prompts: list[SamPrompt] = Field(default_factory=list)


class YoloRequest(BaseModel):
    imageBase64: str
    classFilter: list[str] | None = None


class CannyRequest(BaseModel):
    imageBase64: str
    low: int = 60
    high: int = 140


@app.get("/ai/health")
def health():
    return ok_response({"features": ["sam", "yolo", "canny"]})


@app.post("/ai/sam")
def sam(request: SamRequest):
    return sam_segment(request.imageBase64, [prompt.model_dump() for prompt in request.prompts])


@app.post("/ai/yolo")
def yolo(request: YoloRequest):
    return yolo_detect(request.imageBase64, request.classFilter)


@app.post("/ai/canny")
def canny(request: CannyRequest):
    return canny_line(request.imageBase64, request.low, request.high)
