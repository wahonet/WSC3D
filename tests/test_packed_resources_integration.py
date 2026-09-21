"""Exercise packed TIFFs through scans, immutable bases and video provenance."""
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from app import resource_archives, resource_paths
from app.db import Base
from app.models import Annotation, Asset, Stone
from app.services import resource_versions, resources, scanner, video_sources


class PackedResourcesIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory(prefix='wsc-packed-integration-'))).resolve()
        self.settings = replace(scanner.settings, root=self.root,
                                assets_root=self.root / 'resources/stones',
                                data_dir=self.root / 'data', cache_dir=self.root / 'cache')
        self.settings.data_dir.mkdir()
        for module in (scanner, resources, resource_versions, video_sources):
            self.enterContext(patch.object(module, 'settings', self.settings))
        self.enterContext(patch.object(resource_paths, 'ROOT', self.root))
        self.enterContext(patch.object(resource_paths, 'MANIFEST', self.root / 'aliases.json'))
        self.enterContext(patch.dict(os.environ, {'WSC_CACHE_ROOT': str(self.settings.cache_dir)}))
        resource_paths._aliases.cache_clear()
        self.addCleanup(resource_paths._aliases.cache_clear)
        self.addCleanup(resource_archives._load.cache_clear)
        engine = create_engine(self.settings.database_url)
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        self.db = self.enterContext(Session(engine))
        self.db.execute(text('CREATE TABLE asset_versions(id INTEGER PRIMARY KEY, asset_id INTEGER, payload TEXT, created_at TEXT)'))
        self.stone = Stone(id='武901', code='武901', dirname='测试石__武901', name='测试石')
        self.db.add(self.stone)
        self.db.commit()
        self.original = self.settings.assets_root / self.stone.dirname / 'images/originals/原始照片.tif'
        self.original.parent.mkdir(parents=True)
        Image.new('RGB', (160, 120), '#254060').save(self.original, compression='raw')
        self.original_bytes = self.original.read_bytes()

    def pack(self, paths):
        folder = self.root / resource_archives.PACKS_REL
        folder.mkdir(parents=True, exist_ok=True)
        self.pack_path = folder / 'test.zip'
        entries = {}
        with zipfile.ZipFile(self.pack_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in paths:
                raw, stamp = path.read_bytes(), path.stat()
                name = path.relative_to(self.root).as_posix()
                with Image.open(path) as image:
                    width, height, fmt = image.width, image.height, image.format
                archive.writestr(name, raw)
                entries[name] = dict(pack='test.zip', member=name, bytes=len(raw),
                                     sha256=hashlib.sha256(raw).hexdigest(), mtime_ns=stamp.st_mtime_ns,
                                     width=width, height=height, fmt=fmt)
        manifest = dict(format=resource_archives.FORMAT, files=entries,
                        packs={'test.zip': {'bytes': self.pack_path.stat().st_size,
                                            'sha256': hashlib.sha256(self.pack_path.read_bytes()).hexdigest()}})
        (self.root / resource_archives.MANIFEST_REL).write_text(json.dumps(manifest), encoding='utf-8')
        for path in paths:
            path.unlink()  # Only synthetic images below this test's temporary root.
        resource_archives._load.cache_clear()

    def register(self):
        scanner.scan(self.db)
        return self.db.query(Asset).one()

    def test_new_packed_image_is_registered_without_unpacking_and_scan_is_idempotent(self):
        self.pack([self.original])
        with patch.object(resource_archives, 'extract_resource', side_effect=AssertionError('Scan must not unpack originals')):
            result = scanner.scan(self.db, additions_only=True, publish_archive=True)
            self.assertEqual((result['assets_added'], result['archive_added']), (1, 1))
            again = scanner.scan(self.db)
            self.assertEqual((again['assets_kept'], again['assets_added'], again['assets_missing']), (1, 0, []))
        asset = self.db.query(Asset).one()
        self.assertEqual((asset.width, asset.height, asset.fmt), (160, 120, 'TIFF'))
        self.assertEqual(asset.sha256, hashlib.sha256(self.original_bytes).hexdigest())
        self.assertFalse(self.settings.cache_dir.exists())

    def test_alias_to_packed_original_keeps_existing_identity(self):
        asset = self.register()
        alias = self.original.with_name('历史文件名.tif')
        asset.relpath = alias.relative_to(self.settings.assets_root).as_posix()
        asset.filename = alias.name
        self.db.commit()
        resource_paths.MANIFEST.write_text(json.dumps({'aliases': [{
            'path': alias.relative_to(self.root).as_posix(),
            'target': self.original.relative_to(self.root).as_posix()}]}), encoding='utf-8')
        self.pack([self.original])
        with patch.object(resource_archives, 'extract_resource', side_effect=AssertionError('Alias scan must not unpack')):
            result = scanner.scan(self.db)
        self.assertEqual((result['assets_kept'], result['assets_added'], result['assets_missing']), (1, 0, []))
        self.assertEqual(self.db.query(Asset).count(), 1)
        self.assertEqual(asset.filename, alias.name)

    def test_loose_replacement_overrides_pack_and_requires_review(self):
        asset = self.register()
        initial_sha = asset.sha256
        self.pack([self.original])
        Image.new('RGB', (160, 120), '#ffffff').save(self.original, compression='raw')
        self.assertIsNone(resource_paths.resource_metadata(self.original))
        result = scanner.scan(self.db)
        self.assertEqual(result['changed_files'], [asset.id])
        self.assertEqual(asset.sha256, initial_sha)
        self.assertEqual(self.db.query(Asset).count(), 1)
        saved = json.loads(self.db.execute(text('SELECT payload FROM asset_versions')).scalar_one())
        self.assertEqual(saved['kind'], 'replacement-pending')

    def test_unavailable_pack_aborts_without_marking_assets_missing(self):
        asset = self.register()
        snapshot = resource_versions.pin_asset(self.db, asset)
        self.db.commit()
        self.pack([self.original, resource_versions.snapshot_path(snapshot)])
        valid_pack = self.pack_path.read_bytes()
        for state in ('missing', 'truncated'):
            with self.subTest(state=state):
                if state == 'missing':
                    self.pack_path.unlink()
                else:
                    self.pack_path.write_bytes(valid_pack[:20])
                with self.assertRaises(HTTPException) as error:
                    scanner.scan(self.db)
                self.assertEqual(error.exception.status_code, 409)
                self.assertFalse(asset.missing)
                self.assertFalse(self.db.dirty)
                self.assertEqual(self.db.execute(text('SELECT count(*) FROM asset_versions')).scalar_one(), 1)
                with self.assertRaises(HTTPException) as pin_error:
                    resource_versions.pin_asset(self.db, asset)
                self.assertEqual(pin_error.exception.status_code, 409)
                self.pack_path.write_bytes(valid_pack)

    def test_packed_snapshot_keeps_editability_and_video_source_identity(self):
        asset = self.register()
        snapshot = resource_versions.pin_asset(self.db, asset)
        self.db.add(Annotation(id=11, stone_id=self.stone.id, asset_id=asset.id,
                               tool='annotate', atype='rect', review_status='reviewed', label='纹饰',
                               geometry={'x': .1, 'y': .1, 'w': .5, 'h': .5}))
        self.db.commit()
        options = video_sources.PrepareRequest(annotation_ids=[11])
        before = video_sources.prepare(self.db, options)
        fixed = resource_versions.snapshot_path(snapshot)
        stamp = fixed.stat().st_mtime_ns
        self.pack([self.original, fixed])
        with patch.object(resource_archives, 'extract_resource', side_effect=AssertionError('Pin check must not unpack')):
            self.assertEqual(resource_versions.pin_asset(self.db, asset), snapshot)
        after = video_sources.prepare(self.db, options)
        self.assertEqual(after['id'], before['id'])
        self.assertEqual(after['source'], before['source'])
        materialized = resources.asset_path(asset.relpath)
        self.assertFalse(materialized.is_relative_to(self.settings.assets_root))
        self.assertEqual(materialized.read_bytes(), self.original_bytes)
        self.assertEqual(materialized.stat().st_mtime_ns, stamp)
        self.assertEqual(resource_paths.logical_resource_path(materialized), fixed)
        self.assertEqual(resources.within(self.settings.assets_root, asset.relpath).read_bytes(), self.original_bytes)

    def test_same_size_pack_corruption_aborts_full_scan_without_changing_database(self):
        asset = self.register()
        self.pack([self.original])
        before = self.db.execute(text('SELECT * FROM assets')).all()
        content = bytearray(self.pack_path.read_bytes())
        with zipfile.ZipFile(self.pack_path) as archive:
            member = archive.infolist()[0]
        name_size, extra_size = struct.unpack_from('<HH', content, member.header_offset + 26)
        data_offset = member.header_offset + 30 + name_size + extra_size
        content[data_offset + member.compress_size // 2] ^= 1
        self.pack_path.write_bytes(content)
        # The central directory and byte count still look valid to a light scan.
        self.assertEqual(resource_paths.resource_metadata(self.original)['sha256'], asset.sha256)
        with self.assertRaises(HTTPException) as error:
            scanner.scan(self.db)
        self.assertEqual(error.exception.status_code, 409)
        self.assertFalse(self.db.dirty)
        self.assertEqual(self.db.execute(text('SELECT * FROM assets')).all(), before)
        self.assertEqual(self.db.execute(text('SELECT count(*) FROM asset_versions')).scalar_one(), 0)
        self.assertFalse(self.settings.cache_dir.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
