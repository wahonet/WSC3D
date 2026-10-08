"""Tileable PBR textures for the 2026-09-25 heritage-centre rebuild.

Construction materials are retained for existing interiors and site elements.
The separate facade-* palette follows 02.pdf, pages 2-3: ivory vertical tooling,
warm brown piers and window surrounds, and a dark ribbed band below the eaves.
Output: resources/authoring/heritage-center/textures/<name>-color.jpg / -normal.jpg
"""
from __future__ import annotations
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/heritage-center/textures'
N = 1024
rng = np.random.default_rng(20260925)


def noise(size=N, scale=64, octaves=5, seed=None):
    """Tileable value noise by summing wrapped, upsampled random grids."""
    r = np.random.default_rng(seed) if seed is not None else rng
    total = np.zeros((size, size), np.float32)
    amp, weight = 1.0, 0.0
    cells = max(2, size // scale)
    for _ in range(octaves):
        grid = r.random((cells, cells)).astype(np.float32)
        img = Image.fromarray((grid * 255).astype(np.uint8)).resize((size, size), Image.BICUBIC)
        # Wrap-aware: tile 3x3 then crop the middle to avoid seams.
        big = np.tile(grid, (3, 3))
        im = Image.fromarray((big * 255).astype(np.uint8)).resize((size * 3, size * 3), Image.BICUBIC)
        layer = np.asarray(im, np.float32)[size:2 * size, size:2 * size] / 255
        total += layer * amp
        weight += amp
        amp *= 0.5
        cells *= 2
    return total / weight


def to_normal(height, strength=2.0):
    h = height.astype(np.float32)
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    nz = np.ones_like(h)
    n = np.stack([-dx, dy, nz], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return ((n * 0.5 + 0.5) * 255).astype(np.uint8)


def save(name, color, height, strength=2.0):
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(color, 0, 255).astype(np.uint8)).save(OUT / f'{name}-color.jpg', quality=88)
    Image.fromarray(to_normal(height, strength)).save(OUT / f'{name}-normal.jpg', quality=92)


def panels(base, spread, panel_w, panel_h, joint=0.012, size_m=2.4, seed=0, speck=0.06, veins=0.0):
    """Stone cladding: size_m metres per texture; running-bond panels with joints."""
    r = np.random.default_rng(seed)
    px = N / size_m
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    row = np.floor(yy / (panel_h * px)).astype(int)
    shift = (row % 2) * 0.5 * panel_w * px
    col = np.floor((xx + shift) / (panel_w * px)).astype(int)
    ids = (row * 131 + col * 17) % 997
    # Panels of one quarry lot differ mainly in lightness, barely in hue.
    tint = r.normal(0, 1, (997, 1)).astype(np.float32) + 0.25 * r.normal(0, 1, (997, 3)).astype(np.float32)
    color = np.array(base, np.float32)[None, None, :] + tint[ids] * np.array(spread, np.float32)
    grain = noise(scale=18, octaves=5, seed=seed + 1)
    color *= (1 - speck + 2 * speck * grain)[..., None]
    if veins:
        v = np.abs(np.sin((xx * 0.013 + yy * 0.004 + noise(scale=90, seed=seed + 2) * 9)))
        color *= (1 - veins * (v < 0.08))[..., None]
    fx = ((xx + shift) / (panel_w * px)) % 1
    fy = (yy / (panel_h * px)) % 1
    jw = joint / panel_w; jh = joint / panel_h
    joint_mask = (fx < jw) | (fx > 1 - jw) | (fy < jh) | (fy > 1 - jh)
    color[joint_mask] *= 0.78
    height = grain * 0.35
    height[joint_mask] -= 0.9
    return color, height


def stucco(base, seed):
    n1 = noise(scale=10, octaves=4, seed=seed)
    n2 = noise(scale=80, octaves=3, seed=seed + 7)
    color = np.array(base, np.float32)[None, None, :] * (0.93 + 0.1 * n1 + 0.05 * n2)[..., None]
    return color, n1 * 0.6


def barrel_tiles(seed=5):
    """Clay barrel tiles. Texture = 4 tile columns x 3 courses, u across slope."""
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    cols, courses = 4, 3
    u = (xx / N * cols) % 1          # 0..1 across one pan+cover pair
    v = (yy / N * courses) % 1       # along slope within a course
    course = np.floor(yy / N * courses).astype(int)
    colid = np.floor(xx / N * cols).astype(int)
    # Cover tile (筒瓦) occupies the middle 42 %; pan tile (板瓦) the gaps.
    d = np.abs(u - 0.5) / 0.21
    cover = d < 1
    h = np.where(cover, np.sqrt(np.clip(1 - d * d, 0, 1)) * 1.0, 0.12 - 0.1 * np.cos((u - 0.5) * np.pi * 2))
    # Overlap step at the lower end of each course.
    step = np.clip((v - 0.0) / 0.08, 0, 1)
    h = h * (0.75 + 0.25 * step) - (1 - step) * 0.25
    r = np.random.default_rng(seed)
    tint = r.normal(0, 1, (courses * cols * 4 + 8,)).astype(np.float32)
    idx = (course * cols + colid) % len(tint)
    base = np.array([86, 84, 80], np.float32)
    grime = noise(scale=40, octaves=4, seed=seed + 3)
    color = base[None, None, :] * (0.92 + 0.06 * tint[idx][..., None] + 0.16 * (grime[..., None] - 0.5))
    # Baked occlusion: crowns of the cover tiles catch light, pans sit in shade.
    shade = np.where(cover, 0.78 + 0.34 * np.sqrt(np.clip(1 - d * d, 0, 1)), 0.62 + 0.1 * np.cos((u - 0.5) * np.pi * 2))
    color *= shade[..., None]
    color *= (0.7 + 0.3 * step)[..., None]
    return color, h


def wood(base, seed):
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    n = noise(scale=24, octaves=4, seed=seed)
    grain = np.sin(yy * 0.09 + n * 14) * 0.5 + 0.5
    color = np.array(base, np.float32)[None, None, :] * (0.85 + 0.2 * grain + 0.08 * n)[..., None]
    return color, grain * 0.4


def pavers(base, spread, size_m=4.8, pw=0.6, ph=0.6, seed=11):
    return panels(base, spread, pw, ph, joint=0.008, size_m=size_m, seed=seed, speck=0.12)


def fluted_stone(base, seed, dark=False):
    """2.4 m repeat with 48 vertical tooled grooves, derived from the p3 facade.

    The colour carries the fine tooling at a distance; the normal map supplies
    shallow relief close up, without adding thousands of facade polygons.
    """
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    grain = noise(scale=12, octaves=4, seed=seed)
    phase = (xx / N * 48) % 1
    groove = np.exp(-((phase - 0.12) / 0.085) ** 2)
    ridge = 0.5 + 0.5 * np.cos(phase * 2 * np.pi)
    shade = 0.98 - groove * (0.14 if dark else 0.20) + (grain - 0.5) * 0.17 + ridge * 0.035
    color = np.array(base, np.float32)[None, None, :] * shade[..., None]
    height = ridge * 0.12 - groove * 0.30 + grain * 0.10
    if not dark:
        joint = (yy % (N / 2)) < 2  # restrained horizontal panel joint at 1.2 m
        color[joint] *= 0.82
        height[joint] -= 0.25
    return color, height


def main():
    save('stone-brown', *panels((122, 96, 74), (4, 3.5, 3), 1.2, 0.6, seed=1, speck=0.07), strength=2.2)
    save('stone-darkbrown', *panels((78, 62, 52), (3, 2.5, 2.5), 1.2, 0.6, seed=2, speck=0.06), strength=2.2)
    save('stone-gray', *panels((139, 136, 128), (3.5, 3.5, 3.5), 1.2, 0.6, seed=3, speck=0.08, veins=0.05), strength=2.2)
    save('stone-light', *panels((190, 181, 164), (3.5, 3.5, 3), 1.2, 0.6, seed=4, speck=0.05), strength=2.0)
    save('roof-membrane', *panels((92, 92, 90), (2, 2, 2), 3.0, 1.0, joint=0.02, size_m=6.0, seed=13, speck=0.12), strength=1.2)
    save('paint-light', *stucco((214, 206, 190), 5), strength=1.4)
    save('roof-tile', *barrel_tiles(), strength=5.0)
    save('ridge-tile', *panels((66, 64, 61), (3, 3, 3), 0.3, 0.3, joint=0.01, size_m=1.2, seed=6, speck=0.1), strength=2.5)
    save('wood-dark', *wood((64, 47, 36), 7), strength=1.6)
    save('granite', *panels((150, 148, 142), (6, 6, 6), 0.9, 0.45, joint=0.008, size_m=3.6, seed=8, speck=0.16), strength=2.4)
    save('paving', *pavers((168, 164, 154), (7, 7, 7)), strength=2.0)
    save('paving-dark', *pavers((112, 110, 106), (5, 5, 5), seed=12), strength=2.0)
    save('facade-ivory', *fluted_stone((216, 204, 181), 21), strength=2.0)
    save('facade-brown', *stucco((145, 104, 76), 22), strength=0.9)
    save('facade-frieze', *fluted_stone((69, 62, 53), 23, dark=True), strength=1.5)
    print('textures ->', OUT)


if __name__ == '__main__':
    main()
