"""Prepare verified, untransformed full source frames for a finite stone census.

This is read-only for source files and database. Preparing a frame is not a
visual review, a confirmed object identity, or a segmentation acceptance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

from PIL import Image
from app.services.resources import asset_path
from multiversion_context import ROOT, OUT, WORK
from multiversion_sam import write

Image.MAX_IMAGE_PIXELS = None


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main(stone_id):
    assert stone_id in [f'武{i:03d}' for i in range(8, 54)]
    destination = OUT / 'stones' / stone_id / 'native-source-frames.json'
    assert not destination.exists(), 'Prepared frame index is immutable'
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        assets = [dict(row) for row in db.execute('SELECT * FROM assets WHERE stone_id=? ORDER BY id', (stone_id,))
                  if not row['kind'].startswith('model')]
    rows = []
    source_frames = {}
    for asset in assets:
        source = asset_path(asset['relpath'])
        assert sha(source) == asset['sha256'], 'Original source fingerprint changed'
        if asset['sha256'] in source_frames:
            primary = source_frames[asset['sha256']]
            assert primary['original_size'] == [asset['width'], asset['height']]
            rows.append({**primary, 'source_asset_id': asset['id'], 'source_file': str(source),
                         'source_filename': asset['filename'], 'duplicate_of_asset_id': primary['source_asset_id'],
                         'same_capture_merge': 'same_SHA_file_alias'})
            print(f'{asset["id"]}: same-SHA alias; reuse source frame {primary["source_asset_id"]}', flush=True)
            continue
        frame_path = WORK / 'native-frames' / f'{asset["id"]}-frame0.png'
        frame_path.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as original:
            original.seek(0)
            assert original.size == (asset['width'], asset['height'])
            rgb = original.convert('RGB')
            raw_sha = hashlib.sha256(rgb.tobytes()).hexdigest()
            if frame_path.exists():
                with Image.open(frame_path) as previous:
                    assert previous.size == rgb.size and previous.mode == 'RGB'
                    assert hashlib.sha256(previous.tobytes()).hexdigest() == raw_sha
            else:
                rgb.save(frame_path, format='PNG')
            row = {'source_asset_id': asset['id'], 'source_file': str(source), 'source_filename': asset['filename'],
                   'source_sha256': asset['sha256'], 'frame_index': 0, 'frame_count': getattr(original, 'n_frames', 1),
                   'original_mode': original.mode, 'original_size': list(original.size), 'working_size': list(rgb.size),
                   'working_path': str(frame_path), 'working_sha256': sha(frame_path), 'working_rgb_sha256': raw_sha,
                   'working_conversion': 'Pillow RGB decode; no resize, enhancement, ICC or EXIF transform',
                   'actual_visual_reviewed': False, 'segmentation_accepted': False,
                   'identity_acceptance': False, 'same_capture_merge': 'not_evaluated'}
        rows.append(row)
        source_frames[asset['sha256']] = row
        print(f'{asset["id"]}: {row["original_size"]}, source SHA and full RGB verified', flush=True)
    write(destination, {'format': 'wsc-native-source-frame-index-1', 'stone_id': stone_id,
                        'scope': 'source preparation only; full census and object/source coverage pending', 'frames': rows})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stone_id')
    main(parser.parse_args().stone_id)
