"""West-gallery optimistic locking, using disposable layout files only."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.routers import xcl_layout


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wsc-layout-')
        self.folder = Path(self.temp.name)
        default = self.folder / 'xcl-default.json'
        default.write_bytes((ROOT / 'data/layouts/xcl-default.json').read_bytes())
        self.patch = patch.multiple(xcl_layout, FOLDER=self.folder, CURRENT=self.folder/'xcl.json', DEFAULT=default)
        self.patch.start()
        app = FastAPI(); app.include_router(xcl_layout.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close(); self.patch.stop(); self.temp.cleanup()

    def load(self): return self.client.get('/api/layouts/xcl').json()

    def draft(self):
        draft = self.load(); draft['base_updated_at'] = draft['updated_at']; return draft

    def test_current_version_can_save_repeatedly_and_retains_history(self):
        draft = self.draft(); draft['stones'][0]['along'] += .01
        response = self.client.post('/api/layouts/xcl', json=draft)
        self.assertEqual(response.status_code, 200, response.text)
        draft['base_updated_at'] = response.json()['updated_at']; draft['stones'][0]['along'] += .01
        self.assertEqual(self.client.post('/api/layouts/xcl', json=draft).status_code, 200)
        self.assertEqual(self.load()['stones'][0]['along'], round(draft['stones'][0]['along'], 6))
        self.assertEqual(len(list((self.folder/'history').glob('*.json'))), 2)

    def test_stale_snapshot_cannot_undo_a_change_to_another_stone(self):
        first = self.draft(); second = copy.deepcopy(first)
        first['stones'][0]['along'] += .01; second['stones'][1]['along'] += .01
        self.assertEqual(self.client.post('/api/layouts/xcl', json=first).status_code, 200)
        saved = self.load()
        self.assertEqual(self.client.post('/api/layouts/xcl', json=second).status_code, 409)
        self.assertEqual(self.load(), saved)
        self.assertEqual(len(list((self.folder/'history').glob('*.json'))), 1)

    def test_missing_token_and_invalid_layout_do_not_write(self):
        before = self.load()
        self.assertEqual(self.client.post('/api/layouts/xcl', json=before).status_code, 409)
        invalid = self.draft(); invalid['stones'][0]['along'] = 'invalid'
        self.assertEqual(self.client.post('/api/layouts/xcl', json=invalid).status_code, 422)
        self.assertEqual(self.load(), before)
        self.assertFalse((self.folder/'history').exists())

    def test_simultaneous_saves_accept_exactly_one_snapshot(self):
        drafts = [self.draft(), self.draft()]
        for i, draft in enumerate(drafts): draft['stones'][i]['along'] += .01
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda body: self.client.post('/api/layouts/xcl', json=body), drafts))
        self.assertEqual(sorted(r.status_code for r in responses), [200, 409])
        winner = next(i for i, response in enumerate(responses) if response.status_code == 200)
        self.assertEqual(self.load()['stones'][winner]['along'], round(drafts[winner]['stones'][winner]['along'], 6))


if __name__ == '__main__': unittest.main(verbosity=2)
