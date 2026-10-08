"""Propose an independently reviewed native layer mask for an identical story scope.

The original annotation and historic proposal remain unchanged. This only writes
an immutable candidate with a new canonical identity and a raw source crop.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
from pathlib import Path

import numpy as np
from PIL import Image
from app.services.resources import asset_path
from multiversion_context import ROOT, OUT, WORK
from multiversion_sam import decode, write
from multiversion_pixel_frames import validate_pixel_frame


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    historic_path = ROOT / 'resources/authoring/research/multiversion-20261002/native-proposals/武008-811-2980-manual-scene-remainingwesternpeoplerubownv2.json'
    historic = json.loads(historic_path.read_text(encoding='utf-8'))
    oldjob = historic['job']
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = {i: dict(db.execute('SELECT * FROM annotations WHERE id=?', (i,)).fetchone()) for i in (2980, 2981, 5962)}
        asset = dict(db.execute('SELECT * FROM assets WHERE id=811').fetchone())
    assert rows[2980]['level'] == 'layer' and rows[2981]['level'] == 'scene'
    assert rows[2981]['parent_id'] == 2980
    assert rows[2980]['stone_id'] == rows[2981]['stone_id'] == '武008'
    assert rows[2980]['asset_id'] == rows[2981]['asset_id'] == asset['id']
    assert json.loads(rows[2980]['geometry']) == json.loads(rows[2981]['geometry']), 'Story and layer scope differ'
    oldgeometry = json.loads(rows[5962]['geometry'])
    assert oldgeometry['image_version']['canonical_annotation_id'] == 2980
    assert oldgeometry['native_mask'] == historic['result']['detections'][0]['native_mask']
    source_path = asset_path(asset['relpath'])
    assert sha(source_path) == asset['sha256'] == oldjob['source_sha256']
    frame_path = WORK / 'native-frames/811-frame0.png'
    with Image.open(source_path) as original, Image.open(frame_path) as frame:
        original.seek(0)
        raw = original.convert('RGB')
        assert frame.size == raw.size == (2781, 4167)
        assert np.array_equal(np.asarray(frame), np.asarray(raw))
        size = raw.size
        pixels = [round(v * size[i % 2]) for i, v in enumerate(oldjob['crop_extent'])]
        assert [pixels[0]/size[0], pixels[1]/size[1], pixels[2]/size[0], pixels[3]/size[1]] == oldjob['crop_extent']
        crop = raw.crop(pixels)
        binary = decode(historic['result']['detections'][0]['native_mask'])
        assert binary.shape == (crop.height, crop.width) == (2135, 935)
        assert hashlib.sha256(binary.tobytes()).hexdigest() == oldgeometry['native_mask']['binary_sha256']
        crop_path = WORK / 'native-inputs/811-2981-adopt-reviewed-layer-v1.png'
        crop_path.parent.mkdir(parents=True, exist_ok=True)
        if crop_path.exists():
            with Image.open(crop_path) as existing:
                assert np.array_equal(np.asarray(existing), np.asarray(crop))
        else:
            crop.save(crop_path)
        frame_record = {
            'source_file': str(source_path), 'source_sha256': asset['sha256'], 'frame_index': 0,
            'frame_count': getattr(original, 'n_frames', 1), 'original_mode': original.mode,
            'original_size': list(size), 'working_size': list(size),
            'working_conversion': 'Pillow RGB decode; no resize, enhancement or EXIF transform',
            'icc_profile_sha256': hashlib.sha256(original.info['icc_profile']).hexdigest() if original.info.get('icc_profile') else None,
            'working_path': str(frame_path), 'working_sha256': sha(frame_path),
            'crop_pixels': pixels, 'crop_size': list(crop.size), 'crop_path': str(crop_path), 'crop_sha256': sha(crop_path),
        }
    provenance = OUT / 'stones/武008/pixel-frames/811-2981-adopt-reviewed-layer-v1.json'
    if provenance.exists():
        assert json.loads(provenance.read_text(encoding='utf-8')) == frame_record
    else:
        write(provenance, frame_record)
    job = copy.deepcopy(oldjob)
    job.update(canonical_annotation_id=2981, label=rows[2981]['label'],
               work_image_sha256=frame_record['working_sha256'], crop_path=str(crop_path),
               crop_sha256=frame_record['crop_sha256'], pixel_frame_record=str(provenance.relative_to(ROOT)),
               localization_method='identical original story/layer scope; independently reviewed historic mask in the same original pixel frame',
               proposal_tag='adopt-reviewed-layer-v1', variants=[])
    validate_pixel_frame(job)
    request = {
        'cmd': 'adopt_independently_reviewed_native_layer_for_identical_story_scope',
        'historic_proposal': str(historic_path.relative_to(ROOT)), 'historic_proposal_sha256': sha(historic_path),
        'historic_version_annotation_id': 5962, 'historic_canonical_annotation_id': 2980,
        'pixel_transform': 'identity; original 2781x4167 frame, crop 935x2135, binary unchanged',
        'scope_reason': 'Original scene2981 and layer2980 have identical geometry; independently reviewed two-person composition and all 6170 boundary pixels; scene carries its own semantics and references.',
        'independent_review': 'stones/武008/existing-mask-review/independent-visual-review.json',
    }
    value = {'job': job, 'request': request, 'result': copy.deepcopy(historic['result']), 'weight_sha256': None, 'visual_reviewed': False}
    proposal = OUT / 'native-proposals/武008-811-2981-adopt-reviewed-layer-v1.json'
    if proposal.exists():
        assert json.loads(proposal.read_text(encoding='utf-8')) == value
    else:
        write(proposal, value)
    review = OUT / 'stones/武008/adopted-story-review'
    review.mkdir(parents=True, exist_ok=True)
    rgba = crop.convert('RGBA')
    rgba.putalpha(Image.fromarray(binary * 255))
    rgba.save(review / '811-2981-native-rgba.png')
    # Each tile retains native pixel dimensions; the grey panel is only a view.
    evidence = []
    for index, y0 in enumerate(range(0, crop.height, 540), 1):
        y1 = min(crop.height, y0 + 540)
        panel = Image.new('RGB', (crop.width * 2, y1-y0), '#d6d6d6')
        panel.paste(crop.crop((0, y0, crop.width, y1)), (0, 0))
        tile = rgba.crop((0, y0, crop.width, y1))
        panel.paste(tile, (crop.width, 0), tile)
        path = review / f'811-2981-native-page-{index}.png'
        panel.save(path)
        evidence.append({'path': str(path.relative_to(OUT)), 'sha256': sha(path), 'crop_region': [0,y0,crop.width,y1], 'native_scale': 1})
    write(review / 'evidence-index.json', {'proposal': str(proposal.relative_to(OUT)), 'raw_pixel_frame_verified': True, 'binary_reused_unchanged': True, 'pages': evidence})
    print(proposal)


if __name__ == '__main__':
    main()
