"""Check the lossless source mask before accepting research geometry."""
from __future__ import annotations
import hashlib
import math

# Full present native photo regions can exceed the former 16 Mi-pixel preview
# limit. Bound work without forcing research masks to shrink or resample.
MAX_NATIVE_MASK_PIXELS = 67_108_864


def validate_native_mask(mask) -> None:
    integer = lambda n: type(n) is int
    if not isinstance(mask, dict) or mask.get('format') != 'wsc-binary-mask-rle-1':
        raise ValueError('分割掩膜格式无效')
    size, counts, extent = mask.get('size'), mask.get('counts'), mask.get('extent')
    if not isinstance(size, list) or len(size) != 2 or not all(integer(v) and v > 0 for v in size) or math.prod(size) > MAX_NATIVE_MASK_PIXELS:
        raise ValueError('分割掩膜尺寸无效')
    total = math.prod(size)
    if not isinstance(counts, list) or not counts or len(counts) > total+1 or not all(integer(v) and v >= 0 for v in counts) or sum(counts) != total:
        raise ValueError('分割掩膜游程与尺寸不一致')
    foreground = sum(v for i, v in enumerate(counts) if i % 2)
    if not foreground or type(mask.get('foreground_pixels')) is not int or foreground != mask['foreground_pixels']:
        raise ValueError('分割掩膜前景像素数不一致')
    if not isinstance(extent, list) or len(extent) != 4 or not all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1 for v in extent) or extent[2] <= extent[0] or extent[3] <= extent[1]:
        raise ValueError('分割掩膜来源区域无效')
    digest = hashlib.sha256()
    for i, run in enumerate(counts):
        block = bytes([i % 2]) * min(run, 65536)
        while run:
            amount = min(run, 65536)
            digest.update(block[:amount])
            run -= amount
    if mask.get('binary_sha256') != digest.hexdigest():
        raise ValueError('分割掩膜像素指纹不一致')
