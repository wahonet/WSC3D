"""Exhibition textures for the 传承中心 fit-out, taken from the exhibition design renders.

Input : resources/reference/测绘与CAD/施工图纸/武氏祠汉文化保护传承中心项目展陈设计文件9.18改(2).pdf
Output: resources/authoring/heritage-center/textures/exhibit-<name>-color.jpg (+ -normal.jpg for the tiled finishes)
        resources/authoring/heritage-center/textures/exhibit-manifest.json (page and crop of every image)

Graphics (scroll, murals, rubbings, screens, paintings) are cut from the scheme renders; a crop given as four
corners is rectified, so walls seen at an angle come out square. Tiled finishes (starry ceiling, sand, dark
stone, carpet) are generated, since the renders show them only in perspective.
"""
from __future__ import annotations
import json
from pathlib import Path
import fitz
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

from prepare_center_textures import noise, panels, to_normal

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / 'resources/reference/测绘与CAD/施工图纸/武氏祠汉文化保护传承中心项目展陈设计文件9.18改(2).pdf'
OUT = ROOT / 'resources/authoring/heritage-center/textures'
PAGE_W = 3000

# name -> (page, crop, output size, note). A crop is (x0, y0, x1, y1) or four corners UL, LL, LR, UR,
# all as fractions of the page.
CROPS = {
    'scroll':        (4, (0.455, 0.08, 0.545, 0.78), (256, 1024), '序厅 金色光影长卷'),
    'charwall':      (4, (0.20, 0.30, 0.295, 0.58), (512, 768), '序厅 石材肌理文字墙'),
    'cloud':         (7, (0.885, 0.03, 0.985, 0.97), (256, 1024), '初影 汉代云气纹墙板'),
    'mural-chuying': (10, ((0.066, 0.175), (0.066, 0.925), (0.75, 0.785), (0.75, 0.50)), (2048, 512), '初影 画像石拓片巨幅墙'),
    'banner':        (15, (0.17, 0.16, 0.255, 0.84), (256, 1024), '初影 武氏祠标识幅'),
    'case-chuying':  (9, (0.06, 0.37, 0.25, 0.72), (768, 512), '初影 通柜内景'),
    'case-zhuying':  (18, (0.0, 0.5, 0.2, 0.72), (768, 384), '铸影 通柜内景'),
    'mural-chariot': (18, (0.79, 0.53, 0.99, 0.74), (1024, 384), '铸影 车马出行壁画'),
    'sandtable':     (23, (0.36, 0.725, 0.49, 0.795), (1024, 512), '立影 遗址沙盘木饰侧板'),
    'strata':        (23, (0.435, 0.46, 0.828, 0.592), (1536, 384), '立影 考古地层长墙'),
    'case-liying':   (23, (0.0, 0.41, 0.18, 0.60), (768, 512), '立影 通柜内景'),
    'relief-mural':  (26, ((0.385, 0.38), (0.385, 0.665), (0.72, 0.72), (0.72, 0.09)), (2048, 1024), '传影 车马出行画像石巨墙'),
    'goldline':      (29, (0.15, 0.0, 0.85, 0.44), (1024, 1024), '传影 金色线描发光顶'),
    'stele-gold':    (28, (0.355, 0.27, 0.50, 0.72), (512, 1024), '传影 玻璃罩双面画像石'),
    'stele-white':   (29, (0.426, 0.485, 0.571, 0.755), (512, 512), '传影 车马画像石'),
    'stone-relief':  (29, (0.79, 0.61, 0.915, 0.89), (512, 512), '传影 画像石残件'),
    'totem':         (33, (0.55, 0.30, 0.75, 0.80), (512, 1024), '尾厅 数字图腾墙'),
    'archaeo-wall':  (34, (0.345, 0.49, 0.395, 0.72), (256, 1024), '尾厅 探方考古厅书法墙面'),
    'poster':        (34, (0.03, 0.41, 0.17, 0.84), (512, 1024), '尾厅 考古展板'),
    'trench-box':    (34, (0.435, 0.59, 0.57, 0.75), (1024, 512), '尾厅 探方灯箱'),
    'lattice':       (37, (0.005, 0.24, 0.07, 0.47), (256, 512), '中型剧场 格栅灯箱'),
    'bamboo':        (40, (0.487, 0.465, 0.588, 0.72), (512, 768), '大型剧场 水墨竹林背景'),
    'screen-gold':   (41, (0.0, 0.36, 0.40, 0.74), (1024, 512), '小型剧场 金色 LED 屏（左半，镜像成整幅）'),
    'lantern':       (41, (0.572, 0.09, 0.645, 0.235), (256, 512), '小型剧场 环形灯笼板'),
    'vr':            (42, (0.50, 0.22, 0.565, 0.80), (256, 1024), 'VR 展厅 光影立柱'),
    'film':          (43, (0.672, 0.115, 0.97, 0.41), (1024, 512), '尾厅 沉浸观影画面'),
    'rubbing':       (43, (0.672, 0.555, 0.97, 0.745), (1024, 512), '画像石拓片（楼阁燕居）'),
    'painting1':     (45, (0.763, 0.465, 0.826, 0.715), (256, 512), '临时展厅 书画'),
    'painting2':     (45, (0.925, 0.465, 0.99, 0.715), (256, 512), '临时展厅 书画'),
    'painting3':     (44, (0.035, 0.11, 0.145, 0.74), (256, 1024), '临时展厅 书画'),
    'painting4':     (45, (0.343, 0.54, 0.392, 0.70), (256, 512), '临时展厅 书画'),
    'rubbing-wall':  (38, (0.36, 0.34, 0.64, 0.72), (1024, 1024), '武氏祠专题展厅 拓片墙面'),
    'shrine-stone':  (38, (0.44, 0.45, 0.575, 0.67), (512, 512), '武氏祠专题展厅 画像石展柜'),
}

