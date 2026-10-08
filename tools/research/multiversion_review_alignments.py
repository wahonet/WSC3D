"""Create native-colour comparison sheets and a minimal registration forest for visual review."""
from __future__ import annotations
import json
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from multiversion_align import ROOT, OUT, image, write

FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 16)
cv2.setNumThreads(1)


def plausible(p, assets):
    if p['status'] == 'identity-awaiting-review':
        return True
    h = np.asarray(p['homography'])
    r, l = assets[p['right_asset_id']], assets[p['left_asset_id']]
    corners = np.array([[0, 0], [r['width'], 0], [r['width'], r['height']], [0, r['height']]], np.float64)
    den = np.c_[corners, np.ones(4)] @ h[2]
    if not np.isfinite(h).all() or np.linalg.det(h) <= 0 or min(den) <= 0 or max(den) / min(den) > 8:
        return False
    warped = cv2.perspectiveTransform(corners[:, None], h)[:, 0]
    area = cv2.contourArea(warped.astype(np.float32)) / (l['width'] * l['height'])
    if not .025 < area < 30:
        return False
    src = np.asarray([pair['b'] for pair in p['pairs']], np.float32)
    dst = np.asarray([pair['a'] for pair in p['pairs']], np.float32)
    # Spatial span alone can hide collinear or isolated matches.
    return min(cv2.contourArea(cv2.convexHull(src)), cv2.contourArea(cv2.convexHull(dst))) > .045


def rank(p):
    if p['status'] == 'identity-awaiting-review':
        return 1e9
    return p['inlier_count'] * min(p['source_coverage']) * min(p['reference_coverage']) / (
        1 + p['projective_holdout_p95_fraction'] * 300)


def render(stone, pairs):
    assets = {a['id']: a for a in stone['assets']}
    columns, width, height = 3, 460, 540
    for part in range(0, len(pairs), 3):
        batch = pairs[part:part+3]
        sheet = Image.new('RGB', (columns * width, len(batch) * height + 35), 'white')
        draw = ImageDraw.Draw(sheet)
        draw.text((8, 7), f"{stone['stone_id']} {stone['name']} · 原色来源与配准候选，待人工确认", font=FONT, fill='#111')
        for row, p in enumerate(batch):
            left, right = assets[p['left_asset_id']], assets[p['right_asset_id']]
            reference, source = image(left), image(right)
            h = np.eye(3) if p['status'] == 'identity-awaiting-review' else np.asarray(p['homography'])
            if p['status'] != 'identity-awaiting-review' and p['similarity_p95_fraction'] < .002:
                h = np.vstack([p['sim_matrix'], [0, 0, 1]])
            lp = np.diag([reference.shape[1] / left['width'], reference.shape[0] / left['height'], 1.])
            rp = np.diag([right['width'] / source.shape[1], right['height'] / source.shape[0], 1.])
            warped = cv2.warpPerspective(source, lp @ h @ rp, (reference.shape[1], reference.shape[0]))
            valid = cv2.warpPerspective(np.ones(source.shape[:2], np.uint8), lp @ h @ rp,
                                        (reference.shape[1], reference.shape[0]), flags=cv2.INTER_NEAREST).astype(bool)
            blend = reference.copy()
            blend[valid] = (reference[valid].astype(float) * .5 + warped[valid].astype(float) * .5).astype(np.uint8)
            for col, array in enumerate([reference, source, blend]):
                im = Image.fromarray(cv2.cvtColor(array, cv2.COLOR_BGR2RGB))
                im.thumbnail((width-12, height-97))
                sheet.paste(im, (col*width+(width-im.width)//2, 35+row*height))
            y = 35+row*height+height-89
            draw.text((8, y), f"左 a{left['id']} {left['filename'][:23]}", font=FONT, fill='#111')
            draw.text((width+8, y), f"右 a{right['id']} {right['filename'][:23]}", font=FONT, fill='#111')
            model = 'identity' if p['status'] == 'identity-awaiting-review' else 'similarity' if p['similarity_p95_fraction'] < .002 else 'projective'
            draw.text((width*2+8, y), f"50%叠加 · {model}", font=FONT, fill='#111')
            if model != 'identity':
                draw.text((width*2+8, y+23), f"留出{p['holdout_count']}点 · P95 {p['projective_holdout_p95_fraction']:.4%}", font=FONT, fill='#111')
            draw.text((8, y+49), f"{p['review_key']} · {p['status']}", font=FONT, fill='#444')
        sheet.save(OUT / 'alignment-review' / f"{stone['stone_id']}-{part//3+1}.jpg", quality=95)


def main():
    inventory = json.loads((OUT / 'inventory.json').read_text(encoding='utf-8'))
    plan, totals = [], Counter()
    (OUT / 'alignment-review').mkdir(exist_ok=True)
    for stone in inventory['stones']:
        saved = json.loads((OUT / 'alignment-proposals' / (stone['stone_id'] + '.json')).read_text(encoding='utf-8'))
        assets = {a['id']: a for a in stone['assets']}
        candidates = []
        for p in saved['proposals']:
            totals[p['status']] += 1
            if p['status'] == 'no-reliable-match' or not plausible(p, assets):
                continue
            candidates.append(p)
        parent = {a: a for a in assets}
        def root(a):
            while a != parent[a]:
                a = parent[a]
            return a
        chosen = []
        for p in sorted(candidates, key=rank, reverse=True):
            left, right = p['left_asset_id'], p['right_asset_id']
            if root(left) == root(right):
                continue
            parent[root(right)] = root(left)
            chosen.append({**p, 'review_key': f"{stone['stone_id']}-{left}-{right}"})
        components = {}
        for a in assets:
            components.setdefault(root(a), []).append(a)
        entry = {'stone_id': stone['stone_id'], 'components': list(components.values()), 'pairs': chosen,
                 'visual_reviewed': False, 'unmatched_assets': [c[0] for c in components.values() if len(c) == 1]}
        plan.append(entry)
        if chosen:
            render(stone, chosen)
        print(stone['stone_id'], 'review_pairs', len(chosen), 'separate_frames', len(components), flush=True)
    write(OUT / 'alignment-review-plan.json', {'proposal_totals': dict(totals), 'stones': plan, 'visual_reviewed': False})


if __name__ == '__main__':
    main()
