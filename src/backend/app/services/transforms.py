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


def matrix(t: dict) -> list[list[float]]:
    if t.get('model') == 'homography':
        return t['homography']
    angle = math.radians(t['theta_deg'])
    a, b = t['s'] * math.cos(angle), t['s'] * math.sin(angle)
    return [[a, -b, t['tx']], [b, a, t['ty']], [0., 0., 1.]]


def inverse_matrix(h: list) -> list[list[float]]:
    a, b, c = h[0]; d, e, f = h[1]; g, j, k = h[2]
    cof = [[e*k-f*j, c*j-b*k, b*f-c*e], [f*g-d*k, a*k-c*g, c*d-a*f], [d*j-e*g, b*g-a*j, a*e-b*d]]
    det = a*cof[0][0] + b*cof[1][0] + c*cof[2][0]
    if not math.isfinite(det) or det == 0:
        raise ValueError('透视矩阵不可逆')
    out = [[v/det for v in row] for row in cof]
    if not all(math.isfinite(v) for row in out for v in row):
        raise ValueError('透视矩阵不可逆')
    return out


def homography(h: list) -> dict:
    if not isinstance(h, (list, tuple)) or len(h) != 3 or any(not isinstance(row, (list, tuple)) or len(row) != 3 for row in h):
        raise ValueError('透视矩阵须为 3×3')
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for row in h for v in row) or not h[2][2]:
        raise ValueError('透视矩阵须为有限数值')
    out = [[float(v/h[2][2]) for v in row] for row in h]
    inverse_matrix(out)
    # Legacy similarity fields describe a local approximation only. All mapping uses the matrix.
    a = out[0][0]-out[0][2]*out[2][0]; b = out[1][0]-out[1][2]*out[2][0]
    return {'model': 'homography', 'homography': out, 's': math.hypot(a, b),
            'theta_deg': math.degrees(math.atan2(b, a)), 'tx': out[0][2], 'ty': out[1][2]}


def validate_domain(t: dict, width: float, height: float) -> None:
    """Reject a horizon or reflection in the source rectangle before saving or rendering."""
    h = matrix(t)
    if width <= 0 or height <= 0 or not all(math.isfinite(v) for v in [width, height]):
        raise ValueError('图像尺寸须大于零')
    denominators = [h[2][0]*x+h[2][1]*y+h[2][2] for x, y in [(0, 0), (width, 0), (width, height), (0, height)]]
    inverse_matrix(h)
    a, b, c = h[0]
    det = a*(h[1][1]*h[2][2]-h[1][2]*h[2][1])-b*(h[1][0]*h[2][2]-h[1][2]*h[2][0])+c*(h[1][0]*h[2][1]-h[1][1]*h[2][0])
    if min(denominators) <= 1e-9 or max(denominators)/min(denominators) > 100 or det <= 0:
        raise ValueError('透视矩阵在本图内有反射、奇点或过度拉伸')


def apply(t: Sim, x: float, y: float) -> tuple[float, float]:
    if t.get('model') == 'homography':
        h = t['homography']
        den = h[2][0]*x+h[2][1]*y+h[2][2]
        if abs(den) < 1e-12:
            raise ValueError('投影点位于透视奇点')
        return ((h[0][0]*x+h[0][1]*y+h[0][2])/den, (h[1][0]*x+h[1][1]*y+h[1][2])/den)
    th = math.radians(t["theta_deg"])
    c, s = math.cos(th), math.sin(th)
    k = t["s"]
    return (k * (c * x - s * y) + t["tx"],
            k * (s * x + c * y) + t["ty"])


def compose(a: Sim, b: Sim) -> Sim:
    """先 b 后 a：compose(a, b)(p) = a(b(p))"""
    if a.get('model') == 'homography' or b.get('model') == 'homography':
        ma, mb = matrix(a), matrix(b)
        return homography([[sum(ma[i][k]*mb[k][j] for k in range(3)) for j in range(3)] for i in range(3)])
    th_a = math.radians(a["theta_deg"])
    c, s = math.cos(th_a), math.sin(th_a)
    tx = a["s"] * (c * b["tx"] - s * b["ty"]) + a["tx"]
    ty = a["s"] * (s * b["tx"] + c * b["ty"]) + a["ty"]
    return {"s": a["s"] * b["s"],
            "theta_deg": a["theta_deg"] + b["theta_deg"],
            "tx": tx, "ty": ty}


def invert(t: Sim) -> Sim:
    if t.get('model') == 'homography':
        return homography(inverse_matrix(t['homography']))
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
