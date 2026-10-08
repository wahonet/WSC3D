"""A full-resolution refinement must use the recorded original RGB crop."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/research'))
from multiversion_pixel_frames import sha, validate_pixel_frame
import multiversion_pixel_frames as pixel_frames
from multiversion_sam import validate_native_result_frame
import multiversion_refine as refinement


class PixelFrameTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        source = root / 'source.png'
        work = root / 'working.png'
        crop = root / 'native-inputs/crop.png'
        crop.parent.mkdir()
        Image.fromarray(np.arange(25*18, dtype=np.uint8).reshape(25, 18)).save(source)
        with Image.open(source) as original:
            rgb = original.convert('RGB')
            rgb.save(work)
            rgb.crop((3, 4, 15, 20)).save(crop)
        record_path = root / 'frame.json'
        record = {'source_file': str(source), 'source_sha256': sha(source), 'frame_index': 0, 'frame_count': 1,
                  'original_size': [18, 25], 'working_path': str(work), 'working_sha256': sha(work),
                  'working_size': [18, 25], 'crop_pixels': [3, 4, 15, 20], 'crop_size': [12, 16],
                  'crop_path': str(crop), 'crop_sha256': sha(crop)}
        record_path.write_text(json.dumps(record), encoding='utf-8')
        job = {'stone_id': '武008', 'target_asset_id': 811, 'canonical_annotation_id': 2986,
               'source_sha256': record['source_sha256'], 'work_image_sha256': record['working_sha256'],
               'crop_path': str(crop), 'crop_sha256': record['crop_sha256'],
               'crop_extent': [3/18, 4/25, 15/18, 20/25], 'pixel_frame_record': str(record_path)}
        return root, record_path, record, job

    def test_evicted_native_cache_rebuilds_identical_pixels_and_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, record, job = self.fixture(directory)
            Path(job['crop_path']).unlink()
            with mock.patch.object(pixel_frames, 'WORK', root):
                self.assertEqual(validate_pixel_frame(job), record)
            self.assertEqual(sha(job['crop_path']), job['crop_sha256'])

    def test_changed_source_cannot_rebuild_or_write_an_evicted_crop(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, record, job = self.fixture(directory)
            Path(job['crop_path']).unlink()
            Path(record['source_file']).write_bytes(b'changed source')
            with mock.patch.object(pixel_frames, 'WORK', root), self.assertRaises(ValueError):
                validate_pixel_frame(job)
            self.assertFalse(Path(job['crop_path']).exists())

    def test_original_rgb_crop_passes_and_refinement_skips_preview_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, record, job = self.fixture(directory)
            self.assertEqual(validate_pixel_frame(job), record)
            proposal = root / 'native-proposals/proposal.json'
            proposal.parent.mkdir()
            proposal.write_text(json.dumps({'job': job}), encoding='utf-8')
            prompt = {'proposal': 'native-proposals/proposal.json', 'target_asset_id': 811,
                      'canonical_annotation_id': 2986, 'image_size': [12, 16], 'points_px': [[5, 6]],
                      'labels': [1], 'round': 'one', 'preprocess': ['none']}
            inventory = {'stones': [{'assets': [{'id': 811, 'sha256': job['source_sha256']}]}]}
            with mock.patch.object(refinement, 'OUT', root), mock.patch.object(refinement, 'WORK', root), \
                 mock.patch.object(refinement.previews, 'ensure_work_image', side_effect=AssertionError('Preview cache must not be used')):
                self.assertEqual(refinement.prepare_prompt(prompt, inventory), job)

    def test_reduced_or_altered_frame_cannot_pass_by_updating_hashes(self):
        for altered in ('reduced', 'changed-pixels'):
            with self.subTest(altered=altered), tempfile.TemporaryDirectory() as directory:
                _, record_path, record, job = self.fixture(directory)
                work = Path(record['working_path'])
                crop = Path(job['crop_path'])
                with Image.open(work) as original:
                    pixels = original.copy()
                if altered == 'reduced':
                    pixels = pixels.resize((9, 12))
                else:
                    pixels.putpixel((5, 6), (255, 0, 0))
                    pixels.crop(record['crop_pixels']).save(crop)
                    record['crop_sha256'] = job['crop_sha256'] = sha(crop)
                pixels.save(work)
                record['working_sha256'] = job['work_image_sha256'] = sha(work)
                record_path.write_text(json.dumps(record), encoding='utf-8')
                with self.assertRaises(ValueError):
                    validate_pixel_frame(job)

    def test_driver_rejects_bitmap_frame_even_when_result_size_claims_native(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, _, job = self.fixture(directory)
            result = {'size': [12, 16], 'detections': [{'native_mask': {'size': [8, 6], 'counts': [0, 48]}}]}
            with self.assertRaisesRegex(ValueError, 'no resizing permitted'):
                validate_native_result_frame(job, result)


if __name__ == '__main__':
    unittest.main()
