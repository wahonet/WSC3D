"""Original RGB frames are lossless, source-bound, and compatible with recorded PNG hashes."""
from pathlib import Path
import hashlib
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from app.services import native_frames, serialize
from app.models import Asset


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class NativeFrameTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.source = self.folder / 'original.tif'
        first = Image.new('RGB', (23, 31), (17, 83, 127))
        first.putpixel((22, 30), (1, 2, 3))
        first.save(self.source, save_all=True, append_images=[Image.new('RGB', (23, 31), (190, 41, 6))])
        self.asset = Asset(id=811, kind='rubbing', filename='original.tif', relpath='trusted/original.tif',
                           sha256=digest(self.source), width=23, height=31, fmt='tif', bytes=self.source.stat().st_size, extra={})
        self.paths = patch.object(native_frames, 'asset_path', return_value=self.source)
        self.resolve = self.paths.start()
        self.config = patch.object(native_frames, 'settings', SimpleNamespace(cache_dir=self.folder / 'cache'))
        self.config.start()

    def tearDown(self):
        self.config.stop(); self.paths.stop(); self.temporary.cleanup()

    def recorded_png(self, index=0):
        path = self.folder / f'research-frame{index}.png'
        with Image.open(self.source) as original:
            original.seek(index); original.convert('RGB').save(path)
        return path

    def test_exact_rgb_and_recorded_byte_identity_without_resizing(self):
        recorded = self.recorded_png()
        result = native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_sha256=digest(recorded))
        self.assertEqual(result.read_bytes(), recorded.read_bytes())
        with Image.open(result) as frame:
            self.assertEqual(frame.size, (23, 31))
            self.assertEqual(frame.mode, 'RGB')
            self.assertEqual(frame.getpixel((22, 30)), (1, 2, 3))
        self.resolve.assert_called_once_with(self.asset.relpath)

    def test_frame_selection_and_bad_frame_rejection(self):
        recorded = self.recorded_png(1)
        result = native_frames.ensure_native_frame(self.asset, self.asset.sha256, 1, digest(recorded))
        self.assertEqual(result.read_bytes(), recorded.read_bytes())
        with Image.open(result) as frame:
            self.assertEqual(frame.getpixel((22, 30)), (190, 41, 6))
        for index in [-1, 2, True]:
            with self.assertRaises(ValueError):
                native_frames.ensure_native_frame(self.asset, self.asset.sha256, index)

    def test_changed_source_or_wrong_asset_sha_and_cache_sha_are_refused(self):
        recorded = self.recorded_png()
        expected = digest(recorded)
        with self.assertRaises(ValueError):
            native_frames.ensure_native_frame(self.asset, '0' * 64)
        result = native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_sha256=expected)
        result.write_bytes(b'changed cache')
        with self.assertRaisesRegex(ValueError, 'Cached native RGB'):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_sha256=expected)
        self.source.write_bytes(b'changed original')
        with self.assertRaisesRegex(ValueError, 'Original source file changed'):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_sha256=expected)

    def test_recorded_rgb_mismatch_does_not_publish_a_cache(self):
        with self.assertRaisesRegex(ValueError, 'recorded research frame'):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_sha256='0' * 64)
        self.assertEqual(list((self.folder / 'cache/native-frames').glob('*')), [])

    def test_different_png_encoding_requires_matching_full_original_rgb(self):
        recorded = self.folder / 'different-encoding.png'
        with Image.open(self.source) as original:
            original.seek(0)
            rgb = original.convert('RGB')
            raw_sha = native_frames.rgb_sha(rgb)
            rgb.save(recorded, compress_level=0)
        self.assertNotEqual(digest(recorded), digest(self.recorded_png()))
        with self.assertRaises(ValueError):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_sha256=digest(recorded))
        result = native_frames.ensure_native_frame(self.asset, self.asset.sha256,
            working_sha256=digest(recorded), working_rgb_sha256=raw_sha)
        with Image.open(result) as saved:
            self.assertEqual(native_frames.rgb_sha(saved), raw_sha)
            self.assertEqual(saved.size, (23, 31))
        with self.assertRaisesRegex(ValueError, 'Original decoded RGB'):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256,
                working_sha256=digest(recorded), working_rgb_sha256='0' * 64)
        with self.assertRaisesRegex(ValueError, 'Invalid recorded decoded RGB'):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_rgb_sha256='bad')

    def test_changed_cached_rgb_or_dimensions_are_refused_despite_same_source(self):
        with Image.open(self.source) as original:
            raw_sha = native_frames.rgb_sha(original)
        result = native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_rgb_sha256=raw_sha)
        with Image.open(result) as previous:
            changed = previous.copy()
        changed.putpixel((0, 0), (18, 83, 127)); changed.save(result)
        with self.assertRaisesRegex(ValueError, 'Cached native RGB'):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_rgb_sha256=raw_sha)
        changed.resize((31, 23)).save(result)
        with self.assertRaisesRegex(ValueError, 'Cached native RGB'):
            native_frames.ensure_native_frame(self.asset, self.asset.sha256, working_rgb_sha256=raw_sha)

    def test_route_png_response_query_validation_and_conflict(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.routers.assets import router
        from app.routers.deps import get_2d_asset
        app = FastAPI(); app.include_router(router, prefix='/api')
        app.dependency_overrides[get_2d_asset] = lambda: self.asset
        with TestClient(app) as client:
            path = '/api/assets/811/native-frame'
            response = client.get(path, params={'source_sha256': self.asset.sha256, 'working_sha256': digest(self.recorded_png())})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['content-type'], 'image/png')
            self.assertEqual(response.content, self.recorded_png().read_bytes())
            self.assertEqual(client.get(path, params={'source_sha256': '../original.tif'}).status_code, 422)
            self.assertEqual(client.get(path, params={'source_sha256': '0' * 64}).status_code, 409)
            with Image.open(self.source) as original:
                raw_sha = native_frames.rgb_sha(original)
            self.assertEqual(client.get(path, params={'source_sha256': self.asset.sha256,
                'working_sha256': '0' * 64, 'working_rgb_sha256': raw_sha}).status_code, 200)
            self.assertEqual(client.get(path, params={'source_sha256': self.asset.sha256,
                'working_rgb_sha256': '0' * 64}).status_code, 409)
            self.assertEqual(client.get(path, params={'source_sha256': self.asset.sha256,
                'working_rgb_sha256': 'bad'}).status_code, 422)

    def test_gallery_asset_payload_has_actual_source_sha(self):
        with patch.object(serialize.previews, 'has_preview', return_value=False):
            self.assertEqual(serialize.asset_brief(self.asset).sha256, self.asset.sha256)


if __name__ == '__main__':
    unittest.main()
