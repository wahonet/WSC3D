"""Check declared person aliases without inferring identity from similar names."""
from __future__ import annotations

from collections import defaultdict


def check_person_identities(data: dict) -> dict:
    nodes = {node["id"]: node for node in data["nodes"]}
    evidence = {item["id"] for item in data["evidence"]}
    declarations = data.get("identity_merges", [])
    errors = []
    names = defaultdict(set)
    contextual_names = defaultdict(set)
    retired = {}
    for merge in declarations:
        canonical_id = merge.get("canonical_node_id")
        canonical = nodes.get(canonical_id)
        if not canonical or canonical.get("kind") != "person" or canonical.get("entity_scope") == "story_role":
            errors.append({"reason": "invalid_canonical_person", "canonical_node_id": canonical_id})
            continue
        if merge.get("canonical_label") != canonical["label"]:
            errors.append({"reason": "canonical_label_mismatch", "canonical_node_id": canonical_id})
        if not merge.get("evidence_ids") or any(eid not in evidence for eid in merge["evidence_ids"]):
            errors.append({"reason": "alias_identity_missing_evidence", "canonical_node_id": canonical_id})
        for label in [canonical["label"], *merge.get("aliases", [])]:
            names[label].add(canonical_id)
        for old_id in merge.get("merged_node_ids", []):
            retired[old_id] = canonical_id
            if old_id in nodes:
                errors.append({"reason": "retired_alias_node_still_present", "node_id": old_id, "canonical_node_id": canonical_id})
    # Explicit node aliases also declare equivalence, even without a historical merge.
    for node in nodes.values():
        if node.get("kind") == "person" and node.get("entity_scope") != "story_role" and (node.get("aliases") or node.get("contextual_aliases")):
            for label in [node["label"], *node["aliases"]]:
                names[label].add(retired.get(node["id"], node["id"]))
            if not node.get("alias_evidence_ids") or any(eid not in evidence for eid in node["alias_evidence_ids"]):
                errors.append({"reason": "node_alias_missing_evidence", "node_id": node["id"]})
            for alias in node.get("contextual_aliases", []):
                if not alias.get("label") or not alias.get("story_ids"):
                    errors.append({"reason": "contextual_alias_missing_scope", "node_id": node["id"]})
                for story_id in alias.get("story_ids", []):
                    if nodes.get(story_id, {}).get("kind") != "story":
                        errors.append({"reason": "contextual_alias_invalid_story", "node_id": node["id"], "story_id": story_id})
                    contextual_names[(story_id, alias.get("label"))].add(node["id"])
    for label, owners in names.items():
        if len(owners) > 1:
            errors.append({"reason": "ambiguous_explicit_alias", "alias": label, "canonical_node_ids": sorted(owners)})
    for (story_id, label), owners in contextual_names.items():
        if len(owners) > 1:
            errors.append({"reason": "ambiguous_contextual_alias", "story_id": story_id, "alias": label, "canonical_node_ids": sorted(owners)})
    canonical_by_node = {}
    for node in nodes.values():
        if node.get("kind") != "person":
            continue
        # A generic ruler/attendant in another story is not a declared named person.
        if node.get("entity_scope") == "story_role":
            canonical_by_node[node["id"]] = retired.get(node["id"], node["id"])
            continue
        matches = set().union(*(names.get(label, set()) for label in [node["label"], *node.get("aliases", [])]))
        canonical_by_node[node["id"]] = next(iter(matches)) if len(matches) == 1 else retired.get(node["id"], node["id"])
    occurrences = defaultdict(list)
    for edge in data["edges"]:
        for endpoint in (edge["source"], edge["target"]):
            if endpoint in retired:
                errors.append({"reason": "relation_uses_retired_alias", "edge_id": edge["id"], "node_id": endpoint})
        if edge.get("relation") != "has_character":
            continue
        source, target = nodes.get(edge["source"]), nodes.get(edge["target"])
        if source is None or target is None:
            errors.append({"reason": "relation_missing_endpoint", "edge_id": edge["id"]})
            continue
        story, person = (source, target) if source.get("kind") == "story" else (target, source)
        if story.get("kind") == "story" and person.get("kind") == "person":
            context = set().union(*(contextual_names.get((story["id"], label), set()) for label in [person["label"], *person.get("aliases", [])]))
            canonical_id = next(iter(context)) if len(context) == 1 else canonical_by_node[person["id"]]
            occurrences[(story["id"], canonical_id)].append((person["id"], edge["id"]))
    duplicates = [{"story_id": story_id, "story_label": nodes[story_id]["label"], "canonical_node_id": person_id,
                   "canonical_label": nodes[person_id]["label"] if person_id in nodes else person_id,
                   "node_ids": sorted({node_id for node_id, _ in items}), "edge_ids": [edge_id for _, edge_id in items]}
                  for (story_id, person_id), items in occurrences.items() if len(items) > 1]
    return {"passed": not errors and not duplicates, "explicit_merge_count": len(declarations),
            "retired_alias_count": len(retired), "checked_story_person_relations": sum(map(len, occurrences.values())),
            "contextual_alias_scopes": len(contextual_names),
            "duplicate_story_persons": duplicates, "declaration_errors": errors,
            "scope": "Only explicit identity_merges and node aliases establish equivalence; contextual aliases apply only within their declared story IDs and other generic story roles remain separate."}
