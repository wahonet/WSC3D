from __future__ import annotations

from pydantic import BaseModel, Field


class SamPrompt(BaseModel):
    type: str
    x: float | None = None
    y: float | None = None
    u: float | None = None
    v: float | None = None
    label: int | None = 1
    bbox: list[float] | None = None
    bbox_uv: list[float] | None = None


class SamRequest(BaseModel):
    stoneId: str | None = None
    imageBase64: str | None = None
    imageUri: str | None = None
    prompts: list[SamPrompt] = Field(default_factory=list)


class Sam3Request(BaseModel):
    stoneId: str | None = None
    imageBase64: str | None = None
    imageUri: str | None = None
    textPrompt: str
    threshold: float = 0.5
    maxResults: int = 20


class YoloRequest(BaseModel):
    stoneId: str | None = None
    imageBase64: str | None = None
    imageUri: str | None = None
    classFilter: list[str] | None = None
    confThreshold: float = 0.10
    maxDetections: int = 80


class CannyRequest(BaseModel):
    imageBase64: str
    low: int = 60
    high: int = 140
