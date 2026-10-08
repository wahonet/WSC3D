"""Native research masks must survive export without losing topology or individual pixels."""
import hashlib
import importlib.util
from pathlib import Path
import unittest
import sys
from unittest import mock

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from app.native_masks import MAX_NATIVE_MASK_PIXELS, validate_native_mask

spec = importlib.util.spec_from_file_location('native_mask_worker', Path(__file__).resolve().parents[1] / 'src/backend/app/sam_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class NativeMaskTests(unittest.TestCase):
    def test_closeup_subject_spanning_frame_is_not_background(self):
        image = np.zeros((100, 80), np.uint8)
        image[:, 30:50] = 1
        image[40:60, :] = 1
        self.assertFalse(worker.is_blocky(image, [0, 0, 79, 99], 80, 100, False))

    def test_full_frame_background_is_still_filtered(self):
        self.assertTrue(worker.is_blocky(np.ones((100, 80)), [0, 0, 79, 99], 80, 100, False))

    def check_mask(self, image):
        encoded = worker.encode_native_mask(image)
        self.assertEqual(encoded['format'], 'wsc-binary-mask-rle-1')
        self.assertEqual(encoded['size'], list(image.shape))
        self.assertEqual(sum(encoded['counts']), image.size)
        restored = np.concatenate([np.full(count, i % 2, np.uint8) for i, count in enumerate(encoded['counts'])]).reshape(image.shape)
        binary = (image > .5).astype(np.uint8)
        np.testing.assert_array_equal(restored, binary)
        self.assertEqual(encoded['foreground_pixels'], int(binary.sum()))
        self.assertEqual(encoded['binary_sha256'], hashlib.sha256(binary.tobytes()).hexdigest())

    def test_holes_and_disconnected_thin_fragments(self):
        image = np.zeros((50, 70), np.uint8)
        image[5:30, 5:30] = 1
        image[10:20, 10:20] = 0
        image[2:40, 50] = 1
        image[45, 65] = 1
        self.check_mask(image)

    def test_empty_full_single_and_alternating(self):
        for image in [np.zeros((1, 1)), np.ones((1, 1)), np.zeros((12, 9)), np.ones((12, 9)),
                      np.array([[0, 1, 0, 1, 0], [1, 0, 1, 0, 1]])]:
            with self.subTest(shape=image.shape):
                self.check_mask(image)

    def test_threshold_and_dimensions(self):
        self.check_mask(np.array([[.49, .5, .51, 1.0]]))
        for invalid in [np.zeros(3), np.zeros((0, 2)), np.zeros((1, 2, 3))]:
            with self.assertRaises(ValueError):
                worker.encode_native_mask(invalid)

    def test_stored_mask_integrity_is_checked_before_write(self):
        image = np.zeros((17, 20), np.uint8); image[1:12, 3:9] = 1
        mask = {**worker.encode_native_mask(image), 'extent': [.1, .2, .3, .5]}
        validate_native_mask(mask)
        for change in [{'counts': [340]}, {'counts': [0, 339]}, {'size': [17, True]},
                       {'foreground_pixels': 1}, {'binary_sha256': '0'*64}, {'extent': [0, 0, 2, 1]}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_native_mask({**mask, **change})

    def test_full_native_photo_region_above_old_preview_limit(self):
        size = [7450, 2450]  # The observed 807 three-letter layout.
        total = size[0] * size[1]
        digest = hashlib.sha256()
        digest.update(b'\x00')
        block = b'\x01' * 65536
        left = total - 2
        while left:
            count = min(left, len(block)); digest.update(block[:count]); left -= count
        digest.update(b'\x00')
        mask = {'format': 'wsc-binary-mask-rle-1', 'size': size,
                'counts': [1, total - 2, 1], 'extent': [0, 0, 1, 1],
                'foreground_pixels': total - 2, 'binary_sha256': digest.hexdigest()}
        validate_native_mask(mask)
        with self.assertRaisesRegex(ValueError, '尺寸'):
            validate_native_mask({**mask, 'size': [1, MAX_NATIVE_MASK_PIXELS + 1]})
        with self.assertRaisesRegex(ValueError, '指纹'):
            validate_native_mask({**mask, 'binary_sha256': '0' * 64})


class TextSegmentNativeFrameTests(unittest.TestCase):
    def infer(self, preserve, wrong_shape=False):
        source = np.zeros((2544, 915, 3), np.uint8)
        seen = []

        def model(proc, rgb, prompt, boxes, threshold):
            seen.append(rgb.shape[:2])
            shape = (1600, 575) if wrong_shape else rgb.shape[:2]
            mask = np.zeros(shape, np.uint8)
            mask[20:80, 20:70] = 1
            return [(mask, .9, [20, 20, 70, 80])]

        with mock.patch.dict(worker._procs, {'sam3': object()}), \
             mock.patch.object(worker, 'read_image_rgb', return_value=source), \
             mock.patch.object(worker, 'preprocess_image', side_effect=lambda rgb, *args: rgb), \
             mock.patch.object(worker, '_sam3_infer', side_effect=model), \
             mock.patch.object(worker, 'is_blocky', return_value=False), \
             mock.patch.object(worker, 'mask_to_polygons', return_value=[[[.1, .1], [.2, .1], [.2, .2]]]):
            result = worker.text_segment('sam3', 'unused.png', 'dragon', .2, 12, preserve_mask=preserve)
        return seen, result

    def test_research_mask_keeps_inspected_915_by_2544_frame(self):
        seen, result = self.infer(True)
        self.assertEqual(seen, [(2544, 915)])
        self.assertEqual(result['size'], [915, 2544])
        self.assertEqual(result['detections'][0]['native_mask']['size'], [2544, 915])

    def test_normal_preview_request_keeps_existing_reduction(self):
        seen, result = self.infer(False)
        self.assertEqual(seen, [(1600, 575)])
        self.assertNotIn('native_mask', result['detections'][0])

    def test_smaller_model_bitmap_is_rejected_without_upscaling(self):
        with self.assertRaisesRegex(ValueError, 'resizing is forbidden'):
            self.infer(True, wrong_shape=True)


if __name__ == '__main__':
    unittest.main()
