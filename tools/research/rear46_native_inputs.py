"""Prepare original-pixel crops on an annotation's own source for finite review.

Existing geometry locates a crop only. It is never a segmentation or acceptance.
No inference, import, color enhancement, source rewrite, or upsampling occurs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

import numpy as np
from PIL import Image
from multiversion_context import ROOT, OUT, WORK
from multiversion_sam import write
from app.services.resources import asset_path
from app.native_masks import MAX_NATIVE_MASK_PIXELS

Image.MAX_IMAGE_PIXELS = None


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare(stone_id, ids, name, prompts, canonical_ids=None, observed_crop=None, crop_evidence=None):
    if stone_id not in [f'武{i:03d}' for i in range(8, 54)]:
        raise ValueError('Outside the fixed rear-hall scope')
    jobs = []
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        for annotation_id, canonical_id, prompt in zip(ids, canonical_ids or ids, prompts):
            row = dict(db.execute('SELECT * FROM annotations WHERE id=?', (annotation_id,)).fetchone())
            canonical = dict(db.execute('SELECT * FROM annotations WHERE id=?', (canonical_id,)).fetchone())
            if row['stone_id'] != stone_id or row['level'] not in ('figure', 'component'):
                raise ValueError('Own-source subject required')
            if canonical['stone_id'] != stone_id or canonical['level'] != row['level']:
                raise ValueError('Canonical aliases must retain stone and semantic level')
            asset = dict(db.execute('SELECT * FROM assets WHERE id=?', (row['asset_id'],)).fetchone())
            source_path = asset_path(asset['relpath'])
            if sha(source_path) != asset['sha256']:
                raise RuntimeError('Original source fingerprint changed')
            frame_path = WORK / 'native-frames' / f'{asset["id"]}-frame0.png'
            frame_path.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(source_path) as original:
                original.seek(0)
                size = original.size
                if size != (asset['width'], asset['height']):
                    raise RuntimeError('Recorded dimensions differ from selected original frame')
                rgb = original.convert('RGB')
                frame_meta = {'source_file': str(source_path), 'source_sha256': asset['sha256'],
                              'frame_index': 0, 'frame_count': getattr(original, 'n_frames', 1),
                              'original_mode': original.mode, 'original_size': list(size),
                              'working_size': list(size), 'working_conversion': 'Pillow RGB decode; no resize, enhancement or EXIF transform',
                              'icc_profile_sha256': hashlib.sha256(original.info['icc_profile']).hexdigest()
                              if original.info.get('icc_profile') else None}
                if frame_path.exists():
                    with Image.open(frame_path) as existing:
                        if existing.size != size or not np.array_equal(np.asarray(existing), np.asarray(rgb)):
                            raise RuntimeError('Previously saved native frame differs')
                else:
                    rgb.save(frame_path)
                geometry = json.loads(row['geometry'])
                if geometry.get('points'):
                    points = np.asarray(geometry['points'])
                elif all(key in geometry for key in ('x', 'y', 'w', 'h')):
                    x, y, w, h = [geometry[key] for key in ('x', 'y', 'w', 'h')]
                    points = np.asarray([[x, y], [x+w, y], [x+w, y+h], [x, y+h]])
                else:
                    raise ValueError('No localization geometry')
                low, high = points.min(0), points.max(0)
                margin = np.maximum((high-low) * .18, [.01, .01])
                low, high = np.maximum(0, low-margin), np.minimum(1, high+margin)
                pixels = [int(np.floor(low[0]*size[0])), int(np.floor(low[1]*size[1])),
                          int(np.ceil(high[0]*size[0])), int(np.ceil(high[1]*size[1]))]
                if observed_crop is not None:
                    assert len(ids) == 1 and crop_evidence and crop_evidence.is_file()
                    pixels = observed_crop
                    assert 0 <= pixels[0] < pixels[2] <= size[0] and 0 <= pixels[1] < pixels[3] <= size[1]
                if (pixels[2]-pixels[0])*(pixels[3]-pixels[1]) > MAX_NATIVE_MASK_PIXELS:
                    raise ValueError('Full observed region exceeds supported native mask size; never shrink the subject or downsample to pass validation')
                crop_path = WORK / 'native-inputs' / f'{asset["id"]}-{annotation_id}-{name}.png'
                crop_path.parent.mkdir(parents=True, exist_ok=True)
                crop = rgb.crop(pixels)
                if crop_path.exists():
                    with Image.open(crop_path) as existing:
                        if not np.array_equal(np.asarray(existing), np.asarray(crop)):
                            raise RuntimeError('Immutable input crop changed')
                else:
                    crop.save(crop_path)
            frame_meta.update(working_path=str(frame_path), working_sha256=sha(frame_path),
                              crop_pixels=pixels, crop_size=list(crop.size),
                              crop_path=str(crop_path), crop_sha256=sha(crop_path))
            if observed_crop is not None:
                frame_meta['observed_crop_evidence'] = {'path': str(crop_evidence.resolve()), 'sha256': sha(crop_evidence),
                                                       'purpose': 'Full present subject observed in this source; tighter localization crop only, no resampling or projected final outline'}
            provenance = OUT / 'stones' / stone_id / 'pixel-frames' / f'{asset["id"]}-{annotation_id}-{name}.json'
            if provenance.exists() and json.loads(provenance.read_text(encoding='utf-8')) != frame_meta:
                raise RuntimeError('Immutable pixel-frame record changed')
            write(provenance, frame_meta)
            jobs.append({'stone_id': stone_id, 'canonical_annotation_id': canonical_id,
                         'canonical_asset_id': canonical['asset_id'], 'label': canonical['label'], 'target_asset_id': asset['id'],
                         'localization_annotation_id': annotation_id,
                         'source_sha256': asset['sha256'], 'source_filename': asset['filename'],
                         'version_label': '来源批次未注明 · ' + asset['filename'],
                         'work_image_sha256': frame_meta['working_sha256'],
                         'crop_path': str(crop_path), 'crop_sha256': frame_meta['crop_sha256'],
                         'crop_extent': [pixels[0]/size[0], pixels[1]/size[1], pixels[2]/size[0], pixels[3]/size[1]],
                         'expected_outline': points.tolist(), 'expected_prompt': prompt,
                         'localization_method': 'Existing own-source geometry for crop localization only; frame0 at original resolution',
                         'pixel_frame_record': str(provenance.relative_to(ROOT)),
                         'proposal_tag': name, 'variants': ['native', 'rubbing']})
    path = WORK / f'native-jobs-{stone_id}-{name}.json'
    if path.exists() and json.loads(path.read_text(encoding='utf-8')) != jobs:
        raise RuntimeError('Immutable job specification changed')
    write(path, jobs)
    return path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stone_id')
    parser.add_argument('--ids', type=int, nargs='+', required=True)
    parser.add_argument('--canonical-ids', type=int, nargs='+', help='Visually verified same-object original aliases, in matching order')
    parser.add_argument('--prompts', nargs='+', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--crop-pixels', type=int, nargs=4, help='One independently observed full-subject native ROI; never a final mask')
    parser.add_argument('--crop-evidence', type=Path, help='Actually viewed same-source localization evidence for explicit ROI')
    options = parser.parse_args()
    if len(options.ids) != len(options.prompts):
        parser.error('Provide one real subject prompt for each ID')
    if options.canonical_ids and len(options.ids) != len(options.canonical_ids):
        parser.error('Provide one verified canonical identity for each ID')
    if options.crop_pixels and (len(options.ids) != 1 or not options.crop_evidence):
        parser.error('Explicit observed ROI requires exactly one subject and same-source evidence')
    print(prepare(options.stone_id, options.ids, options.tag, options.prompts, options.canonical_ids, options.crop_pixels, options.crop_evidence))
