# -*- coding: utf-8 -*-
"""统一对齐坐标系的相似变换工具。

约定：每块石头有一张"主图"（master，默认为分辨率最高的全幅照片）。
每个 2D 资产在 extra["align_to_master"] 中存一条相似变换 M：
    本资产像素坐标 -> 主图像素坐标
    M(p) = s * R(theta) * p + t
主图自身为恒等变换。跨图投影：q_target = M_target^{-1}( M_source(p_source) )。
"""
from __future__ import annotations

import math

Sim = dict  # {"s": float, "theta_deg": float, "tx": float, "ty": float}


def identity() -> Sim:
    return {"s": 1.0, "theta_deg": 0.0, "tx": 0.0, "ty": 0.0}


def apply(t: Sim, x: float, y: float) -> tuple[float, float]:
    th = math.radians(t["theta_deg"])
    c, s = math.cos(th), math.sin(th)
    k = t["s"]
    return (k * (c * x - s * y) + t["tx"],
            k * (s * x + c * y) + t["ty"])


def compose(a: Sim, b: Sim) -> Sim:
    """先 b 后 a：compose(a, b)(p) = a(b(p))"""
    th_a = math.radians(a["theta_deg"])
    c, s = math.cos(th_a), math.sin(th_a)
    tx = a["s"] * (c * b["tx"] - s * b["ty"]) + a["tx"]
    ty = a["s"] * (s * b["tx"] + c * b["ty"]) + a["ty"]
    return {"s": a["s"] * b["s"],
            "theta_deg": a["theta_deg"] + b["theta_deg"],
            "tx": tx, "ty": ty}


def invert(t: Sim) -> Sim:
    th = math.radians(t["theta_deg"])
    c, s = math.cos(th), math.sin(th)
    k = 1.0 / t["s"]
    # p = R(-th)/s * (q - t)
    tx = -k * (c * t["tx"] + s * t["ty"])
    ty = -k * (-s * t["tx"] + c * t["ty"])
    return {"s": k, "theta_deg": -t["theta_deg"], "tx": tx, "ty": ty}


def ellipse_points(g: dict, n: int = 32) -> list[list[float]]:
    """椭圆 {cx, cy, rx, ry}（归一化）采样为多边形顶点：投影与包含判断统一按多边形处理。"""
    cx, cy, rx, ry = g["cx"], g["cy"], g["rx"], g["ry"]
    return [[cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n)] for i in range(n)]
