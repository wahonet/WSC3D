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


class MaskStroke(BaseModel):
    """人工补笔 / 擦除笔画：UV 折线 + 像素笔宽。"""

    mode: str = "add"  # "add" | "erase"
    pointsUv: list[list[float]] = Field(default_factory=list)
    widthPx: float = 12.0


class MaskCleanupOptions(BaseModel):
    """mask 合成后的形态学清理参数（像素单位，0 = 跳过该步骤）。"""

    closePx: int = 3
    openPx: int = 0
    minIslandPx: int = 64
    fillHolePx: int = 64
    simplifyTolerancePx: float = 2.0


class MaskComposeRequest(BaseModel):
    """P2 mask 级合成：base 几何 OR 补笔 AND NOT 擦除 → 清理 → 重新矢量化。

    - stoneId / imageUri 提供其一时在真实底图像素网格上合成，并可回传 cutout；
    - 都不提供时用 imageSize（[width, height]）建立空白网格，仅返回几何。
    """

    stoneId: str | None = None
    imageUri: str | None = None
    imageSize: list[int] | None = None
    baseGeometries: list[dict] = Field(default_factory=list)
    strokes: list[MaskStroke] = Field(default_factory=list)
    cleanup: MaskCleanupOptions | None = None
    returnMask: bool = True
    returnCutout: bool = False
