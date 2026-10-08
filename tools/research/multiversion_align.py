"""Find cross-version correspondences; write review proposals, never silently accept them."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from multiversion_context import ROOT, OUT, WORK
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.services import previews

cv2.setNumThreads(1)
FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 16)
PARAMS = {'version': 'sift-review-1', 'edge': 1500, 'features': 6500, 'ratio': .74,
          'variants': ['blur3', 'blur9', 'inverse3']}


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding='utf-8')
    for retry in range(15):
        try:
            temp.replace(path)
            return
        except PermissionError:
            time.sleep(.1 * (retry + 1))
    raise RuntimeError(f'Cannot replace {path}')


def image(asset: dict) -> np.ndarray:
    path = previews.ensure_preview(asset['id'], asset['relpath'])
    data = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    if data is None:
        raise ValueError(f"Cannot decode {asset['id']}")
    return data


def features(asset: dict) -> dict:
    stamp = hashlib.sha256(json.dumps([PARAMS, asset['sha256'], asset['width'], asset['height']],
                                    sort_keys=True).encode()).hexdigest()[:20]
    path = WORK / 'features' / f"{asset['id']}-{stamp}.npz"
    if path.is_file():
        with np.load(path) as cached:
            return {key: cached[key] for key in cached.files}
    img = image(asset)
    scale = min(1, PARAMS['edge'] / max(img.shape[:2]))
    img = cv2.resize(img, (round(img.shape[1] * scale), round(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    result = {'size': np.array([img.shape[1], img.shape[0]])}
    sift = cv2.SIFT_create(nfeatures=PARAMS['features'], contrastThreshold=.018, edgeThreshold=12)
    for name in PARAMS['variants']:
        blur = 9 if name == 'blur9' else 3
        target = cv2.GaussianBlur(gray, (blur, blur), 0)
        target = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(10, 10)).apply(target)
        if name.startswith('inverse'):
            target = 255 - target
        keypoints, descriptors = sift.detectAndCompute(target, None)
        result[name + '_points'] = np.array([k.pt for k in keypoints], dtype=np.float32).reshape(-1, 2)
        result[name + '_descriptors'] = descriptors if descriptors is not None else np.empty((0, 128), np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **result)
    return result


def similarity(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    b = src - src.mean(0)
    a = dst - dst.mean(0)
    den = np.sum(b * b)
    if den <= 0:
        raise ValueError('Degenerate correspondence')
    p, q = np.sum(a * b) / den, np.sum(a[:, 1] * b[:, 0] - a[:, 0] * b[:, 1]) / den
    matrix = np.array([[p, -q], [q, p]])
    return np.c_[matrix, dst.mean(0) - matrix @ src.mean(0)]


def distributed(src: np.ndarray, dst: np.ndarray, distances: np.ndarray, size: np.ndarray) -> list[int]:
    chosen = []
    norm = dst / size
    for row in range(4):
        for col in range(5):
            candidates = [i for i, p in enumerate(norm) if i not in chosen
                          and min(4, int(p[0] * 5)) == col and min(3, int(p[1] * 4)) == row]
            if not candidates:
                continue
            center = np.array([(col + .5) / 5, (row + .5) / 4])
            chosen.append(min(candidates, key=lambda i: distances[i] / 400 + np.linalg.norm(norm[i] - center)))
    if len(chosen) < 8:
        for i in np.argsort(distances):
            if int(i) not in chosen:
                chosen.append(int(i))
            if len(chosen) >= min(12, len(src)):
                break
    return chosen


def match_pair(left: dict, right: dict, fs: dict[int, dict]) -> dict:
    result = {'left_asset_id': left['id'], 'right_asset_id': right['id'], 'stone_id': left['stone_id'],
              'left_filename': left['filename'], 'right_filename': right['filename'],
              'left_sha256': left['sha256'], 'right_sha256': right['sha256'], 'status': 'no-reliable-match'}
    if left['sha256'] and left['sha256'] == right['sha256']:
        if (left['width'], left['height']) != (right['width'], right['height']):
            raise ValueError('Identical original has inconsistent dimensions')
        result.update(status='identity-awaiting-review', method='original-sha256-identity',
                      sim_matrix=[[1, 0, 0], [0, 1, 0]], homography=np.eye(3).tolist(), rmse_original_px=0)
        return result
    lf, rf = fs[left['id']], fs[right['id']]
    candidates = []
    # Matching all polarity combinations accommodates dark carvings and light rubbing figures.
    for lv, rv in itertools.product(PARAMS['variants'], repeat=2):
        ld, rd = lf[lv + '_descriptors'], rf[rv + '_descriptors']
        if min(len(ld), len(rd)) < 30:
            continue
        matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=64))
        raw = matcher.knnMatch(rd, ld, k=2)
        good = [pair[0] for pair in raw if len(pair) == 2 and pair[0].distance < PARAMS['ratio'] * pair[1].distance]
        # Each reference keypoint can anchor one observation, not repeated pattern copies.
        unique = {}
        for m in sorted(good, key=lambda m: m.distance):
            unique.setdefault(m.trainIdx, m)
        good = list(unique.values())
        if len(good) < 35:
            continue
        src = np.array([rf[rv + '_points'][m.queryIdx] for m in good], np.float64)
        dst = np.array([lf[lv + '_points'][m.trainIdx] for m in good], np.float64)
        distances = np.array([m.distance for m in good])
        homography, keep = cv2.findHomography(src, dst, cv2.RANSAC, 3.5, maxIters=7000, confidence=.999)
        if homography is None:
            continue
        keep = keep.ravel().astype(bool)
        src, dst, distances = src[keep], dst[keep], distances[keep]
        if len(src) < 30:
            continue
        coverage_src = (np.ptp(src, axis=0) / rf['size']).tolist()
        coverage_dst = (np.ptp(dst, axis=0) / lf['size']).tolist()
        occupied = len({(min(3, int(x * 4)), min(3, int(y * 4))) for x, y in src / rf['size']})
        if min(coverage_src) < .22 or min(coverage_dst) < .16 or occupied < 5:
            continue
        selected = distributed(src, dst, distances, lf['size'])
        holdout = [i for i in range(len(src)) if i not in selected]
        if len(selected) < 6 or len(holdout) < 20:
            continue
        src_original = src / rf['size'] * [right['width'], right['height']]
        dst_original = dst / lf['size'] * [left['width'], left['height']]
        fit = similarity(src_original[selected], dst_original[selected])
        errors = np.linalg.norm(src_original[holdout] @ fit[:, :2].T + fit[:, 2] - dst_original[holdout], axis=1)
        normalized_p95 = float(np.percentile(errors, 95) / max(left['width'], left['height']))
        # Refit the projective model solely on the distributed control points, then validate unused matches.
        h, _ = cv2.findHomography(src_original[selected], dst_original[selected], 0)
        if h is None:
            continue
        h_errors = np.linalg.norm(cv2.perspectiveTransform(src_original[holdout].reshape(-1, 1, 2), h).reshape(-1, 2)
                                  - dst_original[holdout], axis=1)
        h_p95 = float(np.percentile(h_errors, 95) / max(left['width'], left['height']))
        if not np.isfinite(h).all() or h_p95 > .008:
            continue
        rmse = float(np.sqrt(np.mean(errors ** 2)))
        candidate = dict(method='SIFT-distributed-controls-independent-holdout',
            variants=[lv, rv], matched_count=len(good), inlier_count=len(src),
            source_coverage=coverage_src, reference_coverage=coverage_dst, occupied_source_cells=occupied,
            control_count=len(selected), holdout_count=len(holdout),
            sim_matrix=fit.tolist(), homography=(h / h[2, 2]).tolist(),
            rmse_original_px=rmse, similarity_p95_fraction=normalized_p95,
            projective_holdout_p95_fraction=h_p95,
            projective_holdout_rmse_px=float(np.sqrt(np.mean(h_errors ** 2))),
            pairs=[{'a': (dst[i] / lf['size']).tolist(), 'b': (src[i] / rf['size']).tolist()} for i in selected],
            status='similarity-awaiting-review' if normalized_p95 < .009 else 'projective-awaiting-review')
        # Coverage and support rank proposals; low residual alone cannot establish image identity.
        score = len(src) * min(coverage_src) * min(coverage_dst) / (1 + h_p95 * 100)
        candidates.append((score, candidate))
    if candidates:
        result.update(max(candidates, key=lambda c: c[0])[1])
    return result


def contact(stone: dict) -> None:
    assets = stone['assets']
    columns = min(4, len(assets))
    tile_width, tile_height = 340, 350
    sheet = Image.new('RGB', (columns * tile_width, math.ceil(len(assets) / columns) * tile_height + 38), 'white')
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 7), f"{stone['stone_id']} {stone['name']} · 来源总览（尚未作为配准验收）", font=FONT, fill='#111')
    for i, asset in enumerate(assets):
        img = Image.fromarray(cv2.cvtColor(image(asset), cv2.COLOR_BGR2RGB))
        img.thumbnail((tile_width - 12, tile_height - 64))
        x, y = (i % columns) * tile_width, (i // columns) * tile_height + 38
        sheet.paste(img, (x + (tile_width - img.width) // 2, y))
        caption = f"a{asset['id']} · {asset['kind']} · 已有SAM {asset['saved_segment_polygons']}"
        draw.text((x + 5, y + tile_height - 58), caption, font=FONT, fill='#111')
        draw.text((x + 5, y + tile_height - 35), asset['filename'][:25], font=FONT, fill='#333')
    (OUT / 'source-overviews').mkdir(exist_ok=True)
    sheet.save(OUT / 'source-overviews' / f"{stone['stone_id']}.jpg", quality=90)


def run_stone(stone: dict) -> dict:
    path = OUT / 'alignment-proposals' / f"{stone['stone_id']}.json"
    if path.is_file():
        saved = json.loads(path.read_text(encoding='utf-8'))
        if saved.get('params') == PARAMS:
            return saved
    assets = [a for a in stone['assets'] if not a['missing'] and a['width'] > 0 and a['height'] > 0]
    contact(stone)
    fs = {a['id']: features(a) for a in assets}
    proposals = []
    for a, b in itertools.combinations(assets, 2):
        # Prefer an existing master or a source with curated outlines as the reference.
        rank = lambda v: (bool(v['extra'].get('is_master')), v['saved_segment_polygons'], v['research_annotations'])
        left, right = (a, b) if rank(a) >= rank(b) else (b, a)
        proposals.append(match_pair(left, right, fs))
    result = {'stone_id': stone['stone_id'], 'params': PARAMS, 'assets': [a['id'] for a in assets],
              'proposals': proposals, 'reviewed': False}
    write(path, result)
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--stones', nargs='*')
    ap.add_argument('--workers', type=int, default=3)
    args = ap.parse_args()
    inventory = json.loads((OUT / 'inventory.json').read_text(encoding='utf-8'))
    stones = [s for s in inventory['stones'] if not args.stones or s['stone_id'] in args.stones]
    state = {'controller_pid': os.getpid(), 'started': time.time(), 'status': 'matching', 'total': len(stones), 'finished': []}
    write(WORK / 'alignment-process.json', state)
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            jobs = {pool.submit(run_stone, stone): stone['stone_id'] for stone in stones}
            for future in as_completed(jobs):
                result = future.result()
                counts = {status: sum(p['status'] == status for p in result['proposals'])
                          for status in sorted({p['status'] for p in result['proposals']})}
                print(result['stone_id'], json.dumps(counts), flush=True)
                state['finished'].append(result['stone_id'])
                state['updated'] = time.time()
                write(WORK / 'alignment-process.json', state)
        state['status'] = 'proposals-ready-for-review'
    except BaseException as error:
        state.update(status='error', error=repr(error))
        raise
    finally:
        state['updated'] = time.time()
        write(WORK / 'alignment-process.json', state)


if __name__ == '__main__':
    main()
