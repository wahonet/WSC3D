"""Exercise the static identity gate on the published dataset and injected regressions."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import unittest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from knowledge_person_identities import check_person_identities


class PublishedPersonIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "config/knowledge-graph/core10-candidates.v1.json"
        cls.data = json.loads(path.read_text(encoding="utf-8"))

    def sample(self):
        data = deepcopy(self.data)
        merge = next(item for item in data["identity_merges"] if item.get("merged_node_ids") and item.get("aliases"))
        canonical = next(node for node in data["nodes"] if node["id"] == merge["canonical_node_id"])
        edge = next(edge for edge in data["edges"] if edge["relation"] == "has_character" and canonical["id"] in (edge["source"], edge["target"]))
        return data, merge, canonical, edge

    def test_real_dataset_has_no_duplicate_canonical_person_in_any_story(self):
        result = check_person_identities(self.data)
        self.assertTrue(result["passed"], result)
        self.assertGreaterEqual(result["explicit_merge_count"], 3)

    def test_restoring_an_old_alias_node_is_rejected_as_duplicate_person(self):
        data, merge, canonical, edge = self.sample()
        alias = {**canonical, "id": merge["merged_node_ids"][0], "label": merge["aliases"][0], "aliases": [], "alias_evidence_ids": []}
        data["nodes"].append(alias)
        relation = {**edge, "id": "test:duplicate-alias-relation"}
        endpoint = "source" if edge["source"] == canonical["id"] else "target"
        relation[endpoint] = alias["id"]
        data["edges"].append(relation)
        result = check_person_identities(data)
        self.assertFalse(result["passed"])
        self.assertTrue(result["duplicate_story_persons"])
        self.assertTrue(any(error["reason"] == "retired_alias_node_still_present" for error in result["declaration_errors"]))

    def test_duplicate_edge_to_one_canonical_person_is_rejected(self):
        data, _, _, edge = self.sample()
        data["edges"].append({**edge, "id": "test:duplicate-character-edge"})
        result = check_person_identities(data)
        self.assertFalse(result["passed"])
        self.assertTrue(result["duplicate_story_persons"])

    def test_story_scoped_role_is_not_merged_by_the_named_person_alias_rule(self):
        data, merge, canonical, edge = self.sample()
        person_endpoint = "source" if edge["source"] == canonical["id"] else "target"
        story_id = edge["target"] if person_endpoint == "source" else edge["source"]
        role = {**canonical, "id": "person:test:scoped-role", "label": merge["aliases"][0], "aliases": [],
                "alias_evidence_ids": [], "entity_scope": "story_role", "context_story_id": story_id}
        data["nodes"].append(role)
        data["edges"].append({**edge, "id": "test:scoped-role-edge", person_endpoint: role["id"]})
        result = check_person_identities(data)
        self.assertTrue(result["passed"], result)

    def test_contextual_ruler_alias_only_merges_in_its_declared_stories(self):
        data = deepcopy(self.data)
        canonical = next(node for node in data["nodes"] if node.get("contextual_aliases"))
        alias = canonical["contextual_aliases"][0]
        story_id = alias["story_ids"][0]
        edge = next(edge for edge in data["edges"] if edge["relation"] == "has_character" and {edge["source"], edge["target"]} == {canonical["id"], story_id})
        role = {**canonical, "id": "person:test:contextual-ruler", "label": alias["label"], "aliases": [], "contextual_aliases": [],
                "alias_evidence_ids": [], "entity_scope": "story_role", "context_story_id": story_id}
        person_endpoint = "source" if edge["source"] == canonical["id"] else "target"
        story_endpoint = "target" if person_endpoint == "source" else "source"
        relation = {**edge, "id": "test:contextual-ruler-edge", person_endpoint: role["id"]}
        data["nodes"].append(role); data["edges"].append(relation)
        self.assertTrue(check_person_identities(data)["duplicate_story_persons"])
        other_story = next(node["id"] for node in data["nodes"] if node["kind"] == "story" and node["id"] not in alias["story_ids"])
        role["context_story_id"] = other_story
        relation[story_endpoint] = other_story
        result = check_person_identities(data)
        self.assertTrue(result["passed"], result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
