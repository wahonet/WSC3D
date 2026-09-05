# -*- coding: utf-8 -*-
"""Run a durable, sequential library OCR queue through the local HTTP API.

The state file records this run's target and finished pages. Resume never infers
success from old ``done`` page flags: only the accepted job's processed prefix
is trusted. If the server loses that job identity, stop for inspection instead
of silently submitting the same pages again.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class QueueBlocked(RuntimeError):
    """Continuing automatically could overwrite or misattribute OCR results."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def state_lock(path: Path):
    """OS-held lock, automatically released on process exit (including crashes)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.with_suffix(path.suffix + ".lock").open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise QueueBlocked(f"State file is already in use: {path}") from exc
        yield
    finally:
        handle.close()


class Api:
    def __init__(self, base_url: str, timeout: float = 300):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = Request(self.base_url + "/api/library" + path, data=data,
                      headers={"Content-Type": "application/json"}, method=method)
        with urlopen(req, timeout=self.timeout) as response:
            return json.load(response)

    def get(self, path: str):
        return self.request("GET", path)

    def post(self, path: str, body=None):
        return self.request("POST", path, body)


def all_pages(api, document_id: int) -> list[dict]:
    pages = []
    while True:
        batch = api.get(f"/documents/{document_id}/pages?offset={len(pages)}&limit=500")
        pages.extend(batch)
        if len(batch) < 500:
            break
    numbers = [p["page_no"] for p in pages]
    if len(set(numbers)) != len(numbers):
        raise QueueBlocked(f"Duplicate page numbers in document {document_id}")
    return pages


def job_key(job: dict) -> dict:
    return {key: job.get(key) for key in ("document_id", "engine", "started_at", "total")}


class QueueRunner:
    def __init__(self, api, path: Path, state: dict, poll_seconds: float = 5, sleep=time.sleep):
        self.api, self.path, self.state = api, path, state
        self.poll_seconds, self.sleep = poll_seconds, sleep
        self.last_log = None
        self.last_finished_job = None

    def save(self, message: str | None = None):
        if message is not None:
            self.state["message"] = message
        self.state["updated_at"] = now()
        self.state["runner_pid"] = os.getpid()
        documents = self.state["documents"]
        total = sum(len(d["targets"]) for d in documents)
        done = sum(len(d["completed"]) for d in documents)
        failed = sum(len(d["errors"]) for d in documents)
        self.state["progress"] = {"total": total, "done": done, "failed": failed,
                                  "remaining": total - done - failed}
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(self.state, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)
        line = (self.state["status"], done, failed, self.state.get("message", ""))
        if line != self.last_log:
            print(f"[{now()}] {line[0]}: {done + failed}/{total} processed, "
                  f"{failed} errors. {line[3]}", flush=True)
            self.last_log = line

    @classmethod
    def create(cls, api, path: Path, redo: bool, **kwargs):
        if path.exists():
            raise QueueBlocked(f"State already exists; use --resume or a new --state: {path}")
        if api.get("/ocr/status")["job"]["running"]:
            raise QueueBlocked("Another OCR job is running; wait or cancel it before starting the queue.")
        documents = []
        for doc in api.get("/documents"):
            pages = all_pages(api, doc["id"])
            if len(pages) != doc["page_count"]:
                raise QueueBlocked(f"Page inventory differs from document {doc['id']} page_count.")
            if any(p["status"] == "running" for p in pages):
                raise QueueBlocked(f"Document {doc['id']} has stale running pages; inspect the previous job first.")
            targets = sorted(p["page_no"] for p in pages
                             if redo or p["status"] in ("pending", "error"))
            documents.append({"id": doc["id"], "code": doc["code"], "title": doc["title"],
                              "engine": "ndl" if doc["script"] == "classical" else "mineru",
                              "targets": targets, "completed": [], "errors": {},
                              "status": "pending" if targets else "skipped"})
        state = {"version": 1, "base_url": api.base_url, "created_at": now(), "redo": redo,
                 "status": "ready", "documents": documents, "active": None}
        runner = cls(api, path, state, **kwargs)
        runner.save(f"Queued {len(documents)} documents; automatic engines.")
        return runner

    @classmethod
    def resume(cls, api, path: Path, **kwargs):
        state = json.loads(path.read_text(encoding="utf-8"))
        if state.get("version") != 1 or state.get("base_url") != api.base_url:
            raise QueueBlocked("State version or server URL does not match.")
        return cls(api, path, state, **kwargs)

    def start_document(self, document: dict):
        current = self.api.get("/ocr/status")["job"]
        if current.get("cancel_requested") and job_key(current) == self.last_finished_job:
            self.state["status"] = "cancelled"
            self.save("Cancellation received between documents; no further documents will start.")
            return False
        if current["running"]:
            raise QueueBlocked("Another OCR job appeared; this queue will not adopt or cancel it.")
        finished = set(document["completed"]) | {int(p) for p in document["errors"]}
        pages = [p for p in document["targets"] if p not in finished]
        if not pages:
            document["status"] = "completed_with_errors" if document["errors"] else "completed"
            return True
        active = {"document_id": document["id"], "pages": pages, "phase": "submitting", "last_done": 0}
        self.state["active"] = active
        self.state["status"] = "running"
        document["status"] = "running"
        self.save(f"Starting {document['code']} ({document['engine']}), {len(pages)} pages.")
        # Persist before POST. A timeout or process crash here is ambiguous; never retry automatically.
        try:
            job = self.api.post(f"/documents/{document['id']}/ocr",
                                {"engine": document["engine"], "pages": pages, "redo": True,
                                 "backend": ""})
        except HTTPError as exc:
            # Explicit rejection means the request did not launch an OCR job.
            if 400 <= exc.code < 500 or exc.code == 503:
                self.state["active"] = None
                document["status"] = "pending"
            else:
                active["phase"] = "submission_unknown"
            raise QueueBlocked(f"OCR start returned HTTP {exc.code}; no automatic retry.") from exc
        except Exception as exc:
            active["phase"] = "submission_unknown"
            raise QueueBlocked("OCR start response was lost. Inspect the backend job before recovery; "
                               "the queue will not submit this request twice.") from exc
        if (job.get("document_id") != document["id"] or job.get("engine") != document["engine"]
                or job.get("total") != len(pages) or not job.get("started_at")):
            active["phase"] = "submission_unknown"
            raise QueueBlocked("OCR start response does not identify the requested job.")
        active.update({"phase": "running", "job_key": job_key(job)})
        self.save(f"Running {document['code']} ({document['engine']}).")
        return True

    def record_progress(self, document: dict, active: dict, job: dict):
        count = job.get("done", 0)
        if not isinstance(count, int) or not active["last_done"] <= count <= len(active["pages"]):
            raise QueueBlocked("OCR processed count regressed or exceeded this job's target pages.")
        if count > active["last_done"]:
            pages = {p["page_no"]: p for p in all_pages(self.api, document["id"])}
            latest = self.api.get("/ocr/status")["job"]
            if job_key(latest) != active["job_key"]:
                raise QueueBlocked("OCR job changed while reading page results; progress was not accepted.")
            job["cancel_requested"] = bool(job.get("cancel_requested") or latest.get("cancel_requested"))
            for number in active["pages"][active["last_done"]:count]:
                page = pages.get(number, {})
                if page.get("status") == "done":
                    if number not in document["completed"]:
                        document["completed"].append(number)
                elif page.get("status") == "error":
                    document["errors"][str(number)] = page.get("error") or "OCR failed"
                else:
                    raise QueueBlocked(f"Processed page {document['id']}/{number} is not done or error.")
            active["last_done"] = count
        self.save(f"{document['code']}: {job.get('message', '')}")

    def monitor(self):
        active = self.state["active"]
        if active["phase"] != "running":
            raise QueueBlocked("The saved OCR submission has no confirmed response. Inspect the job and state; "
                               "automatic resubmission is disabled.")
        document = next(d for d in self.state["documents"] if d["id"] == active["document_id"])
        while True:
            job = self.api.get("/ocr/status")["job"]
            if job_key(job) != active["job_key"]:
                raise QueueBlocked("OCR job identity changed or the backend restarted. "
                                   "Stopped to avoid accepting another job's progress or repeating completed pages.")
            if job.get("cancel_requested"):
                self.state["status"] = "cancelling"
            self.record_progress(document, active, job)
            if not job["running"]:
                self.state["active"] = None
                if job.get("cancel_requested"):
                    document["status"] = "pending"
                    self.state["status"] = "cancelled"
                    self.save("Cancellation acknowledged; no further documents will start. Use --resume to continue.")
                    return False
                if job["done"] != len(active["pages"]):
                    document["status"] = "pending"
                    raise QueueBlocked("OCR job ended before processing all requested pages: " + job.get("message", ""))
                document["status"] = "completed_with_errors" if document["errors"] else "completed"
                self.last_finished_job = job_key(job)
                self.save(f"Finished {document['code']}.")
                return True
            self.sleep(self.poll_seconds)

    def run(self) -> int:
        try:
            self.state["status"] = "running"
            self.save("Queue runner started.")
            if self.state.get("active") and not self.monitor():
                return 2
            for document in self.state["documents"]:
                if document["status"] in ("completed", "completed_with_errors", "skipped"):
                    continue
                if not self.start_document(document):
                    return 2
                if self.state.get("active") and not self.monitor():
                    return 2
            self.state["status"] = "completed_with_errors" if any(d["errors"] for d in self.state["documents"]) else "completed"
            self.save("Library queue finished. Error details are recorded per document in this state file.")
            return 1 if self.state["status"] == "completed_with_errors" else 0
        except KeyboardInterrupt:
            # Stop the queue runner only. The in-flight OCR remains identifiable for --resume.
            self.state["status"] = "paused"
            self.save("Runner interrupted; the current backend job may continue. Use --resume to reconnect.")
            return 130
        except Exception as exc:
            self.state["status"] = "blocked"
            self.save(f"{type(exc).__name__}: {exc}")
            return 3


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8020")
    parser.add_argument("--state", type=Path, default=Path(__file__).resolve().parents[1] / "server/data/library/ocr-queue.json")
    parser.add_argument("--redo", action="store_true", help="Include pages already completed at queue creation")
    parser.add_argument("--resume", action="store_true", help="Continue the saved queue, preserving its original target list")
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--request-timeout", type=float, default=300, help="HTTP timeout, including OCR worker startup")
    args = parser.parse_args(argv)
    if args.poll_seconds <= 0 or args.request_timeout <= 0:
        parser.error("poll-seconds and request-timeout must be positive")
    api = Api(args.base_url, args.request_timeout)
    try:
        with state_lock(args.state):
            if args.resume:
                runner = QueueRunner.resume(api, args.state, poll_seconds=args.poll_seconds)
            else:
                runner = QueueRunner.create(api, args.state, args.redo, poll_seconds=args.poll_seconds)
            return runner.run()
    except (QueueBlocked, OSError, ValueError) as exc:
        print(f"Queue could not start: {exc}", file=sys.stderr, flush=True)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