# Visitors standing in front of a wall in the render: (source box, destination corner), fractions of the output.
PATCHES = {
    'mural-chuying': [((0.10, 0.52, 0.27, 1.0), (0.485, 0.52))],
}


def page_images(pages):
    doc = fitz.open(PDF)
    out = {}
    for p in sorted(pages):
        page = doc[p - 1]
        zoom = PAGE_W / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        out[p] = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    return out


def cut(im, crop, size):
    w, h = im.size
    if len(crop) == 4 and not isinstance(crop[0], tuple):
        x0, y0, x1, y1 = crop
        part = im.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
        return part.resize(size, Image.LANCZOS)
    quad = [c for x, y in crop for c in (x * w, y * h)]
    big = (size[0] * 2, size[1] * 2)
    return im.transform(big, Image.QUAD, quad, Image.BICUBIC).resize(size, Image.LANCZOS)


def patch(im, jobs, feather=0.18):
    w, h = im.size
    for (x0, y0, x1, y1), (dx, dy) in jobs:
        box = (round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h))
        part = im.crop(box)
        pw, ph = part.size
        ramp = np.minimum(np.arange(pw) + 1, np.arange(pw)[::-1] + 1) / (pw * feather)
        top = (np.arange(ph) + 1) / (ph * feather)
        alpha = np.clip(np.minimum(ramp[None, :], top[:, None]), 0, 1)
        im.paste(part, (round(dx * w), round(dy * h)), Image.fromarray((alpha * 255).astype(np.uint8)))
    return im


def save(name, image, height=None, strength=2.0):
    image.convert('RGB').save(OUT / f'exhibit-{name}-color.jpg', quality=88)
    if height is not None:
        Image.fromarray(to_normal(height, strength)).save(OUT / f'exhibit-{name}-normal.jpg', quality=92)


def stars(size=1024, seed=31):
    """Night sky for the 立影 / 尾厅 ceilings: 8 m per repeat, a few brighter stars and a faint haze."""
    r = np.random.default_rng(seed)
    sky = np.zeros((size, size, 3), np.float32)
    haze = noise(size, 256, 3, seed + 1)
    sky += (np.clip(haze - 0.45, 0, 1) * 60)[..., None] * np.array([0.8, 0.85, 1.0])
    img = Image.fromarray(np.clip(sky, 0, 255).astype(np.uint8))
    px = img.load()
    for _ in range(2600):
        x, y = r.integers(0, size, 2)
        v = int(120 + 135 * r.random() ** 3)
        warm = r.random() < 0.3
        c = (v, int(v * (0.92 if warm else 0.97)), int(v * (0.8 if warm else 1.0)))
        px[int(x), int(y)] = c
        if v > 220:
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                px[int(x + dx) % size, int(y + dy) % size] = tuple(int(k * 0.55) for k in c)
    return img


def sand(size=1024, seed=33):
    n1 = noise(size, 8, 4, seed); n2 = noise(size, 90, 3, seed + 1)
    base = np.array([196, 150, 102], np.float32)
    col = base[None, None, :] * (0.82 + 0.22 * n1 + 0.12 * n2)[..., None]
    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), n1 * 0.5 + n2 * 0.5


def carpet(size=1024, seed=35):
    n1 = noise(size, 4, 3, seed); n2 = noise(size, 120, 2, seed + 1)
    base = np.array([168, 96, 48], np.float32)
    col = base[None, None, :] * (0.9 + 0.12 * n1 + 0.08 * n2)[..., None]
    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), n1 * 0.3


def digital(rubbing):
    """影像交互厅: the rubbing re-lit as a blue interactive wall."""
    g = np.asarray(ImageEnhance.Contrast(rubbing.convert('L')).enhance(1.6), np.float32) / 255
    col = np.stack([20 + 70 * g, 60 + 150 * g, 110 + 145 * g], -1)
    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).filter(ImageFilter.SMOOTH)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pages = page_images({c[0] for c in CROPS.values()})
    manifest = {'source': str(PDF.relative_to(ROOT)).replace('\\', '/'), 'page_width_px': PAGE_W, 'images': {}}
    cuts = {}
    for name, (page, crop, size, note) in CROPS.items():
        cuts[name] = patch(cut(pages[page], crop, size), PATCHES.get(name, []))
        if name == 'screen-gold':
            wide = Image.new('RGB', (size[0] * 2, size[1]))
            wide.paste(cuts[name], (0, 0))
            wide.paste(cuts[name].transpose(Image.FLIP_LEFT_RIGHT), (size[0], 0))
            cuts[name] = wide
        save(name, cuts[name])
        manifest['images'][name] = {'page': page, 'crop': crop, 'size': size, 'use': note}
    save('digital', digital(cuts['rubbing']))
    save('stars', stars())
    s, h = sand(); save('sand', s, h, 1.5)
    c, h = carpet(); save('carpet', c, h, 1.0)
    col, h = panels((50, 48, 45), (2.5, 2.5, 2.5), 1.2, 0.6, joint=0.006, size_m=2.4, seed=41, speck=0.05)
    save('floor-dark', Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), h, 1.2)
    col, h = panels((132, 127, 118), (6, 6, 6), 0.9, 0.45, joint=0.01, size_m=2.4, seed=43, speck=0.22)
    save('stone-rough', Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), noise(1024, 12, 5, 44) + h * 0.3, 3.5)
    manifest['generated'] = ['digital', 'stars', 'sand', 'carpet', 'floor-dark', 'stone-rough']
    (OUT / 'exhibit-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print('exhibition textures ->', OUT, len(CROPS) + 6)


if __name__ == '__main__':
    main()
