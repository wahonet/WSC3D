"""Record a human native-boundary review after independently checking its artifacts.

The spec lists images actually opened by the reviewer. This does not perform or
infer a visual acceptance, and never writes to the platform database.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from app.native_masks import validate_native_mask
from multiversion_context import OUT
from multiversion_pixel_frames import validate_pixel_frame
from multiversion_sam import decode, write


def fingerprint(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def resolve(value):
    path = Path(value)
    return path if path.is_absolute() else OUT / path


def main(spec_path):
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    accepted = []
    for item in spec['reviews']:
        assert item['actual_visual_acceptance'] is True
        proposal_path = resolve(item['proposal'])
        proposal = json.loads(proposal_path.read_text(encoding='utf-8'))
        job = proposal['job']
        frame = validate_pixel_frame(job)
        native = proposal['result']['detections'][item.get('detection_index', 0)]['native_mask']
        validate_native_mask(native)
        binary = decode(native)
        assert list(binary.shape[::-1]) == frame['crop_size']
        assert native['extent'] == job['crop_extent']
        with Image.open(job['crop_path']) as crop, Image.open(resolve(item['rgba'])) as rgba, Image.open(resolve(item['binary'])) as stored:
            assert rgba.mode == 'RGBA'
            assert np.array_equal(np.asarray(rgba)[:, :, :3], np.asarray(crop.convert('RGB')))
            assert np.array_equal(np.asarray(rgba)[:, :, 3], binary * 255)
            assert np.array_equal(np.asarray(stored.convert('L')) > 0, binary > 0)
        eroded = cv2.erode(binary, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0)
        edge = binary > eroded
        covered = np.zeros(binary.shape, dtype=bool)
        for region in item['boundary_tile_regions']:
            x0, y0, x1, y1 = region
            assert 0 <= x0 < x1 <= binary.shape[1] and 0 <= y0 < y1 <= binary.shape[0]
            covered[y0:y1, x0:x1] = True
        assert not np.any(edge & ~covered), 'Native perimeter evidence must include crop-touching borders'
        assert item['all_boundary_pages_actually_viewed'] is True
        evidence = [{'path': str(resolve(p).relative_to(OUT)), 'sha256': fingerprint(resolve(p))}
                    for p in item['actually_viewed_images']]
        assert evidence and resolve(item['author_review']).is_file()
        reviewer = item.get('reviewer', spec.get('reviewer', 'root, independent of candidate author'))
        assert isinstance(reviewer, str) and reviewer.strip(), 'Actual independent reviewer must be identified'
        review = {
            'reviewer': reviewer,
            'stone_id': job['stone_id'], 'source_asset_id': job['target_asset_id'],
            'canonical_annotation_id': job['canonical_annotation_id'],
            'proposal': str(proposal_path.relative_to(OUT)), 'proposal_sha256': fingerprint(proposal_path),
            'mask_binary_sha256': native['binary_sha256'], 'source_sha256': frame['source_sha256'],
            'crop_pixels': frame['crop_pixels'], 'mask_size': frame['crop_size'],
            'source_RGB_RGBA_alpha_binary_and_native_frame_exact': True,
            'boundary_pixels_covered': int(edge.sum()),
            'all_boundary_pages_actually_viewed': True, 'actually_viewed_images': evidence,
            'scope': item['scope'], 'visual_observations': item['visual_observations'],
            'boundary_acceptance': 'passed', 'research_fields_inherited': True,
            'does_not_certify_child_boundaries': item.get('does_not_certify_child_boundaries', True),
        }
        destination = resolve(item['review_output'])
        assert not destination.exists(), 'Signed review records are immutable; use a new evidence record'
        write(destination, review)
        decision = {'proposal': review['proposal'], 'target_asset_id': job['target_asset_id'],
                    'canonical_annotation_id': job['canonical_annotation_id'],
                    'detection_index': item.get('detection_index', 0),
                    'evidence': [str(destination.relative_to(OUT)), str(resolve(item['author_review']).relative_to(OUT))]
                                + [e['path'] for e in evidence],
                    'visual_note': item['scope']}
        if item.get('display_label'):
            decision['display_label'] = item['display_label']
        accepted.append(decision)
        print(json.dumps({'review': str(destination), 'boundary_pixels': int(edge.sum())}, ensure_ascii=False))
    if spec.get('decisions_output'):
        destination = resolve(spec['decisions_output'])
        assert not destination.exists()
        write(destination, {'accepted': accepted})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path)
    main(parser.parse_args().spec)
