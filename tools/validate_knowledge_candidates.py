"""Read-only validation of the portable core10 graph against the current archive.

Usage: tools/run.ps1 tools/validate_knowledge_candidates.py
No tables, annotations, concepts, or source records are created or updated.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src/backend"))

from app.db import SessionLocal
from app.models import Annotation, Concept, Stone
from app.services import knowledge_graph
from knowledge_person_identities import check_person_identities


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=knowledge_graph.DATASET_PATH)
    parser.add_argument("--output", type=Path, default=ROOT / "logs/knowledge-validation.json")
    args = parser.parse_args()
    if not args.dataset.is_file():
        parser.error(f"Dataset does not exist: {args.dataset}")
    original_bytes = args.dataset.read_bytes()
    raw = json.loads(original_bytes)
    with SessionLocal() as db:
        db.connection().exec_driver_sql("PRAGMA query_only=ON")
        before = {"annotations": db.query(Annotation).count(), "concepts": db.query(Concept).count()}
        data = knowledge_graph.graph(db, path=args.dataset, limit=3000)
        actual_stones = {item.id for item in db.query(Stone).all()}
        missing_stones = [n.get("stone_id") for n in data["nodes"] if n["kind"] == "stone" and n.get("stone_id") not in actual_stones]
        after = {"annotations": db.query(Annotation).count(), "concepts": db.query(Concept).count()}
        occurrence_counts = {node["stone_id"]: len(knowledge_graph._occurrences(data, node["stone_id"])) for node in data["nodes"] if node["kind"] == "stone"}
    evidence_errors = [{key: item.get(key) for key in ("id", "document_id", "page_no", "segment_id", "source_status", "source_notice")}
                       for item in data["evidence"] if not item["source_available"]]
    nodes = {node["id"]: node for node in data["nodes"]}
    role_context_errors = [edge["id"] for edge in data["edges"]
                           for source, target in ((edge["source"], edge["target"]), (edge["target"], edge["source"]))
                           if nodes[source].get("entity_scope") == "story_role" and nodes[target]["kind"] == "story"
                           and nodes[source].get("context_story_id") != target]
    evidence_documents = {item["document_id"] for item in data["evidence"] if item["source_available"]}
    missing_document_evidence = [item["document_id"] for item in data["documents"] if item["document_id"] not in evidence_documents]
    person_identities = check_person_identities(raw)
    dataset_unchanged = args.dataset.read_bytes() == original_bytes
    passed = not any((evidence_errors, missing_stones, role_context_errors, missing_document_evidence)) and person_identities["passed"] and dataset_unchanged and before == after and not data["meta"]["truncated"]
    report = {
        "validated_at": datetime.now(timezone.utc).isoformat(), "passed": passed,
        "dataset": str(args.dataset.resolve()), "dataset_sha256": hashlib.sha256(original_bytes).hexdigest(),
        "read_only": True, "database_guard": "PRAGMA query_only=ON", "database_row_counts_before": before, "database_row_counts_after": after,
        "dataset_unchanged_during_validation": dataset_unchanged, "meta": data["meta"],
        "evidence_states": dict(Counter(item["source_status"] for item in data["evidence"])),
        "relations": dict(Counter(item["relation"] for item in data["edges"])),
        "core_document_ids": [document["document_id"] for document in data["documents"]],
        "document_coverage": [{key: document.get(key) for key in ("document_id", "title", "total_pages", "readable_pages", "evidence_count")} for document in data["documents"]],
        "stone_occurrences": occurrence_counts, "missing_stones": missing_stones,
        "role_context_errors": role_context_errors, "documents_without_valid_evidence": missing_document_evidence,
        "person_identity_validation": person_identities,
        "unresolved_stone_associations": len(raw.get("unresolved_stone_associations", [])),
        "evidence_errors": evidence_errors,
        "scope_note": "Checks source identity, core manifest membership, physical page ownership, unchanged text excerpts, graph consistency and read-only behavior. Candidate historical interpretation still requires human review."
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": passed, "sha256": report["dataset_sha256"], "nodes": data["meta"]["total_nodes"],
                      "edges": data["meta"]["total_edges"], "evidence_available": data["meta"]["evidence_available"],
                      "evidence_total": data["meta"]["evidence_total"], "output": str(args.output)}, ensure_ascii=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
