"""Snapshot reviewed work separately from raw inference and unreviewed proposals."""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timezone
import json
import sqlite3
import hashlib
from pathlib import Path
from PIL import Image
from multiversion_sam import ROOT, OUT, WORK, proposal_path, write, decode
from multiversion_frames import reviewed_frames
from multiversion_commit_alignments import preserve_baseline
from multiversion_context import BASELINE
from multiversion_publication import publication_fields


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    preserved = preserve_baseline()
    inventory = read(OUT/'inventory.json')
    plan = read(OUT/'alignment-review-plan.json')
    decisions = read(OUT/'alignment-decisions.json')['decisions']
    alignment_manifest = read(OUT/'alignment-commits.json')
    commits = alignment_manifest['records']
    native_decisions = read(OUT/'native-decisions.json')
    native_commits = read(OUT/'native-commits.json')
    baseline = read(BASELINE)
    with sqlite3.connect((ROOT/'data/stonelab.db').as_uri()+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        assets = {r['id']: dict(r) for r in db.execute('SELECT * FROM assets')}
        annotations = [dict(r) for r in db.execute('SELECT * FROM annotations')]
    versions = []
    task_version_ids = {row['annotation_id'] for row in native_commits['versions']}
    by_id = {a['id']: a for a in annotations}
    for a in annotations:
        g = json.loads(a['geometry'])
        v = g.get('image_version')
        if a['id'] in task_version_ids and v and v.get('native_boundary_reviewed') is True:
            if v['source_asset_id'] != a['asset_id'] or v['source_sha256'] != assets[a['asset_id']]['sha256']:
                raise ValueError('A reviewed native source identity changed')
            versions.append(a)
    version_checks = []
    for decision in native_decisions['accepted']:
        proposal = read(OUT/decision['proposal'])
        job = proposal['job']
        record = next(r for r in native_commits['versions'] if r['asset_id'] == job['target_asset_id'] and
                      r['canonical_annotation_id'] == job['canonical_annotation_id'])
        row = by_id[record['annotation_id']]
        source = by_id[job['canonical_annotation_id']]
        geometry = json.loads(row['geometry'])
        meta = geometry['image_version']
        mask = proposal['result']['detections'][decision['detection_index']]['native_mask']
        binary = decode(mask)
        assert hashlib.sha256(binary.tobytes()).hexdigest() == mask['binary_sha256']
        assert int(binary.sum()) == mask['foreground_pixels']
        assert hashlib.file_digest(Path(job['crop_path']).open('rb'),'sha256').hexdigest() == job['crop_sha256']
        with Image.open(job['crop_path']) as native_source:
            assert binary.shape == (native_source.height, native_source.width), 'Reviewed mask must use the inspected source pixel frame'
        assert geometry['native_mask'] == mask and meta['segmentation']['proposal'] == decision['proposal']
        assert row['stone_id'] == source['stone_id'] and row['level'] == source['level']
        assert meta['canonical_asset_id'] == source['asset_id'] and meta['source_asset_id'] == row['asset_id']
        assert meta['source_sha256'] == assets[row['asset_id']]['sha256']
        if 'display_label' in decision:
            assert row['label'] == decision['display_label'], 'Bounded visible scope label changed'
        expected_fields = publication_fields(source, decision)
        assert all(row[key] == value for key, value in expected_fields.items()), 'Canonical research metadata changed'
        shared = meta.get('inherited_description_references', [])
        source_descriptions = [r for r in baseline['annotation_references'] if r['annotation_id'] == source['id'] and r['kind'] == 'description']
        assert len(shared) == len(source_descriptions), 'Original description binding must remain traceable'
        for inherited in shared:
            original = next(r for r in source_descriptions if r['id'] == inherited['reference_id'])
            assert inherited['format'] == 'wsc-shared-description-reference-1'
            assert inherited['source_annotation_id'] == source['id']
            assert all(inherited[k] == original[k] for k in ('desc_source', 'desc_start', 'desc_end', 'text'))
            excerpts = original['excerpts']
            assert inherited['excerpts'] == (json.loads(excerpts) if isinstance(excerpts, str) else excerpts)
        if source['parent_id'] is not None:
            assert row['parent_id'] == native_commits['parents'][f"{row['asset_id']}:{source['parent_id']}"]
        assert all((OUT/evidence).exists() for evidence in decision['evidence'])
        version_checks.append({'annotation_id':row['id'],'canonical_id':source['id'],'source_asset_id':row['asset_id'],
                               'level':row['level'],'mask_sha256':mask['binary_sha256'],'source_identity_verified':True,
                               'native_artifact_verified':True,'native_pixel_frame_verified':True,'hierarchy_verified':True})
    assert len(versions) == len(version_checks) == len(native_commits['versions'])
    resolved = [d for d in decisions if d.get('resolved_by') and
                any(c['review_key'] == d['resolved_by'] for c in commits)]
    unresolved = [d for d in decisions if d['decision'] == 'needs_recompute' and d not in resolved]
    batches = []
    for path in sorted(WORK.glob('native-jobs*.json')):
        jobs = read(path)
        total = sum(len(j['variants']) for j in jobs)
        done = sum(proposal_path(j, v).exists() for j in jobs for v in j['variants'])
        batches.append({'jobs_file': str(path.relative_to(ROOT)), 'regions': len(jobs),
                        'planned_requests': total, 'finished_requests': done,
                        'pending_requests': total-done, 'boundary_reviews_complete': False})
    rows = []
    for stone in inventory['stones']:
        stone_id = stone['stone_id']
        local = {a['id']: assets[a['id']] for a in stone['assets']}
        frames = reviewed_frames(local, [a for a in annotations if a['stone_id'] == stone_id])
        stone_plan = next(s for s in plan['stones'] if s['stone_id'] == stone_id)
        local_decisions = [d for d in decisions if d['review_key'].startswith(stone_id+'-')]
        local_commits = [d for d in commits if d['review_key'].startswith(stone_id+'-')]
        rows.append({'stone_id': stone_id, 'name': stone['name'],
                     'asset_ids': sorted(local), 'different_originals': len({a['sha256'] for a in local.values()}),
                     'review_plan_pairs': len(stone_plan['pairs']), 'reviewed_pairs': len(local_decisions),
                     'saved_pairs': len(local_commits),
                     'local_only_pairs': sum(d.get('local_only') is True for d in local_decisions),
                     'independent_same_face_frames': [sorted(f['to_reference']) for f in frames],
                     'native_versions_written': sum(v['stone_id'] == stone_id for v in versions),
                     'native_scene_versions_written': sum(v['stone_id'] == stone_id and v['level'] == 'scene' for v in versions),
                     'native_whole_versions_written': sum(v['stone_id'] == stone_id and v['level'] == 'whole' for v in versions),
                     'native_layer_versions_written': sum(v['stone_id'] == stone_id and v['level'] == 'layer' for v in versions),
                     'scope_complete': False})
    summary = {'generated_at': datetime.now(timezone.utc).isoformat(), 'scope_complete': False,
               'scope_stones': len(rows), 'review_plan_pairs': sum(r['review_plan_pairs'] for r in rows),
               'initial_review_plan_pairs': plan.get('initial_review_plan_pairs', sum(r['review_plan_pairs'] for r in rows)),
               'saved_new_pairs': len(commits), 'reviewed_pairs': len(decisions),
               'reused_baseline_pairs': len(alignment_manifest.get('reused_baseline', [])),
               'resolved_recompute_pairs': len(resolved), 'unresolved_recompute_pairs': len(unresolved),
               'local_only_pairs': sum(d.get('local_only') is True for d in decisions),
               'review_decision_counts': dict(Counter(d['decision'] for d in decisions)),
               'native_accepted_decisions': len(native_decisions['accepted']),
               'native_versions_written': len(versions), 'native_written_manifest': len(native_commits['versions']),
               'native_scene_versions_written': sum(v['level'] == 'scene' for v in versions),
               'native_whole_versions_written': sum(v['level'] == 'whole' for v in versions),
               'native_layer_versions_written': sum(v['level'] == 'layer' for v in versions),
               'native_single_versions_written': sum(v['level'] not in ('scene', 'whole', 'layer') for v in versions),
               'new_parent_nodes': len(native_commits['parents']),
               'new_parent_nodes_without_geometry': sum(by_id[id]['atype'] == 'none' for id in native_commits['parents'].values()),
               'native_artifact_checks': version_checks,
               'native_needs_refinement': len(native_decisions['needs_refinement']),
               'baseline_preservation': preserved, 'batches': batches, 'stones': rows}
    write(OUT/'progress-audit.json', summary)
    print(json.dumps({k: v for k, v in summary.items() if k != 'stones'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
