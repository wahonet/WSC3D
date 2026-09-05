# -*- coding: utf-8 -*-
"""Queue regression tests: no models, database writes, or live HTTP requests."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from run_library_ocr import QueueBlocked, QueueRunner, all_pages, state_lock


def job(document_id=1, *, done=0, total=3, running=True, engine="mineru", stamp="2026-09-05T12:00:00", cancel=False):
    return {"running": running, "document_id": document_id, "engine": engine, "total": total,
            "done": done, "errors": 0, "started_at": stamp, "finished_at": None if running else stamp,
            "cancel_requested": cancel, "message": "test"}


class FakeApi:
    base_url = "http://127.0.0.1:8020"

    def __init__(self, documents=None):
        self.documents = documents or [
            {"id": 1, "code": "DOC-001", "title": "现代书", "script": "modern", "page_count": 3},
            {"id": 2, "code": "DOC-002", "title": "古籍", "script": "classical", "page_count": 2},
        ]
        self.pages = {d["id"]: [{"page_no": n, "status": "done", "error": ""}
                                 for n in range(1, d["page_count"] + 1)] for d in self.documents}
        self.current_job = job(document_id=None, total=0, running=False, stamp=None)
        self.started = []
        self.on_status = None
        self.post_error = None

    def get(self, path):
        if path == "/documents":
            return deepcopy(self.documents)
        if path == "/ocr/status":
            if self.on_status:
                self.on_status(self)
            return {"job": deepcopy(self.current_job)}
        doc = int(path.split("/")[2])
        offset = int(path.split("offset=")[1].split("&")[0])
        return deepcopy(self.pages[doc][offset:offset + 500])

    def post(self, path, body):
        self.started.append((path, deepcopy(body)))
        doc = int(path.split("/")[2])
        self.current_job = job(doc, total=len(body["pages"]), engine=body["engine"])
        if self.post_error:
            raise self.post_error
        return deepcopy(self.current_job)

    def finish(self):
        self.current_job["done"] = self.current_job["total"]
        self.current_job["running"] = False
        self.current_job["finished_at"] = "2026-09-05T12:00:05"


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "queue.json"
        self.api = FakeApi()

    def tearDown(self):
        self.temp.cleanup()

    def create(self, redo=True, **kwargs):
        return QueueRunner.create(self.api, self.path, redo, sleep=lambda _: None, **kwargs)

    def test_redo_runs_all_documents_and_chooses_engines(self):
        runner = self.create()
        self.api.on_status = lambda api: api.finish() if api.current_job["running"] else None
        self.assertEqual(runner.run(), 0)
        self.assertEqual([b["engine"] for _, b in self.api.started], ["mineru", "ndl"])
        self.assertEqual([b["pages"] for _, b in self.api.started], [[1, 2, 3], [1, 2]])
        state = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(state["progress"], {"total": 5, "done": 5, "failed": 0, "remaining": 0})

    def test_default_only_includes_pending_and_error(self):
        self.api.pages[1][0]["status"] = "pending"
        self.api.pages[1][2]["status"] = "error"
        runner = self.create(redo=False)
        self.assertEqual(runner.state["documents"][0]["targets"], [1, 3])
        self.assertEqual(runner.state["documents"][1]["targets"], [])

    def test_large_book_fetches_pages_after_500(self):
        self.api = FakeApi([{"id": 1, "code": "DOC-001", "title": "长书", "script": "modern", "page_count": 536}])
        self.assertEqual(len(all_pages(self.api, 1)), 536)
        self.assertEqual(self.create().state["progress"]["total"], 536)

    def test_existing_state_and_active_job_are_refused(self):
        self.create()
        with self.assertRaises(QueueBlocked):
            self.create()
        self.path.unlink()
        self.api.current_job = job(2)
        with self.assertRaises(QueueBlocked):
            self.create()
        self.assertEqual(self.api.started, [])

    def test_os_lock_prevents_duplicate_runner(self):
        with state_lock(self.path):
            with self.assertRaises(QueueBlocked):
                with state_lock(self.path):
                    self.fail("Second runner acquired the state lock")
        with state_lock(self.path):
            pass

    def test_old_done_flags_do_not_count_as_fresh_progress(self):
        runner = self.create()
        doc = runner.state["documents"][0]
        runner.start_document(doc)
        runner.record_progress(doc, runner.state["active"], self.api.current_job)
        self.assertEqual(doc["completed"], [])
        self.api.current_job["done"] = 1
        runner.record_progress(doc, runner.state["active"], self.api.current_job)
        self.assertEqual(doc["completed"], [1])

    def test_resume_reconnects_to_accepted_job_without_reposting(self):
        runner = self.create()
        runner.start_document(runner.state["documents"][0])
        self.api.current_job["done"] = 1
        runner.record_progress(runner.state["documents"][0], runner.state["active"], self.api.current_job)
        resumed = QueueRunner.resume(self.api, self.path, sleep=lambda _: None)
        self.api.on_status = lambda api: api.finish() if api.current_job["running"] else None
        self.assertEqual(resumed.run(), 0)
        self.assertEqual(len(self.api.started), 2)
        self.assertEqual(resumed.state["documents"][0]["completed"], [1, 2, 3])

    def test_api_cancel_stops_queue_and_resume_only_submits_remaining_pages(self):
        runner = self.create()
        runner.start_document(runner.state["documents"][0])
        self.api.current_job.update(done=1, running=False, cancel_requested=True)
        self.assertEqual(runner.run(), 2)
        self.assertEqual(len(self.api.started), 1)
        self.assertEqual(runner.state["status"], "cancelled")
        resumed = QueueRunner.resume(self.api, self.path, sleep=lambda _: None)
        self.api.on_status = lambda api: api.finish() if api.current_job["running"] else None
        self.assertEqual(resumed.run(), 0)
        self.assertEqual(self.api.started[1][1]["pages"], [2, 3])
        self.assertEqual(resumed.state["documents"][0]["completed"], [1, 2, 3])

    def test_failure_pages_are_summarized_and_next_document_runs(self):
        runner = self.create()
        self.api.pages[1][1].update(status="error", error="model failed")
        self.api.on_status = lambda api: api.finish() if api.current_job["running"] else None
        self.assertEqual(runner.run(), 1)
        self.assertEqual(runner.state["progress"], {"total": 5, "done": 4, "failed": 1, "remaining": 0})
        self.assertEqual(runner.state["documents"][0]["errors"], {"2": "model failed"})

    def test_cancel_between_books_does_not_start_next_book(self):
        runner = self.create()
        runner.start_document(runner.state["documents"][0])
        self.api.finish()
        self.assertTrue(runner.monitor())
        self.api.current_job["cancel_requested"] = True
        self.assertFalse(runner.start_document(runner.state["documents"][1]))
        self.assertEqual(runner.state["status"], "cancelled")
        self.assertEqual(len(self.api.started), 1)

    def test_job_change_during_page_read_does_not_accept_foreign_results(self):
        runner = self.create()
        document = runner.state["documents"][0]
        runner.start_document(document)
        self.api.current_job["done"] = 1
        snapshot = deepcopy(self.api.current_job)
        self.api.on_status = lambda api: api.current_job.update(started_at="2026-09-05T13:00:00")
        with self.assertRaises(QueueBlocked):
            runner.record_progress(document, runner.state["active"], snapshot)
        self.assertEqual(document["completed"], [])

    def test_foreign_job_never_counts_as_this_job(self):
        runner = self.create()
        runner.start_document(runner.state["documents"][0])
        self.api.current_job = job(1, done=3, running=False, stamp="2026-09-05T12:03:00")
        self.assertEqual(runner.run(), 3)
        self.assertEqual(runner.state["documents"][0]["completed"], [])
        self.assertEqual(len(self.api.started), 1)

    def test_lost_post_response_is_not_retried_even_on_resume(self):
        runner = self.create()
        self.api.post_error = TimeoutError("response lost")
        self.assertEqual(runner.run(), 3)
        self.assertEqual(runner.state["active"]["phase"], "submission_unknown")
        self.api.post_error = None
        resumed = QueueRunner.resume(self.api, self.path, sleep=lambda _: None)
        self.assertEqual(resumed.run(), 3)
        self.assertEqual(len(self.api.started), 1)

    def test_server_restart_does_not_reprocess_already_done_pages(self):
        runner = self.create()
        runner.start_document(runner.state["documents"][0])
        self.api.current_job = job(document_id=None, total=0, running=False, stamp=None)
        resumed = QueueRunner.resume(self.api, self.path, sleep=lambda _: None)
        self.assertEqual(resumed.run(), 3)
        self.assertEqual(len(self.api.started), 1)

    def test_early_job_failure_can_resume_remaining_target(self):
        runner = self.create()
        runner.start_document(runner.state["documents"][0])
        self.api.current_job.update(done=1, running=False, message="worker stopped")
        self.assertEqual(runner.run(), 3)
        self.assertIsNone(runner.state["active"])
        resumed = QueueRunner.resume(self.api, self.path, sleep=lambda _: None)
        self.api.on_status = lambda api: api.finish() if api.current_job["running"] else None
        self.assertEqual(resumed.run(), 0)
        self.assertEqual(self.api.started[1][1]["pages"], [2, 3])


if __name__ == "__main__":
    unittest.main()
