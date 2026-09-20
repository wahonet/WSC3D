"""New-file scans run against temporary folders and an in-memory business database."""
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import sys
import unittest
import hashlib
import json

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from PIL import Image
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from app.db import Base
from app.models import Annotation, Asset, Stone
from app.services import catalogue, resource_versions, resources, scanner


class ArchiveScanTests(unittest.TestCase):
    def setUp(self):
        folder = self.enterContext(TemporaryDirectory(prefix='wsc-archive-scan-'))
        self.root = Path(folder).resolve()
        self.settings = replace(scanner.settings, assets_root=self.root / 'stones')
        self.enterContext(patch.object(scanner, 'settings', self.settings))
        self.enterContext(patch.object(resources, 'settings', self.settings))
        self.enterContext(patch.object(catalogue, 'all_books', return_value=[]))
        engine = create_engine('sqlite://')
        Base.metadata.create_all(engine)
        self.addCleanup(engine.dispose)
        self.db = self.enterContext(Session(engine))
        for sid in ('武901', '武902'):
            self.db.add(Stone(id=sid, code=sid, dirname=sid, name=sid, archive={'intro': '人工简介', 'note': '保留笔记'}))
        self.db.commit()

    def picture(self, sid, name):
        path = self.settings.assets_root / sid / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (40, 30), (50, 60, 70)).save(path)
        return path

    def scan(self, sid=None):
        return scanner.scan(self.db, stone_id=sid, additions_only=True, publish_archive=True)

    def test_core_manifest_scan_resolves_shared_file_and_detects_replacement(self):
        from app import resource_paths
        from app.services import library
        originals = self.root/'resources/documents/core/originals'
        originals.mkdir(parents=True)
        frozen = self.root/'resources/documents/core/versions/frozen.pdf'
        frozen.parent.mkdir(parents=True)
        frozen.write_bytes(b'original book content')
        logical = originals/'book.pdf'
        aliases = self.root/'aliases.json'
        aliases.write_text(json.dumps({'aliases': [{'path': logical.relative_to(self.root).as_posix(), 'target': frozen.relative_to(self.root).as_posix()}]}))
        self.db.execute(text('CREATE TABLE source_manifests(id TEXT PRIMARY KEY, payload TEXT)'))
        payload = json.dumps([{'relpath': 'book.pdf', 'file_sha256': hashlib.sha256(frozen.read_bytes()).hexdigest()}])
        self.db.execute(text("INSERT INTO source_manifests VALUES('core10-files-v1',:payload)"), {'payload': payload})
        self.enterContext(patch.object(library, 'settings', replace(library.settings, library_root=originals)))
        self.enterContext(patch.object(resource_paths, 'ROOT', self.root))
        self.enterContext(patch.object(resource_paths, 'MANIFEST', aliases))
        resource_paths._aliases.cache_clear()
        self.addCleanup(resource_paths._aliases.cache_clear)
        report = library.scan(self.db)
        self.assertEqual((report['documents'], report['removed'], report['updated']), (1, 0, 0))
        logical.write_bytes(b'replaced live book')
        self.assertEqual(library.scan(self.db)['updated'], 1)
        self.assertEqual(frozen.read_bytes(), b'original book content')

    def test_single_then_batch_are_idempotent_and_visible_in_archive(self):
        self.picture('武901', 'images/photos/new.png')
        self.picture('武902', 'images/research-rubbings/new.png')
        self.picture('武901', 'images/photos/previews/generated.jpg')
        self.picture('武901', 'images/thumbnails/generated.jpg')
        single = self.scan('武901')
        self.assertEqual((single['stones'], single['assets_added'], single['archive_added']), (1, 1, 1))
        self.assertEqual(self.db.query(Asset).filter_by(stone_id='武902').count(), 0)
        detail = catalogue.detail(self.db.get(Stone, '武901'), self.db)
        self.assertEqual(detail['photo_count'], 1)
        self.assertEqual(detail['intro'], '人工简介')
        item = detail['media_versions'][0]['items'][0]
        self.assertEqual(detail['media_versions'][0]['label'], '本地新增照片')
        self.assertEqual(item['url'], f"/api/assets/{item['asset_id']}/preview")
        self.assertTrue(item['original_url'].endswith('/images/photos/new.png'))
        self.assertEqual(self.scan()['assets_added'], 1)
        self.assertEqual(self.scan()['assets_added'], 0)
        self.assertEqual(self.db.query(Asset).count(), 2)
        self.assertTrue(catalogue.brief(self.db.get(Stone, '武902'))['has_rubbing'])

    def test_existing_assets_and_annotations_are_not_rehashed_or_changed(self):
        path = self.picture('武901', 'images/photos/old.png')
        self.scan('武901')
        asset = self.db.query(Asset).one()
        original_sha = asset.sha256
        annotation = Annotation(stone_id='武901', asset_id=asset.id, tool='annotate', atype='point', geometry={'point': [.2, .4]}, label='人工标注')
        self.db.add(annotation); self.db.commit()
        Image.new('RGB', (40, 30), (80, 90, 100)).save(path)
        with patch.object(resource_versions, 'digest', side_effect=AssertionError('Old files must not be hashed')):
            self.assertEqual(self.scan()['assets_added'], 0)
        self.assertEqual(asset.sha256, original_sha)
        self.assertEqual(annotation.geometry, {'point': [.2, .4]})

    def test_archived_images_and_physical_aliases_are_not_duplicated(self):
        old = self.picture('武901', 'images/rubbings/catalogue.png')
        stone = self.db.get(Stone, '武901')
        stone.archive = {**stone.archive, 'rubbing': 'images/rubbings/catalogue.png'}
        self.db.commit()
        self.assertEqual(self.scan('武901')['assets_added'], 0)
        actual = self.picture('武901', 'images/photos/shared.png')
        self.db.add(Asset(stone_id='武901', kind='photo', filename='logical.png', relpath='武901/images/photos/logical.png'))
        self.db.commit()
        resolver = resources.live_asset_path
        with patch.object(resources, 'live_asset_path', side_effect=lambda rel: actual if rel.endswith('logical.png') else resolver(rel)):
            self.assertEqual(self.scan('武901')['assets_added'], 0)
        self.assertTrue(old.exists())

    def test_incomplete_copy_skipped_and_can_be_retried(self):
        broken = self.settings.assets_root / '武901/images/photos/incomplete.png'
        broken.parent.mkdir(parents=True); broken.write_bytes(b'not-a-complete-image')
        self.picture('武901', 'images/photos/good.png')
        result = self.scan('武901')
        self.assertEqual(result['assets_added'], 1)
        self.assertEqual(len(result['skipped']), 1)
        self.picture('武901', 'images/photos/incomplete.png')
        self.assertEqual(self.scan('武901')['assets_added'], 1)

    def test_overlapping_scan_rejected(self):
        with scanner._scan_lock:
            with self.assertRaises(HTTPException) as error:
                self.scan()
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.scan()['assets_added'], 0)

    def test_full_check_still_tracks_rename_missing_and_replacement(self):
        original = self.picture('武901', 'images/photos/original.png')
        self.scan('武901')
        asset = self.db.query(Asset).one()
        identity, sha = asset.id, asset.sha256
        self.db.connection().exec_driver_sql('CREATE TABLE IF NOT EXISTS asset_versions(id INTEGER PRIMARY KEY, asset_id INTEGER, payload TEXT, created_at TEXT)')
        renamed = original.with_name('renamed.png')
        original.rename(renamed)
        self.assertEqual(scanner.scan(self.db)['assets_updated'], 1)
        self.assertEqual(asset.id, identity)
        held = self.root / 'held.png'
        renamed.rename(held)
        self.assertIn(identity, scanner.scan(self.db)['assets_missing'])
        held.rename(renamed)
        Image.new('RGB', (40, 30), (5, 10, 15)).save(renamed)
        self.assertIn(identity, scanner.scan(self.db)['changed_files'])
        self.assertEqual(asset.sha256, sha)
        self.assertEqual(self.db.query(Asset).count(), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
