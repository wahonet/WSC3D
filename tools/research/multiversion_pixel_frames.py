"""Validate recorded original RGB frames and crop pixels without resampling."""
from __future__ import annotations

import hashlib
import io
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image
from multiversion_context import ROOT, WORK

# Catalogued research scans can exceed Pillow's default pixel warning limit.
# Source and working files are fingerprinted before decoding, and their exact
# recorded dimensions and crop bounds are checked below.
Image.MAX_IMAGE_PIXELS = None


def stamp(path):
    info = Path(path).stat()
    return info.st_size, info.st_mtime_ns, info.st_ctime_ns


@lru_cache(maxsize=64)
def file_sha(path, fingerprint):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sha(path):
    return file_sha(str(Path(path).resolve()), stamp(path))


@lru_cache(maxsize=1)
def verified_frame(source, working, frame_index, source_stamp, working_stamp):
    """Verify an unchanged source once; subsequent objects reuse its RGB frame."""
    with Image.open(source) as original:
        original.seek(frame_index)
        count, mode, size = getattr(original, 'n_frames', 1), original.mode, original.size
        rgb = original.convert('RGB')
    if source != working:
        with Image.open(working) as frame:
            if frame.size != size:
                raise ValueError('A native working frame must retain original dimensions')
            saved = frame.convert('RGB')
        if not np.array_equal(np.asarray(saved), np.asarray(rgb)):
            raise ValueError('Full native RGB frame differs from original source pixels')
        rgb = saved
    return rgb, count, mode, size, hashlib.sha256(rgb.tobytes()).hexdigest()


def restore_native_crop(job):
    """Rebuild an evicted input cache from its immutable native pixel proof."""
    crop = Path(job['crop_path']).resolve()
    if crop.is_file():
        return
    if not crop.is_relative_to((WORK / 'native-inputs').resolve()):
        raise ValueError('Only native input caches may be reconstructed')
    path = Path(job['pixel_frame_record'])
    record = json.loads((path if path.is_absolute() else ROOT / path).read_text(encoding='utf-8'))
    source, working = Path(record['source_file']), Path(record['working_path'])
    if (Path(record['crop_path']).resolve() != crop or record['crop_sha256'] != job['crop_sha256'] or
        sha(source) != job['source_sha256'] or sha(working) != job['work_image_sha256']):
        raise ValueError('Crop reconstruction source or identity changed')
    frame, count, _, size, _ = verified_frame(str(source.resolve()), str(working.resolve()),
        record['frame_index'], stamp(source), stamp(working))
    pixels = record['crop_pixels']
    if (count != record['frame_count'] or list(size) != record['original_size'] or
        len(pixels) != 4 or any(type(n) is not int for n in pixels) or
        not (0 <= pixels[0] < pixels[2] <= size[0] and 0 <= pixels[1] < pixels[3] <= size[1])):
        raise ValueError('Crop reconstruction frame changed')
    encoded = io.BytesIO()
    frame.crop(pixels).save(encoded, format='PNG')
    data = encoded.getvalue()
    if hashlib.sha256(data).hexdigest() != job['crop_sha256']:
        raise ValueError('Reconstructed cache differs from the accepted native crop')
    crop.parent.mkdir(parents=True, exist_ok=True)
    crop.write_bytes(data)


def validate_pixel_frame(job, enrich=False):
    """Return a verified frame record for new original-resolution crop jobs."""
    restore_native_crop(job)
    record_path = Path(job['pixel_frame_record'])
    if not record_path.is_absolute():
        record_path = ROOT / record_path
    record = json.loads(record_path.read_text(encoding='utf-8'))
    source = Path(record['source_file'])
    working = Path(record['working_path'])
    crop = Path(job['crop_path'])
    if record['source_sha256'] != job['source_sha256'] or sha(source) != job['source_sha256']:
        raise ValueError('Recorded original source fingerprint changed')
    if record['working_sha256'] != job['work_image_sha256'] or sha(working) != job['work_image_sha256']:
        raise ValueError('Recorded original RGB working-frame fingerprint changed')
    if Path(record['crop_path']).resolve() != crop.resolve() or record['crop_sha256'] != job['crop_sha256'] or sha(crop) != job['crop_sha256']:
        raise ValueError('Recorded native crop identity changed')
    pixels = record['crop_pixels']
    if len(pixels) != 4 or any(type(value) is not int for value in pixels):
        raise ValueError('Native crop pixels must be integer coordinates')
    x0, y0, x1, y1 = pixels
    frame, frame_count, original_mode, original_size, working_rgb_sha256 = verified_frame(
        str(source.resolve()), str(working.resolve()), record['frame_index'], stamp(source), stamp(working))
    with Image.open(crop) as cropped:
        if frame_count != record['frame_count']:
            raise ValueError('Recorded original frame count changed')
        if list(original_size) != record['original_size'] or list(frame.size) != record['working_size']:
            raise ValueError('A native working frame must retain original frame dimensions')
        width, height = frame.size
        if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
            raise ValueError('Native crop is outside its source frame')
        if list(cropped.size) != record['crop_size'] or cropped.size != (x1-x0, y1-y0):
            raise ValueError('Recorded native crop dimensions changed')
        expected_extent = [x0/width, y0/height, x1/width, y1/height]
        if not np.allclose(job['crop_extent'], expected_extent, rtol=0, atol=1e-12):
            raise ValueError('Crop extent differs from its original pixel frame')
        actual = np.asarray(cropped.convert('RGB'))
        if not np.array_equal(actual, np.asarray(frame.crop(pixels).convert('RGB'))):
            raise ValueError('Native crop RGB differs from its recorded working frame')
        # The complete working frame has already been proven equal to the source.
        if record.get('working_rgb_sha256', working_rgb_sha256) != working_rgb_sha256:
            raise ValueError('Recorded full native RGB fingerprint changed')
        if enrich:
            # Publication adds verified proof fields without rewriting the saved
            # legacy record or changing the validator's original return contract.
            record = {**record, 'working_rgb_sha256': working_rgb_sha256,
                'working_conversion': record.get('working_conversion',
                    'Decoded original to RGB; full-frame RGB and native crop equality verified; no resizing')}
    return record
