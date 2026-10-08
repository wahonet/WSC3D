"""Rasterize own-source region candidates and render every native boundary tile.

Outputs remain unaccepted proposals. An observed polygon is not proof of precise
boundaries; full source-native review and any necessary correction must follow.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.sam_worker import encode_native_mask
from multiversion_context import OUT
from multiversion_pixel_frames import validate_pixel_frame
from multiversion_sam import write


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main(jobs_path, boundaries_path, tag):
    assert tag.replace('-', '').isalnum()
    jobs = json.loads(jobs_path.read_text(encoding='utf-8'))
    boundaries = json.loads(boundaries_path.read_text(encoding='utf-8'))
    by_key = {(j['target_asset_id'], j['canonical_annotation_id']): j for j in jobs}
    index = []
    font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 18)
    for candidate in boundaries:
        key = (candidate['target_asset_id'], candidate['canonical_annotation_id'])
        job = by_key[key]
        frame = validate_pixel_frame(job)
        assert candidate['source_sha256'] == frame['source_sha256']
        assert candidate['crop_pixels'] == frame['crop_pixels']
        with Image.open(job['crop_path']) as source:
            crop = source.convert('RGB')
        points = np.asarray(candidate['crop_polygon_px'])
        assert points.ndim == 2 and points.shape[1] == 2 and len(points) >= 3
        assert np.isfinite(points).all() and np.equal(points, np.rint(points)).all()
        assert (points >= 0).all() and (points[:, 0] < crop.width).all() and (points[:, 1] < crop.height).all()
        binary = np.zeros((crop.height, crop.width), np.uint8)
        cv2.fillPoly(binary, [points.astype(np.int32)], 1)
        native = {**encode_native_mask(binary), 'extent': job['crop_extent']}
        x0, y0, x1, y1 = job['crop_extent']
        polygon = [[x0 + int(x) / crop.width * (x1 - x0), y0 + int(y) / crop.height * (y1 - y0)] for x, y in points]
        directory = OUT / 'stones' / job['stone_id'] / 'region-candidates' / tag
        directory.mkdir(parents=True, exist_ok=True)
        stem = f'{key[0]}-{key[1]}'
        proposal_path = OUT / 'native-proposals' / f"{job['stone_id']}-{stem}-manual-native-region-{tag}.json"
        assert not proposal_path.exists(), 'Candidate proposals are immutable'
        write(proposal_path, {'job': job, 'request': {'cmd': 'manual_own_source_region_candidate',
            'source_boundary_evidence': str(boundaries_path), 'source_boundary_evidence_sha256': digest(boundaries_path),
            'crop_polygon_px': points.tolist(), 'scope': candidate['scope'],
            'author_acceptance': False, 'native_review_required': True},
            'result': {'ok': True, 'detections': [{'native_mask': native, 'polygon': polygon, 'score': None}]},
            'weight_sha256': None, 'visual_reviewed': False})
        mask_path = directory / (stem + '-binary.png')
        rgba_path = directory / (stem + '-rgba.png')
        Image.fromarray(binary * 255).save(mask_path)
        rgba = crop.convert('RGBA'); rgba.putalpha(Image.fromarray(binary * 255)); rgba.save(rgba_path)
        eroded = cv2.erode(binary, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0)
        edge = binary > eroded
        tiles = []
        for ty in range(0, crop.height, 512):
            for tx in range(0, crop.width, 512):
                region = [tx, ty, min(tx + 512, crop.width), min(ty + 512, crop.height)]
                count = int(edge[ty:region[3], tx:region[2]].sum())
                if count:
                    tiles.append({'crop_pixels': region, 'edge_pixels': count})
        assert sum(t['edge_pixels'] for t in tiles) == int(edge.sum())
        pages = []
        for start in range(0, len(tiles), 6):
            page = Image.new('RGB', (2080, 1660), 'white')
            draw = ImageDraw.Draw(page)
            draw.text((4, 4), f'{stem} {tag}: original RGB | boundary, native 1:1 pixels', font=font, fill='black')
            for i, tile in enumerate(tiles[start:start + 6]):
                tx, ty, ex, ey = tile['crop_pixels']
                raw = crop.crop((tx, ty, ex, ey))
                overlay = np.array(raw)
                overlay[edge[ty:ey, tx:ex]] = [255, 0, 0]
                px, py = (i % 2) * 1040, 34 + (i // 2) * 542
                draw.text((px + 4, py), str(tile['crop_pixels']), font=font, fill='black')
                page.paste(raw, (px, py + 26)); page.paste(Image.fromarray(overlay), (px + 516, py + 26))
            page_path = directory / f'{stem}-boundary-page-{len(pages) + 1}.png'
            page.save(page_path); pages.append(str(page_path.relative_to(OUT)))
        overview = Image.new('RGB', (crop.width * 2, crop.height), (220, 220, 220))
        overview.paste(crop, (0, 0)); overview.paste(rgba, (crop.width, 0), rgba)
        overview.thumbnail((1600, 1800))
        overview_path = directory / (stem + '-overview.png'); overview.save(overview_path)
        index.append({'asset_id': key[0], 'canonical_annotation_id': key[1],
            'proposal': str(proposal_path.relative_to(OUT)), 'binary': str(mask_path.relative_to(OUT)),
            'rgba': str(rgba_path.relative_to(OUT)), 'overview': str(overview_path.relative_to(OUT)),
            'boundary_pixels': int(edge.sum()), 'tiles': tiles, 'pages': pages,
            'status': 'unaccepted_candidate_requires_independent_native_review'})
        print(f'{stem}: {len(pages)} pages, {int(edge.sum())} boundary pixels', flush=True)
    write(OUT / 'stones' / jobs[0]['stone_id'] / 'region-candidates' / tag / 'index.json', index)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs', type=Path, required=True)
    parser.add_argument('--boundaries', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    main(args.jobs, args.boundaries, args.tag)
