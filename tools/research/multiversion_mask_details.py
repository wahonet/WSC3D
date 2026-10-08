"""Render full native-pixel boundaries for review instead of reducing them to a contact thumbnail."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw
from multiversion_sam import OUT, decode, FONT


def render(path, index, region=None, scale=1):
    saved = json.loads(path.read_text(encoding='utf-8'))
    job = saved['job']
    det = saved['result']['detections'][index]
    source = Image.open(job['crop_path']).convert('RGB')
    binary_native = decode(det['native_mask'])
    if binary_native.shape != (source.height, source.width):
        raise ValueError(
            f'Native boundary review requires the original pixel frame: '
            f'bitmap {binary_native.shape[::-1]} differs from RGB crop {source.size}. '
            'Do not resize a model mask and treat its overlay as native acceptance.'
        )
    mask = Image.fromarray(binary_native*255)
    if region:
        x0, y0, x1, y1 = region
        if not 0 <= x0 < x1 <= source.width or not 0 <= y0 < y1 <= source.height:
            raise ValueError('Region leaves the observed native source')
        source, mask = source.crop(region), mask.crop(region)
    if scale != 1:
        if scale not in (2, 3, 4):
            raise ValueError('Inspection scale must be 1..4')
        size = (source.width*scale, source.height*scale)
        source = source.resize(size, Image.Resampling.NEAREST)
        mask = mask.resize(size, Image.Resampling.NEAREST)
    binary = np.asarray(mask)>0
    h, w = binary.shape
    y, x = np.indices((h, w))
    checker = np.where(((y//12+x//12)%2)[..., None], [220, 220, 220], [247, 247, 247]).astype(np.uint8)
    cutout = np.asarray(source).copy()
    cutout[~binary] = checker[~binary]
    edge = cv2.dilate(binary.astype(np.uint8), np.ones((3, 3), np.uint8))-cv2.erode(binary.astype(np.uint8), np.ones((3, 3), np.uint8))
    overlay = np.asarray(source).copy()
    overlay[edge>0] = [255, 45, 30]
    sheet = Image.new('RGB', (w*3, h+60), 'white')
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 5), f"a{job['target_asset_id']} #{job['canonical_annotation_id']} {job['label']} · {path.stem} · detection {index}", font=FONT, fill='#111')
    for col, array in enumerate([np.asarray(source), cutout, overlay]):
        sheet.paste(Image.fromarray(array), (col*w, 60))
        draw.text((col*w+8, 31), ['原始区域', '完整掩膜切图', '边界复核'][col], font=FONT, fill='#111')
    suffix = '-region-'+'-'.join(map(str, region))+f'-{scale}x' if region else (f'-{scale}x' if scale != 1 else '')
    out = OUT/'native-details'/f'{path.stem}-{index}{suffix}.png'
    out.parent.mkdir(exist_ok=True)
    sheet.save(out)
    print(out, flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('proposal', type=Path)
    ap.add_argument('--index', type=int, default=0)
    ap.add_argument('--region', type=int, nargs=4)
    ap.add_argument('--scale', type=int, default=1)
    options = ap.parse_args()
    render(options.proposal, options.index, options.region, options.scale)
