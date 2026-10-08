"""Render a projective comparison from the unchanged sRGB source preview, with transparent margins."""
from __future__ import annotations
import hashlib
import json

import numpy as np
from PIL import Image

from . import previews, transforms as tf


def ensure_projective_preview(left, right, matrix):
    transform = tf.homography(matrix)
    tf.validate_domain(transform, right.width, right.height)
    key = hashlib.sha256(json.dumps(['warp-srgb-1', left.id, left.sha256, left.width, left.height,
                                   right.id, right.sha256, right.width, right.height,
                                   transform['homography']], separators=(',', ':')).encode()).hexdigest()
    out = previews.preview_path(left.id).parent / f'warp_{key}.png'
    with previews._lock_for(str(out)):
        if out.is_file():
            return out
        import cv2
        with Image.open(previews.ensure_preview(left.id, left.relpath)) as reference:
            width, height = reference.size
        with Image.open(previews.ensure_preview(right.id, right.relpath)) as source:
            rgb = np.asarray(source.convert('RGB'))
        scale_left = np.diag([width/left.width, height/left.height, 1.])
        scale_right = np.diag([right.width/rgb.shape[1], right.height/rgb.shape[0], 1.])
        h = scale_left @ np.asarray(transform['homography']) @ scale_right
        warped = cv2.warpPerspective(rgb, h, (width, height), flags=cv2.INTER_LINEAR)
        alpha = cv2.warpPerspective(np.full(rgb.shape[:2], 255, np.uint8), h, (width, height), flags=cv2.INTER_LINEAR)
        # OpenCV interpolates transparent border RGB against zero; PNG stores straight alpha.
        foreground = alpha > 0
        corrected = warped.astype(np.float32)
        corrected[foreground] *= 255./alpha[foreground, None]
        rgba = np.dstack([np.clip(np.rint(corrected), 0, 255).astype(np.uint8), alpha])
        temp = out.with_suffix('.tmp.png')
        Image.fromarray(rgba).save(temp)
        temp.replace(out)
    return out
