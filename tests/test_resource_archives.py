"""Packed originals preserve bytes, logical identity and cold-cache behavior."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import hashlib
import json
import os
import subprocess
import sys
import time
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from app import resource_archives as packs, resource_paths


class PackedOriginalTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(TemporaryDirectory(prefix='wsc-packed-original-'))
        self.root = Path(self.folder) / 'project'
        self.cache = Path(self.folder) / 'cache'
        self.name = 'resources/stones/试验__武901/images/originals/原图.tif'
        self.path = self.root / self.name
        self.content = bytes(range(256)) * 8192
        self.sha = hashlib.sha256(self.content).hexdigest()
        self.stamp = 1700000000123456700
        self.pack = self.root / packs.PACKS_REL / 'stone.zip'
        self.pack.parent.mkdir(parents=True)
        with zipfile.ZipFile(self.pack, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(self.name, self.content)
        self.value = {'format': packs.FORMAT, 'files': {self.name: {
            'pack': self.pack.name, 'member': self.name, 'bytes': len(self.content),
            'mtime_ns': self.stamp, 'sha256': self.sha, 'width': 20, 'height': 10, 'fmt': 'TIFF',
        }}, 'packs': {self.pack.name: {'bytes': self.pack.stat().st_size}}}
        self.write_manifest()
        self.enterContext(patch.dict(os.environ, {'WSC_CACHE_ROOT': str(self.cache)}))
        self.enterContext(patch.object(resource_paths, 'ROOT', self.root))
        self.enterContext(patch.object(resource_paths, 'MANIFEST', self.root / 'config/resource-aliases.json'))

    def write_manifest(self):
        path = self.root / packs.MANIFEST_REL
        path.write_text(json.dumps(self.value, ensure_ascii=False), encoding='utf-8')
        packs._load.cache_clear()

    def test_cold_cache_preserves_original_bytes_timestamp_and_identity(self):
        cached = resource_paths.resolve_resource(self.path)
        self.assertEqual(cached.read_bytes(), self.content)
        self.assertEqual(cached.stat().st_mtime_ns, self.stamp)
        self.assertEqual(resource_paths.logical_resource_path(cached), self.path)
        self.assertTrue(cached.is_relative_to(self.cache))
        self.assertFalse(self.path.exists())

    def test_new_physical_original_overrides_pack(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_bytes(b'new researcher supplied original')
        self.assertEqual(resource_paths.resolve_resource(self.path), self.path)
        self.assertIsNone(resource_paths.resource_metadata(self.path))

    def test_existing_alias_reaches_packed_original(self):
        alias = self.root / 'resources/stones/试验__武901/images/research/别名.tif'
        resource_paths.MANIFEST.parent.mkdir(parents=True)
        resource_paths.MANIFEST.write_text(json.dumps({'aliases': [{
            'path': alias.relative_to(self.root).as_posix(), 'target': self.name,
        }]}), encoding='utf-8')
        self.assertEqual(resource_paths.resource_metadata(alias)['path'], self.name)
        self.assertEqual(resource_paths.resolve_resource(alias).read_bytes(), self.content)

    def test_metadata_and_enumeration_do_not_extract_original(self):
        directory = self.root / 'resources/stones'
        self.assertTrue(resource_paths.resource_exists(self.path))
        self.assertEqual(resource_paths.resource_metadata(self.path)['sha256'], self.sha)
        self.assertEqual(list(resource_paths.iter_resource_files(directory)), [self.path])
        self.assertFalse(self.cache.exists())

    def test_modified_cache_is_rebuilt(self):
        cached = resource_paths.resolve_resource(self.path)
        cached.write_bytes(b'x' * len(self.content))
        os.utime(cached, ns=(self.stamp + 10000000, self.stamp + 10000000))
        self.assertEqual(resource_paths.resolve_resource(self.path).read_bytes(), self.content)

    def test_concurrent_first_requests_share_verified_file(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: resource_paths.resolve_resource(self.path), range(16)))
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(results[0].read_bytes(), self.content)
        self.assertEqual(list(self.cache.rglob('*.tmp')), [])

    def test_another_process_waits_for_cache_publication(self):
        backend = str(Path(__file__).resolve().parents[1] / 'src/backend')
        code = ("import sys,hashlib;from pathlib import Path;"
                "sys.path.insert(0,sys.argv[1]);from app import resource_archives as p;"
                "Path(sys.argv[4]).write_text('ready');"
                "result=p.extract_resource(Path(sys.argv[3]),Path(sys.argv[2]));"
                "print(hashlib.sha256(result.read_bytes()).hexdigest())")
        target = packs._cache_path(self.name, self.value['files'][self.name], self.root)
        ready = Path(self.folder) / 'child-ready'
        with packs._process_lock(target):
            child = subprocess.Popen([sys.executable, '-B', '-c', code, backend,
                                      str(self.root), str(self.path), str(ready)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(lambda: child.communicate(timeout=5))
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists())
            time.sleep(0.15)
            self.assertIsNone(child.poll())
            self.assertFalse(target.exists())
        output, error = child.communicate(timeout=20)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(output.strip(), self.sha)

    def test_missing_pack_is_not_hidden_by_previous_cache(self):
        resource_paths.resolve_resource(self.path)
        self.pack.unlink()
        self.assertFalse(resource_paths.resource_exists(self.path))
        with self.assertRaises(FileNotFoundError):
            resource_paths.resolve_resource(self.path)

    def test_sha_mismatch_never_publishes_original(self):
        self.value['files'][self.name]['sha256'] = '0' * 64
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            resource_paths.resolve_resource(self.path)
        self.assertEqual(list(self.cache.rglob('*.tif')), [])
        self.assertEqual(list(self.cache.rglob('*.tmp')), [])

    def test_manifest_path_escape_is_rejected(self):
        self.value['files']['resources/../../outside.tif'] = self.value['files'].pop(self.name)
        self.write_manifest()
        with self.assertRaises(ValueError):
            packs.archived_entries(self.root)

    def test_forgotten_original_does_not_reappear_from_pack(self):
        packs.forget_archived([self.name], self.root)
        self.assertEqual(resource_paths.resolve_resource(self.path), self.path)
        self.assertFalse(resource_paths.resource_exists(self.path))
        self.assertEqual(packs.archived_entries(self.root), {})

    def test_missing_member_is_a_verification_error(self):
        self.value['files'][self.name]['member'] = 'resources/missing.tif'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'verified'):
            resource_paths.resolve_resource(self.path)


if __name__ == '__main__':
    unittest.main()
