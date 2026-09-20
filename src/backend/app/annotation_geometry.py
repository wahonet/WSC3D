"""Validate stored annotation coordinates without clipping off-image geometry."""
from __future__ import annotations

import math


def validate_annotation_geometry(atype: str, geometry: dict) -> None:
    """Raise ValueError for malformed geometry; retain extra provenance fields."""
    if not isinstance(geometry, dict):
        raise ValueError("标注几何须为对象")

    def number(value) -> bool:
        try:
            return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
        except OverflowError:
            return False

    def fields(*names: str, positive: tuple[str, ...] = ()) -> None:
        if any(not number(geometry.get(name)) for name in names):
            raise ValueError(f"{atype} 的 {', '.join(names)} 须为有限数值")
        if any(geometry[name] <= 0 for name in positive):
            raise ValueError(f"{atype} 的 {', '.join(positive)} 须大于零")

    def point(value, dimensions: int) -> bool:
        return isinstance(value, (list, tuple)) and len(value) == dimensions and all(number(v) for v in value)

    if atype == "none":
        return  # The write path normalizes skeleton geometry to {}.
    if atype == "rect":
        fields("x", "y", "w", "h", positive=("w", "h"))
    elif atype == "ellipse":
        fields("cx", "cy", "rx", "ry", positive=("rx", "ry"))
    elif atype == "polygon":
        points = geometry.get("points")
        if not isinstance(points, (list, tuple)) or len(points) < 3 or not all(point(p, 2) for p in points):
            raise ValueError("多边形须包含至少三个二维点，坐标须为有限数值")
    elif atype in ("point", "point3d", "line", "line3d"):
        dimensions = 3 if atype.endswith("3d") else 2
        names = ("p",) if atype.startswith("point") else ("p1", "p2")
        if not all(point(geometry.get(name), dimensions) for name in names):
            raise ValueError(f"{atype} 的 {', '.join(names)} 须为 {dimensions} 维有限数值坐标")
    elif atype == "align":
        fields("s", "theta_deg", "tx", "ty", positive=("s",))
        if not math.isfinite(1 / geometry["s"]):
            raise ValueError("对齐缩放须可逆")
        if "rmse_px" in geometry and (not number(geometry["rmse_px"]) or geometry["rmse_px"] < 0):
            raise ValueError("对齐误差须为非负有限数值")
    else:
        raise ValueError("未知的标注几何类型")
