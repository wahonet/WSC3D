"""Lossless TIFF compaction, recovery and interruption checks on temporary data."""
from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'src/backend'))
from PIL import Image
import compact_resources as compact
from app.resource_archives import archived_entries, extract_resource


class ResourceCompactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wsc-resource-compaction-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'resources/stones').mkdir(parents=True)
        environment = patch.dict(os.environ, {'WSC_CACHE_ROOT': str(self.root / 'cache')})
        environment.start()
        self.addCleanup(environment.stop)

    def image(self, name='resources/stones/武001/images/原图.tif', color='gray'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (127, 93), color).save(path, format='TIFF', compression='raw')
        os.utime(path, ns=(1_700_000_000_123_456_789, 1_700_000_000_123_456_789))
        return path

    def apply(self, workers=2):
        with redirect_stdout(StringIO()):
            return compact.compact(self.root, workers)

    def test_model_texture_and_other_inputs_stay_as_loose_files(self):
        photo = self.image()
        texture = self.image('resources/stones/武001/models/scan/texture.tif')
        other = self.image('resources/stones/武001/notes/reference.tif')
        self.apply()
        self.assertFalse(photo.exists())
        self.assertTrue(texture.is_file())
        self.assertTrue(other.is_file())

    def test_common_pack_directory_exists_before_parallel_workers(self):
        self.image()
        self.image('resources/stones/武002/images/原图.tif', 'red')
        pack_stone = compact.pack_stone
        def checked(root, files):
            self.assertTrue((root / compact.PACKS_REL).is_dir())
            return pack_stone(root, files)
        with patch.object(compact, 'pack_stone', side_effect=checked):
            self.apply()

    def test_plan_does_not_create_files(self):
        self.image()
        before = {p.relative_to(self.root) for p in self.root.rglob('*')}
        report = compact.plan(self.root)
        self.assertEqual(report['original_files'], 1)
        self.assertEqual(before, {p.relative_to(self.root) for p in self.root.rglob('*')})

    def test_roundtrip_preserves_bytes_metadata_and_other_resources(self):
        first = self.image()
        second = self.image('resources/stones/武002/versions/1/abc/图.TIFF', 'red')
        unrelated = self.image('resources/authoring/输入.tif', 'blue')
        png = self.root / 'resources/stones/武001/images/预览.png'
        Image.new('RGB', (7, 8)).save(png)
        originals = {p.relative_to(self.root).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
                     for p in [first, second]}
        untouched = {p: p.read_bytes() for p in [unrelated, png]}
        report = self.apply()
        self.assertEqual(report['removed_original_files'], 2)
        self.assertTrue(all(not (self.root / name).exists() for name in originals))
        manifest = compact.read_manifest(self.root)
        self.assertEqual(len(manifest['packs']), 2)
        for name, (content, stamp) in originals.items():
            entry = manifest['files'][name]
            self.assertEqual((entry['width'], entry['height'], entry['fmt']), (127, 93, 'TIFF'))
            with zipfile.ZipFile(self.root / compact.PACKS_REL / entry['pack']) as archive:
                self.assertEqual(archive.read(name), content)
                self.assertEqual(archive.getinfo(name).compress_type, zipfile.ZIP_DEFLATED)
            cached = extract_resource(self.root / name, self.root, self.root / 'cache')
            self.assertEqual(cached.read_bytes(), content)
            self.assertEqual(cached.stat().st_mtime_ns, stamp)
        self.assertEqual(self.apply()['removed_original_files'], 0)
        restored = compact.restore(self.root)
        self.assertEqual(restored['restored_files'], 2)
        self.assertEqual(archived_entries(self.root), {})
        for name, (content, stamp) in originals.items():
            self.assertEqual((self.root / name).read_bytes(), content)
            self.assertEqual((self.root / name).stat().st_mtime_ns, stamp)
        self.assertTrue(all(p.read_bytes() == content for p, content in untouched.items()))

    def test_failed_archive_verification_keeps_original_and_no_manifest(self):
        path = self.image()
        before = path.read_bytes()
        with patch.object(compact, 'verify_member', side_effect=ValueError('模拟校验失败')):
            with self.assertRaisesRegex(RuntimeError, '原件仍保留'):
                self.apply()
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.root / compact.MANIFEST_REL).exists())

    def test_source_change_after_pack_is_not_deleted(self):
        path = self.image()
        pack_stone = compact.pack_stone

        def changed(*args):
            result = pack_stone(*args)
            self.image(color='green')
            return result

        with patch.object(compact, 'pack_stone', side_effect=changed):
            report = self.apply()
        self.assertEqual(report['removed_original_files'], 0)
        self.assertTrue(path.is_file())
        self.assertEqual(len(report['changed_originals_kept']), 1)
        changed_bytes = path.read_bytes()
        with self.assertRaisesRegex(RuntimeError, '散文件与归档原件不同'):
            compact.restore(self.root)
        self.assertEqual(path.read_bytes(), changed_bytes)
        # Applying again intentionally records this new supplied original.
        self.assertEqual(self.apply()['removed_original_files'], 1)
        compact.restore(self.root)
        self.assertEqual(path.read_bytes(), changed_bytes)

    def test_resume_manifest_published_before_original_removal(self):
        path = self.image()
        content = path.read_bytes()
        name, info, entries = compact.pack_stone(self.root, [path])
        compact.write_manifest(self.root, {'format': compact.FORMAT, 'files': entries, 'packs': {name: info}})
        with patch.object(compact, 'pack_stone', side_effect=AssertionError('不应重复压缩')):
            self.assertEqual(self.apply()['removed_original_files'], 1)
        compact.restore(self.root)
        self.assertEqual(path.read_bytes(), content)

    def test_existing_manifest_and_other_stones_survive_incremental_run(self):
        first = self.image()
        self.apply()
        previous = dict(archived_entries(self.root))
        second = self.image('resources/stones/武002/images/new.tif', 'blue')
        self.apply()
        current = archived_entries(self.root)
        self.assertEqual(current[first.relative_to(self.root).as_posix()], next(iter(previous.values())))
        self.assertIn(second.relative_to(self.root).as_posix(), current)

    def test_corrupt_published_pack_never_removes_remaining_original(self):
        path = self.image()
        content = path.read_bytes()
        name, info, entries = compact.pack_stone(self.root, [path])
        compact.write_manifest(self.root, {'format': compact.FORMAT, 'files': entries, 'packs': {name: info}})
        pack = self.root / compact.PACKS_REL / name
        pack.write_bytes(b'corrupt archive')
        with self.assertRaises(zipfile.BadZipFile):
            self.apply()
        self.assertEqual(path.read_bytes(), content)

    def test_publication_failure_keeps_original(self):
        path = self.image()
        content = path.read_bytes()
        with patch.object(compact, 'write_manifest', side_effect=OSError('模拟磁盘写入失败')):
            with self.assertRaises(OSError):
                self.apply()
        self.assertEqual(path.read_bytes(), content)
        self.assertFalse((self.root / compact.MANIFEST_REL).exists())

    def test_apply_requires_stopped_workspace(self):
        self.image()
        with compact.workspace_lock(self.root / 'data'):
            with self.assertRaisesRegex(RuntimeError, '正在使用'):
                self.apply()

    def test_invalid_manifest_does_not_delete_original(self):
        path = self.image()
        pack_dir = self.root / compact.PACKS_REL
        pack_dir.mkdir(parents=True)
        (pack_dir / 'manifest.json').write_text(json.dumps({'format': 'unrecognized'}), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.apply()
        self.assertTrue(path.is_file())


if __name__ == '__main__':
    unittest.main()
