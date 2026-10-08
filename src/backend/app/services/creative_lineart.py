"""AI-assisted line art: reference preparation, prompts and post-processing.

Seedream draws a candidate from the annotation crop; everything else here is
local image processing, so a candidate can be re-cleaned without paying again.
"""
from __future__ import annotations
from io import BytesIO
import math

import cv2
import numpy as np
from PIL import Image, ImageOps

MIN_PIXELS, MAX_PIXELS = 3_686_400, 10_404_496

LINE_PROMPT = (
    '任务：把参考图（汉代画像石拓片局部）整理成白描线稿。\n'
    '画法：纯白背景，只用均匀、流畅的黑色单线勾勒外轮廓、五官、衣纹和器物结构；'
    '不要灰度、阴影、填色、网点、纸纹、石纹和竖向刻痕。\n'
    '忠于原石：人物和动物的数量、位置、姿态、朝向、比例，以及器物都与参考图一一对应；'
    '不新增任何人物、动物、器物或背景，不改变朝向；拓片残损、模糊处留白，不要臆补细节，也不要勾画残损斑块和锯齿边缘。\n'
    '造型保持汉画像石的简练概括，不要改画成明清工笔或戏曲人物。\n'
    '不写任何文字、榜题、印章、签名和边框。构图与参考图一致，主体占满画面。\n'
    '画面内容：{subject}'
)
COLOR_PROMPT = (
    '参考图是据汉代画像石整理的白描线稿。以它为底稿创作一幅博物馆电子文创插画。\n'
    '必须保持线稿中每个形象的数量、位置、姿态、朝向和器物，只在线稿上赋色和润饰，不新增人物、动物或器物。\n'
    '画面内容：{subject}\n风格：{style}\n'
    '平面化、非写实，避免摄影和三维游戏风；背景干净，四周略留空间。'
    '不要文字、字母、印章、标题、水印或边框。'
)


def size_for(width, height):
    """A Seedream pixel size with the reference's aspect ratio."""
    ratio = max(1/16, min(16, width / height))
    area = 4_200_000
    w = math.sqrt(area * ratio)
    h = w / ratio
    w, h = max(16, round(w / 16) * 16), max(16, round(h / 16) * 16)
    while w * h < MIN_PIXELS:
        w, h = w + 16, round((w + 16) / ratio / 16) * 16
    while w * h > MAX_PIXELS:
        w, h = w - 16, round((w - 16) / ratio / 16) * 16
    return f'{w}x{h}'


def reference(image, edge=1920, pad=.04):
    """Rubbing crop on white with stretched contrast; faint rubbings read better."""
    rgba = image.convert('RGBA')
    flat = Image.new('RGB', rgba.size, 'white')
    flat.paste(rgba, mask=rgba.getchannel('A'))
    gray = ImageOps.autocontrast(ImageOps.grayscale(flat), cutoff=(1, 0.5))
    margin = round(max(gray.size) * pad)
    gray = ImageOps.expand(gray, margin, fill=255)
    gray.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    if min(gray.size) < 512:
        scale = 512 / min(gray.size)
        gray = gray.resize((round(gray.width*scale), round(gray.height*scale)), Image.Resampling.LANCZOS)
    out = BytesIO()
    gray.convert('RGB').save(out, 'JPEG', quality=94)
    return out.getvalue(), gray.size


def clean(image, speck=None, dark=150, light=225, pad=.03):
    """Candidate → (white RGB line art, transparent black-ink RGBA).

    Background is flattened by a large blur, ink is soft-thresholded between
    `dark` and `light`, and specks smaller than `speck` pixels are removed.
    """
    gray = np.asarray(ImageOps.grayscale(image.convert('RGB')), dtype=np.float32)
    background = cv2.GaussianBlur(cv2.dilate(gray, np.ones((15, 15), np.uint8)), (0, 0), 25)
    flat = np.clip(gray / np.maximum(background, 1) * 255, 0, 255)
    ink = np.clip((light - flat) / (light - dark), 0, 1)
    binary = (ink > .35).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    speck = speck or max(12, round(gray.size * 2e-5))
    keep = np.zeros(count, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= speck
    # Soft pixels survive only next to a kept stroke, so the anti-aliasing stays.
    grown = cv2.dilate(keep[labels].astype(np.uint8), np.ones((3, 3), np.uint8))
    ink = ink * grown
    ys, xs = np.nonzero(ink > .2)
    if len(xs) == 0:
        raise ValueError('候选图中没有可用线条')
    margin = round(max(gray.shape) * pad)
    x0, y0 = max(0, xs.min()-margin), max(0, ys.min()-margin)
    x1, y1 = min(gray.shape[1], xs.max()+margin+1), min(gray.shape[0], ys.max()+margin+1)
    alpha = Image.fromarray(np.round(ink[y0:y1, x0:x1] * 255).astype(np.uint8), 'L')
    stencil = Image.new('RGBA', alpha.size, (0, 0, 0, 0))
    stencil.putalpha(alpha)
    white = Image.new('RGB', alpha.size, 'white')
    white.paste(Image.new('RGB', alpha.size, (20, 20, 20)), mask=alpha)
    return white, stencil


def coverage(stencil):
    """Share of the frame covered by ink; line art that is too dense is not line art."""
    alpha = np.asarray(stencil.getchannel('A'), dtype=np.float32) / 255
    return float(alpha.mean())


def compare(original, line, width=2400):
    """Side-by-side sheet and overlay used when reviewing a candidate."""
    a = original.convert('RGBA')
    base = Image.new('RGBA', a.size, 'white')
    base.alpha_composite(a)
    b = line.convert('RGBA').resize(a.size, Image.Resampling.LANCZOS)
    tinted = Image.new('RGBA', a.size, (200, 30, 30, 0))
    tinted.putalpha(b.getchannel('A') if 'A' in b.getbands() else ImageOps.invert(ImageOps.grayscale(b)))
    overlay = base.copy()
    overlay.alpha_composite(tinted)
    white = Image.new('RGBA', a.size, 'white')
    white.alpha_composite(b)
    sheet = Image.new('RGB', (a.width, a.height*3 + 40), 'white')
    for i, part in enumerate((base, white, overlay)):
        sheet.paste(part.convert('RGB'), (0, i*(a.height+20)))
    sheet.thumbnail((width, width*3), Image.Resampling.LANCZOS)
    return sheet
