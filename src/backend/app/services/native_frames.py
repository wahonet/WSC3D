"""Lossless, verified original RGB frames for precise research cutouts."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
from uuid import uuid4

from PIL import Image

from ..config import settings
from .previews import _lock_for
from .resources import asset_path

Image.MAX_IMAGE_PIXELS = None


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def rgb_sha(image):
    return hashlib.sha256(image.convert('RGB').tobytes()).hexdigest()


def ensure_native_frame(asset, source_sha256, frame_index=0, working_sha256=None, working_rgb_sha256=None):
    """Never expose a caller-supplied path, resize, transform ICC, or orient EXIF."""
    if not re.fullmatch(r'[a-f0-9]{64}', source_sha256 or '') or source_sha256 != asset.sha256:
        raise ValueError('Original source SHA does not match this asset')
    if type(frame_index) is not int or frame_index < 0:
        raise ValueError('Invalid original frame index')
    if working_sha256 is not None and not re.fullmatch(r'[a-f0-9]{64}', working_sha256):
        raise ValueError('Invalid recorded RGB frame SHA')
    if working_rgb_sha256 is not None and not re.fullmatch(r'[a-f0-9]{64}', working_rgb_sha256):
        raise ValueError('Invalid recorded decoded RGB SHA')
    source = asset_path(asset.relpath)
    if sha(source) != source_sha256:
        raise ValueError('Original source file changed; native frame refused')
    cache = settings.cache_dir / 'native-frames'
    dst = cache / f'{asset.id}-{source_sha256}-frame{frame_index}.png'
    with _lock_for(f'native-frame:{asset.id}:{source_sha256}:{frame_index}'):
        original_size = None
        if working_rgb_sha256 is not None:
            with Image.open(source) as original:
                if frame_index >= getattr(original, 'n_frames', 1):
                    raise ValueError('Original frame index is outside this file')
                original.seek(frame_index)
                original_size = original.size
                if rgb_sha(original) != working_rgb_sha256:
                    raise ValueError('Original decoded RGB differs from the recorded research frame')
        if not dst.exists():
            cache.mkdir(parents=True, exist_ok=True)
            temporary = dst.with_name(dst.stem + '-' + uuid4().hex + '.tmp.png')
            try:
                with Image.open(source) as original:
                    if frame_index >= getattr(original, 'n_frames', 1):
                        raise ValueError('Original frame index is outside this file')
                    original.seek(frame_index)
                    original.convert('RGB').save(temporary, format='PNG')
                if working_rgb_sha256 is not None:
                    with Image.open(temporary) as saved:
                        if saved.mode != 'RGB' or saved.size != original_size or rgb_sha(saved) != working_rgb_sha256:
                            raise ValueError('Saved native RGB frame differs from its recorded pixel SHA')
                elif working_sha256 is not None and sha(temporary) != working_sha256:
                    raise ValueError('Decoded original RGB differs from the recorded research frame')
                temporary.replace(dst)
            finally:
                temporary.unlink(missing_ok=True)
        elif working_rgb_sha256 is not None:
            with Image.open(dst) as saved:
                if saved.mode != 'RGB' or saved.size != original_size or rgb_sha(saved) != working_rgb_sha256:
                    raise ValueError('Cached native RGB frame differs from its recorded pixel SHA')
        elif working_sha256 is not None and sha(dst) != working_sha256:
            raise ValueError('Cached native RGB frame differs from its recorded SHA')
    return dst
