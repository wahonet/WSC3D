"""True concurrent HTTP saves and transactional FTS checks on a temporary DB."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='wsc-segment-concurrency-')
os.environ['STONELAB_DATA'] = _temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from app.db import Base, get_db
from app.models import Document, Page, Segment
from app.routers.library import router
from app.services import library


class SegmentConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='case-', dir=_temp.name)
        self.engine = create_engine('sqlite:///' + (Path(self.folder.name) / 'db.sqlite').as_posix(),
                                    connect_args={'check_same_thread': False})
        Base.metadata.create_all(self.engine)
        with Session(self.engine) as db:
            db.execute(text('CREATE VIRTUAL TABLE segments_fts USING fts5(text, segment_id UNINDEXED, document_id UNINDEXED, page_no UNINDEXED)'))
            db.add(Document(id=1, code='T1', title='fixture', relpath='fixture.pdf', page_count=1)); db.flush()
            db.add(Page(id=1, document_id=1, page_no=1)); db.flush()
            db.add(Segment(id=1, document_id=1, page_id=1, seq=0, text='original', text_edit='', revision=0))
            db.execute(text("INSERT INTO segments_fts VALUES ('original',1,1,1)")); db.commit()
        app = FastAPI(); app.include_router(router, prefix='/api')
        def session():
            with Session(self.engine, autoflush=False, expire_on_commit=False) as db: yield db
        app.dependency_overrides[get_db] = session
        self.clients = [TestClient(app), TestClient(app)]

    def tearDown(self):
        for client in self.clients: client.close()
        self.engine.dispose(); self.folder.cleanup()

    def state(self):
        with Session(self.engine) as db:
            row = db.get(Segment, 1)
            fts = db.execute(text('SELECT text FROM segments_fts WHERE segment_id=1')).scalars().all()
            return row.text_edit, row.revision, fts

    def test_two_requests_that_read_the_same_revision_cannot_both_commit(self):
        barrier = threading.Barrier(2, timeout=10); first_done = threading.Event()
        original = library.patch_segment
        def coordinated(db, row, text_edit, kind, review, note, base_revision):
            self.assertEqual(row.revision, 0)
            barrier.wait()
            if text_edit == 'editor B':
                self.assertTrue(first_done.wait(10))
                return original(db, row, text_edit, kind, review, note, base_revision)
            try: return original(db, row, text_edit, kind, review, note, base_revision)
            finally: first_done.set()
        def save(index):
            return self.clients[index].patch('/api/library/segments/1',
                        json={'text_edit': ['editor A', 'editor B'][index], 'base_revision': 0})
        with patch.object(library, 'patch_segment', side_effect=coordinated), ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(save, range(2)))
        self.assertEqual([r.status_code for r in responses], [200, 409])
        self.assertEqual(self.state(), ('editor A', 1, ['editor A']))

    def test_missing_revision_legacy_client_still_has_atomic_save_protection(self):
        with Session(self.engine) as first, Session(self.engine) as second:
            a, b = first.get(Segment, 1), second.get(Segment, 1)
            library.patch_segment(first, a, 'first', None, None, None, None)
            with self.assertRaises(HTTPException) as error:
                library.patch_segment(second, b, 'second', None, None, None, None)
            self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(self.state(), ('first', 1, ['first']))

    def test_stale_no_op_is_not_reported_as_success(self):
        with Session(self.engine) as first, Session(self.engine) as second:
            a, b = first.get(Segment, 1), second.get(Segment, 1)
            library.patch_segment(first, a, 'first', None, None, None, 0)
            with self.assertRaises(HTTPException) as error:
                library.patch_segment(second, b, '', None, None, None, 0)
            self.assertEqual(error.exception.status_code, 409)

    def test_no_op_metadata_edit_and_clearing_text_keep_expected_revisions_and_fts(self):
        client = self.clients[0]
        for body, revision in [({'text_edit': ''}, 0), ({'note': 'checked'}, 1),
                               ({'text_edit': 'corrected'}, 2), ({'text_edit': ''}, 3)]:
            response = client.patch('/api/library/segments/1', json={**body, 'base_revision': self.state()[1]})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['revision'], revision)
        self.assertEqual(self.state(), ('', 3, ['original']))

    def test_fts_failure_rolls_back_segment_and_search_index_together(self):
        with Session(self.engine) as db:
            row = db.get(Segment, 1); execute = db.execute
            def fail_insert(statement, *args, **kwargs):
                if str(statement).startswith('INSERT INTO segments_fts'):
                    raise RuntimeError('simulated index failure')
                return execute(statement, *args, **kwargs)
            with patch.object(db, 'execute', side_effect=fail_insert), self.assertRaises(RuntimeError):
                library.patch_segment(db, row, 'must roll back', None, None, None, 0)
        self.assertEqual(self.state(), ('', 0, ['original']))


if __name__ == '__main__': unittest.main(verbosity=2)
