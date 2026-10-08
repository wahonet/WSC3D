"""Isolated authentication and file-boundary checks; never opens the research DB."""
from pathlib import Path
import json, os, sys, tempfile, unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers import reconstruction, workspace


class ReconstructionFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wsc-reconstruction-')
        self.root = Path(self.temp.name)
        self.patch = patch.object(reconstruction, 'ROOT', self.root / 'cases'); self.patch.start()
        self.case = reconstruction.ROOT / 'wuliang-test'; self.case.mkdir(parents=True)
        self.data = {'schemaVersion': 1, 'id': 'wuliang-test', 'title': 'Test', 'parts': [],
                     'publishedFiles': ['outputs/model.glb', 'WORKLOG.md']}
        self.write_manifest()
        (self.case / 'outputs').mkdir(); (self.case / 'outputs/model.glb').write_bytes(b'glTF' + bytes(range(60)))
        (self.case / 'WORKLOG.md').write_text('复原经过', encoding='utf-8')
        (self.case / 'private.txt').write_text('private')
        (self.root / 'outside.txt').write_text('outside')
        app = FastAPI(); app.include_router(workspace.router, prefix='/api'); app.include_router(reconstruction.router)
        self.client = TestClient(app)

    def write_manifest(self):
        (self.case / 'manifest.json').write_text(json.dumps(self.data), encoding='utf-8')

    def login(self):
        result = self.client.post('/api/workspace/login', json={'username': 'admin', 'password': os.environ.get('WSC_WORKSPACE_PASSWORD', '123456')})
        self.assertEqual(result.status_code, 200)

    def tearDown(self):
        self.client.close(); self.patch.stop(); self.temp.cleanup()

    def test_requires_workspace_for_metadata_and_every_file(self):
        for path in ['', '/wuliang-test', '/wuliang-test/files/outputs/model.glb', '/wuliang-test/files/WORKLOG.md']:
            self.assertEqual(self.client.get('/api/reconstruction' + path).status_code, 401)
        self.login()
        self.assertEqual(self.client.get('/api/reconstruction').json()['cases'][0]['id'], 'wuliang-test')
        self.client.post('/api/workspace/logout')
        self.assertEqual(self.client.get('/api/reconstruction/wuliang-test').status_code, 401)

    def test_only_published_files_and_no_traversal(self):
        self.login()
        base = '/api/reconstruction/wuliang-test/files/'
        self.assertEqual(self.client.get(base + 'private.txt').status_code, 404)
        # Even a mistaken publication entry cannot escape the project's resolved root.
        self.data['publishedFiles'] += ['../../outside.txt', str(self.root / 'outside.txt')]
        self.write_manifest()
        self.assertEqual(self.client.get(base + '%2e%2e%2f%2e%2e%2foutside.txt').status_code, 404)
        for name in ['unknown', 'BAD_ID', '%2e%2e%2foutside']:
            self.assertEqual(self.client.get('/api/reconstruction/' + name).status_code, 404)

    def test_download_range_and_no_cache(self):
        self.login(); base = '/api/reconstruction/wuliang-test/files/'
        result = self.client.get(base + 'outputs/model.glb', headers={'Range': 'bytes=0-3'})
        self.assertEqual(result.status_code, 206); self.assertEqual(result.content, b'glTF')
        self.assertEqual(result.headers['content-type'], 'model/gltf-binary')
        self.assertIn('no-store', result.headers['cache-control'])
        result = self.client.get(base + 'WORKLOG.md?download=true')
        self.assertIn('attachment', result.headers['content-disposition']); self.assertEqual(result.text, '复原经过')

    def test_damaged_or_mismatched_manifest_fails_closed(self):
        self.login()
        (self.case / 'manifest.json').write_text('{oops')
        self.assertEqual(self.client.get('/api/reconstruction/wuliang-test').status_code, 409)
        listing = self.client.get('/api/reconstruction').json()
        self.assertEqual(listing['cases'], []); self.assertEqual(len(listing['errors']), 1)
        self.data['id'] = 'another-case'; self.write_manifest()
        self.assertEqual(self.client.get('/api/reconstruction/wuliang-test').status_code, 409)


if __name__ == '__main__':
    unittest.main(verbosity=2)
