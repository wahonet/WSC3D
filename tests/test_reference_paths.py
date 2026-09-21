"""Reference reorganization preserves catalogue links and offline handovers."""
from contextlib import closing
from dataclasses import replace
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.parse import quote
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'tools/authoring'))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import resource_paths
from app.routers import archive
from app.services.resources import within
import transfer
import project as authoring_project


class ReferencePathTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(self.enterContext(TemporaryDirectory(prefix='wsc-reference-test-'))).resolve()
        self.root = self.base / 'project'
        (self.root / 'config').mkdir(parents=True)
        self.manifest = self.root / 'config/resource-aliases.json'
        self.enterContext(patch.object(resource_paths, 'ROOT', self.root))
        self.enterContext(patch.object(resource_paths, 'MANIFEST', self.manifest))
        self.enterContext(patch.object(authoring_project, 'ROOT', self.root))
        self.enterContext(patch.object(archive, 'settings', replace(
            archive.settings, root=self.root, resources_dir=self.root / 'resources')))
        self.enterContext(patch.dict(os.environ, {'LOCALAPPDATA': str(self.base / 'cache')}))
        resource_paths._aliases.cache_clear()
        self.addCleanup(resource_paths._aliases.cache_clear)
        app = FastAPI()
        app.include_router(archive.files)
        self.client = self.enterContext(TestClient(app))

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def aliases(self, values):
        self.manifest.write_text(json.dumps({'aliases': [
            {'path': old, 'target': new} for old, new in values.items()
        ]}, ensure_ascii=False), encoding='utf-8')
        resource_paths._aliases.cache_clear()

    def test_catalogue_pdf_and_presentation_links_keep_serving_original_bytes(self):
        cases = (
            ('20260907/定级报告.pdf', '报告与说明/定级报告.pdf', b'%PDF-1.7\noriginal report'),
            ('20260907/附：资料/画像石.pptx', '演示资料/画像石.pptx', b'PK\x03\x04original presentation'),
        )
        self.aliases({f'resources/imports/{old}': f'resources/reference/{new}'
                      for old, new, _ in cases})
        for old, new, content in cases:
            self.write(f'resources/reference/{new}', content)
            with self.subTest(old=old):
                response = self.client.get('/files/imports/' + quote(old))
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, content)
                partial = self.client.get('/files/imports/' + quote(old), headers={'Range': 'bytes=0-3'})
                self.assertEqual(partial.status_code, 206)
                self.assertEqual(partial.content, content[:4])

    def test_reintroduced_original_takes_precedence_over_moved_reference(self):
        old = 'resources/imports/20260907/report.pdf'
        new = 'resources/reference/报告与说明/report.pdf'
        self.write(new, b'older report')
        self.aliases({old: new})
        self.write(old, b'researcher updated original')
        response = self.client.get('/files/imports/20260907/report.pdf')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b'researcher updated original')

    def test_recipe_enumeration_preserves_source_names_after_directory_relocation(self):
        old = 'resources/sources/site-survey/CAD图纸/院落.dxf'
        new = 'resources/reference/测绘与CAD/院落.dxf'
        target = self.write(new, b'original drawing')
        self.aliases({old: new})
        self.assertFalse((self.root / 'resources/sources/site-survey').exists())
        self.assertEqual(list(authoring_project.source_files('data/sources/site-survey')),
                         [(self.root / old, target)])
        replacement = self.write(old, b'new researcher drawing')
        self.assertEqual(list(authoring_project.source_files('data/sources/site-survey')),
                         [(replacement, replacement)])

    def test_missing_recipe_reference_fails_instead_of_silently_omitting_source(self):
        self.aliases({'resources/sources/site-survey/missing.dwg':
                      'resources/reference/测绘与CAD/missing.dwg'})
        with self.assertRaises(FileNotFoundError):
            list(authoring_project.source_files('data/sources/site-survey'))

    def test_cross_directory_alias_does_not_allow_traversal_or_external_target(self):
        self.write('resources/reference/报告与说明/report.pdf', b'report')
        self.aliases({'resources/imports/escape.pdf': 'data/private.pdf'})
        self.write('data/private.pdf', b'private')
        with self.assertRaises(HTTPException) as traversal:
            within(self.root / 'resources/imports', '../reference/报告与说明/report.pdf')
        self.assertEqual(traversal.exception.status_code, 404)
        response = self.client.get('/files/imports/escape.pdf')
        self.assertEqual(response.status_code, 409)
        self.assertNotIn(b'private', response.content)

    def test_handover_moves_reference_and_flattens_existing_alias(self):
        old = 'resources/imports/20260907/report.pdf'
        existing = 'resources/sources/site-survey/定级材料/report.pdf'
        new = 'resources/reference/报告与说明/report.pdf'
        self.write(old, b'original survey report')
        self.aliases({existing: old})
        self.write('config/project.json', b'{}')
        self.write('config/models.json', b'{}')
        (self.root / 'data').mkdir()
        with closing(sqlite3.connect(self.root / transfer.DB)) as db:
            db.execute('CREATE TABLE provenance(id INTEGER PRIMARY KEY, source TEXT)')
            db.execute('INSERT INTO provenance VALUES(1,?)', ('/files/imports/20260907/report.pdf',))
            db.commit()
        transfer.initialize(self.root)
        recipient = self.base / 'recipient'
        shutil.copytree(self.root, recipient)
        (self.root / new).parent.mkdir(parents=True)
        (self.root / old).rename(self.root / new)
        self.aliases({existing: new, old: new})
        package = self.base / 'handover.zip'
        transfer.export_package(self.root, package)
        with zipfile.ZipFile(package) as archive_file:
            manifest = json.loads(archive_file.read('handover.json'))
        self.assertIn(old, manifest['removed'])
        self.assertIn(new, manifest['files'])
        self.assertIn('config/resource-aliases.json', manifest['files'])
        transfer.import_package(recipient, package)
        self.assertEqual(transfer.capture(self.root), transfer.capture(recipient))
        self.assertFalse((recipient / old).exists())
        self.assertEqual((recipient / new).read_bytes(), b'original survey report')
        with patch.object(resource_paths, 'ROOT', recipient), patch.object(
                resource_paths, 'MANIFEST', recipient / 'config/resource-aliases.json'):
            resource_paths._aliases.cache_clear()
            self.assertEqual(resource_paths.resolve_resource(recipient / existing), recipient / new)
            self.assertEqual(resource_paths.resolve_resource(recipient / old), recipient / new)
        with closing(sqlite3.connect((recipient / transfer.DB).as_uri() + '?mode=ro', uri=True)) as db:
            self.assertEqual(db.execute('SELECT source FROM provenance').fetchone()[0],
                             '/files/imports/20260907/report.pdf')


if __name__ == '__main__':
    unittest.main(verbosity=2)
