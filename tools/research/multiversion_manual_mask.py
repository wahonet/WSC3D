"""Apply recorded, native-pixel boundary corrections to a SAM proposal for visual review.

No source image pixels are changed. Corrections have their own immutable artifact;
they never change or implicitly approve the original SAM result.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from multiversion_sam import OUT, decode, evaluate_detection, write
from app.sam_worker import encode_native_mask


def correct(spec_path):
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    parent = json.loads((OUT/spec['proposal']).read_text(encoding='utf-8'))
    job = parent['job']
    crop_path = Path(job['crop_path'])
    assert hashlib.file_digest(crop_path.open('rb'), 'sha256').hexdigest() == job['crop_sha256']
    with Image.open(crop_path) as source:
        width, height = source.size
    assert [width, height] == spec['image_size'], 'Points must be traced on this native source'
    detection = parent['result']['detections'][spec['detection_index']]
    binary = decode(detection['native_mask'])
    assert binary.shape == (height, width), 'Native mask and observed source must share a pixel frame'
    original_sha = hashlib.sha256(binary.tobytes()).hexdigest()
    assert original_sha == detection['native_mask']['binary_sha256']
    for correction in spec['corrections']:
        if correction['operation'] not in ('include', 'exclude'):
            raise ValueError('Invalid correction operation')
        if 'components_xywh_area' in correction:
            expected = [tuple(values) for values in correction['components_xywh_area']]
            assert expected and len(set(expected)) == len(expected)
            for x, y, w, h, area in expected:
                assert 0 <= x < x+w <= width and 0 <= y < y+h <= height and 0 < area <= w*h
                if correction['operation'] == 'include':
                    assert x > 0 and y > 0 and x+w < width and y+h < height, 'Only recorded closed holes may be filled'
            component_input = 1-binary if correction['operation'] == 'include' else binary
            _, labels, stats, _ = cv2.connectedComponentsWithStats(component_input, 8)
            matches = [(index, tuple(map(int, values))) for index, values in enumerate(stats[1:], 1)
                       if tuple(map(int, values)) in expected]
            assert sorted(values for _, values in matches) == sorted(expected), 'Recorded component pixels changed'
            before = binary.copy()
            for index, _ in matches:
                binary[labels == index] = int(correction['operation'] == 'include')
            assert int(np.count_nonzero(before != binary)) == sum(values[4] for values in expected)
            continue
        points = np.asarray(correction['points_px'], dtype=float)
        if points.ndim != 2 or points.shape[1] != 2 or len(points) < 3 or not np.isfinite(points).all():
            raise ValueError('Invalid native correction polygon')
        if np.any(points < 0) or np.any(points > [width-1, height-1]):
            raise ValueError('Correction leaves the inspected source frame')
        cv2.fillPoly(binary, [np.rint(points).astype(np.int32)], int(correction['operation'] == 'include'))
    mask = encode_native_mask(binary)
    mask['extent'] = detection['native_mask']['extent']
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)[:, 0]
    if len(contour) < 3:
        raise ValueError('Corrected mask has no usable selection outline')
    x0, y0, x1, y1 = mask['extent']
    polygon = [[x0+int(x)/width*(x1-x0), y0+int(y)/height*(y1-y0)] for x, y in contour]
    result = {'native_mask': mask, 'polygon': polygon, 'score': detection['score']}
    evaluate_detection(job, result)
    request = {'cmd': 'native_mask_boundary_correction', 'parent_proposal': spec['proposal'],
               'parent_detection_index': spec['detection_index'], 'parent_mask_sha256': original_sha,
               'parent_request': parent['request'], 'corrections': spec['corrections'],
               'point_frame': 'unaltered-native-source-crop-pixels', 'source_spec': str(spec_path)}
    output = OUT/'native-proposals'/spec['output_filename']
    value = {'job': job, 'request': request, 'result': {'ok': True, 'detections': [result]},
             'weight_sha256': parent['weight_sha256'], 'visual_reviewed': False}
    if output.exists():
        assert json.loads(output.read_text(encoding='utf-8')) == value, 'Correction artifact is immutable'
    else:
        write(output, value)
    print(output, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('spec', type=Path)
    correct(parser.parse_args().spec)
