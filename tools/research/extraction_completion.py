"""Close a bounded extraction pass with complete source inventory and preservation audit."""
from __future__ import annotations

import contextlib
import io
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

from extraction_pilot import OUT, ROOT, stone_directory, write
from extraction_reviews import read
from multiversion_commit_alignments import preserve_baseline
from multiversion_publication import publication_fields

STONES = [f'武{i:03d}' for i in range(11, 54)]
LEVELS = {'scene', 'figure', 'component', 'band'}


def normalize_context_scopes():
    """Classify already reviewed contexts; never reinterpret a figure or change a mask."""
    changes = []
    for stone in STONES:
        d = stone_directory(stone)
        for path in d.glob('*-review.json'):
            v = read(path)
            if v.get('format') != 'wsc-object-review-1':
                continue
            changed = False
            for a in v['accepted']:
                if a.get('review_scope'):
                    continue
                # Canonical IDs and their levels are read from the database below.
                level = CANONICAL[a['canonical_annotation_id']]['level']
                if level not in {'scene', 'band'}:
                    continue
                a['review_scope'] = 'native_story_context' if level == 'scene' else 'whole_native_band_context'
                changes.append({'stone_id': stone, 'proposal': a['proposal'], 'review_scope': a['review_scope']})
                changed = True
            if changed:
                write(path, v)
    path = OUT/'context-scope-normalization.json'
    previous = read(path).get('changes', []) if path.exists() else []
    logged = {r['proposal']: r for r in [*previous, *changes]}
    write(path, {'changes': list(logged.values()), 'mask_or_research_fields_changed': False})


def face_membership(d, assets, canonical):
    state = read(d/'batch-state.json') if (d/'batch-state.json').exists() else {}
    faces = state.get('faces', [])
    if state.get('reference_asset_id'):
        faces = [{'reference_asset_id': state['reference_asset_id'], 'target_asset_ids': state['target_asset_ids']}]
    membership = defaultdict(set)
    for face in faces:
        ref = face['reference_asset_id']
        membership[ref].update([ref, *face['target_asset_ids'], *face.get('exact_sha_aliases', [])])
    loc = read(d/'source-localization.json') if (d/'source-localization.json').exists() else {}
    for key, value in loc.items():
        ref = value.get('master_asset_id')
        if ref in assets:
            membership[ref].update([ref, int(key.split(':')[0])])
    for ref, ids in list(membership.items()):
        shas = {assets[i]['sha256'] for i in ids}
        ids.update(a['id'] for a in assets.values() if a['sha256'] in shas)
    # Single-subject photographs have explicit observed subject coverage, not a whole-face locator.
    closeups = defaultdict(set)
    cp = d/'closeup-source-coverage.json'
    if cp.exists():
        for spec in read(cp)['specs']:
            closeups[spec['asset_id']].add(spec['canonical_annotation_id'])
    return membership, closeups


def inventory_stone(stone, excluded):
    d = stone_directory(stone)
    matrix = read(d/'version-matrix.json')
    # Keep the downloadable manifest's scope labels in step with the reviewed
    # matrix. This only describes existing artifacts; no masks are regenerated.
    manifest_path = d/'cutouts.json'
    manifest = read(manifest_path)
    scopes = {r['annotation_id']: r['review_scope'] for r in matrix['outputs']}
    changed = False
    for r in manifest['versions']:
        if r.get('review_scope') != scopes[r['annotation_id']]:
            r['review_scope'] = scopes[r['annotation_id']]
            changed = True
    if changed:
        write(manifest_path, manifest)
    assets = {a['id']: a for a in ASSETS.values() if a['stone_id'] == stone and not a['kind'].startswith('model')}
    existing = [a for a in CANONICAL.values() if a['stone_id'] == stone and a['level'] in LEVELS and a['atype'] != 'none']
    members, closeups = face_membership(d, assets, existing)
    pending = {(r['asset_id'], r['canonical_annotation_id']): r for r in matrix['tasks'] if r['state'] != 'usable'}
    available = {}
    for r in matrix['outputs']:
        key = (r['source_sha256'], r['canonical_annotation_id'])
        previous = available.get(key)
        if previous is None or r['annotation_id'] > previous['annotation_id']:
            available[key] = r
    na = {}
    exceptions = d/'source-applicability-exceptions.json'
    if exceptions.exists():
        for e in read(exceptions).get('not_applicable', []):
            for c in e['canonical_annotation_ids']:
                na[(e['asset_id'], c)] = e['reason']
    groups = defaultdict(list)
    for a in assets.values():
        groups[a['sha256']].append(a['id'])
    records = []
    for c in existing:
        face_sources = members.get(c['asset_id'], {c['asset_id']})
        for source_sha, aliases in groups.items():
            source = aliases[0]
            r = {'canonical_annotation_id': c['id'], 'label': c['label'], 'level': c['level'],
                 'canonical_asset_id': c['asset_id'], 'source_asset_ids': aliases, 'source_sha256': source_sha}
            output = available.get((source_sha, c['id']))
            failure = next((pending[(a, c['id'])] for a in aliases if (a, c['id']) in pending), None)
            if output:
                r.update(state='usable', applicability='confirmed_by_output', annotation_id=output['annotation_id'],
                         review_scope=output['review_scope'], reused_original=output['reused_original'],
                         png=output['png'], mask=output['mask'])
            elif any((a, c['id']) in na for a in aliases):
                r.update(state='not_applicable_missing_view', applicability='whole_source_observed',
                         reason=next(na[(a, c['id'])] for a in aliases if (a, c['id']) in na))
            elif c['id'] in excluded:
                ancestor = c
                seen = set()
                while ancestor and ancestor['id'] not in seen and ancestor['level'] != 'band':
                    seen.add(ancestor['id']); ancestor = CANONICAL.get(ancestor['parent_id'])
                band = available.get((source_sha, ancestor['id'])) if ancestor else None
                r.update(state='covered_by_whole_band' if band else 'individual_scope_excluded',
                         applicability='user_whole_band_policy', reason='垂帐纹、菱纹按整体纹带；不新增独立单元。')
                if band:
                    r['whole_band_annotation_id'] = band['annotation_id']
            elif failure:
                r.update(state='pending_native_correction', applicability='source_scope_task', reason=failure['reason'])
            elif any(a in face_sources for a in aliases) or any(c['id'] in closeups.get(a, set()) for a in aliases):
                r.update(state='pending_native_correction', applicability='recorded_face_or_closeup',
                         reason='尚无该对象范围独立通过的本源掩膜；保留待补。')
            elif members and c['asset_id'] in members and any(a in ids for a in aliases for ids in members.values()) and not any(a in closeups for a in aliases):
                r.update(state='not_applicable_other_face', applicability='explicit_face_map', reason='本源对应另一刻面。')
            elif any(a in closeups for a in aliases):
                r.update(state='not_applicable_closeup_scope', applicability='observed_single_subject_scope',
                         reason='本源为已核定单一帝王或组合的特写；目标不在已核定特写对象范围。')
            else:
                r.update(state='pending_source_identity', applicability='unconfirmed',
                         reason='原有锚点与其他来源尚无已核定对象对应；不能按相同名称合并。')
            records.append(r)
    counts = dict(Counter(r['state'] for r in records))
    value = {'format': 'wsc-complete-source-scope-inventory-1', 'stone_id': stone, 'pass_processed': True,
             'full_stone_complete': False, 'source_scope_anchor_count': len(existing),
             'count_note': '原标注锚点、局部及组合不是已去重的独立物理形象数；usable亦包含明确残刻。',
             'source_groups': [{'source_sha256': sha, 'asset_ids': ids} for sha, ids in groups.items()],
             'tasks': records, 'state_counts': counts, 'outputs': matrix['counts']}
    write(d/'full-applicability-matrix.json', value)
    return {'stone_id': stone, 'path': str((d/'full-applicability-matrix.json').relative_to(OUT)),
            'state_counts': counts, **matrix['counts']}


def audit():
    preserved = preserve_baseline()
    refs = defaultdict(set)
    concepts = defaultdict(set)
    with sqlite3.connect((ROOT/'data/stonelab.db').as_uri()+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        for r in db.execute('SELECT * FROM annotation_references'):
            refs[r['annotation_id']].add((r['kind'], r['segment_id'], r['figure_id']))
        for r in db.execute('SELECT * FROM annotation_concepts'):
            concepts[r['annotation_id']].add(r['concept_id'])
    issues, checked = [], 0
    finals = {r['annotation_id']: r for s in STONES for r in read(stone_directory(s)/'cutouts.json')['versions']}
    for v in read(OUT/'native-commits.json')['versions']:
        a = ANNOTATIONS[v['annotation_id']]
        if a['stone_id'] not in STONES:
            continue
        c = CANONICAL[v['canonical_annotation_id']]
        meta = a['geometry']['image_version']; mask = a['geometry'].get('native_mask', {})
        final = finals.get(a['id'])
        reasons = []
        if a['level'] != c['level'] or a['stone_id'] != c['stone_id']:
            reasons.append('canonical scope')
        if any(a[k] != val for k, val in publication_fields(c).items()):
            reasons.append('research fields')
        if meta['source_asset_id'] != a['asset_id'] or meta['source_sha256'] != ASSETS[a['asset_id']]['sha256']:
            reasons.append('source identity')
        if not refs[c['id']].difference({('description', None, None)}).issubset(refs[a['id']]):
            reasons.append('reference inheritance')
        if concepts[c['id']] != concepts[a['id']]:
            reasons.append('concept inheritance')
        parent = ANNOTATIONS.get(a['parent_id'])
        if a['parent_id'] is not None and (not parent or parent['asset_id'] != a['asset_id'] or parent['stone_id'] != a['stone_id']):
            reasons.append('parent source')
        if not final or not mask or not meta.get('native_boundary_reviewed'):
            reasons.append('native final')
        if final and any(not (OUT/final[k]).is_file() for k in ('png', 'mask')):
            reasons.append('missing artifact')
        if reasons:
            issues.append({'annotation_id': a['id'], 'issues': reasons})
        checked += 1
    value = {'format': 'wsc-extraction-preservation-audit-1', 'baseline': preserved,
             'native_versions_checked': checked, 'issues': issues,
             'native_frame_note': 'Publication and cache retirement verified source SHA, frame and native crop size. No repeated boundary patrol or new full-source copies.'}
    write(OUT/'completion-audit.json', value)
    return value


def main():
    global ASSETS, ANNOTATIONS, CANONICAL
    with sqlite3.connect((ROOT/'data/stonelab.db').as_uri()+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        ASSETS = {a['id']: dict(a) for a in db.execute('SELECT * FROM assets')}
        ANNOTATIONS = {a['id']: dict(a) for a in db.execute('SELECT * FROM annotations')}
    for a in ANNOTATIONS.values():
        a['geometry'] = json.loads(a['geometry'] or '{}')
    CANONICAL = {i: a for i, a in ANNOTATIONS.items() if not a['geometry'].get('image_version') and a['tool'] != 'align'}
    normalize_context_scopes()
    from extraction_checkpoints import checkpoint
    with contextlib.redirect_stdout(io.StringIO()):
        for s in STONES:
            checkpoint(s, note=read(stone_directory(s)/'version-matrix.json').get('note', ''))
    policy = read(ROOT/'resources/authoring/research/multiversion-20261002/native-scope-policy.json')
    stones = [inventory_stone(s, set(policy['do_not_stage_new_individual_mask_canonical_ids'])) for s in STONES]
    audit_value = audit()
    totals = {k: sum(s[k] for s in stones) for k in ('usable_outputs', 'reused_originals', 'new_native_versions')}
    scopes = Counter(); states = Counter()
    for s in stones:
        scopes.update(s['review_scopes']); states.update(s['state_counts'])
    retirement = [read(stone_directory(s)/'cache-retirement.json') for s in STONES]
    totals.update(review_scopes=dict(scopes), source_scope_states=dict(states),
                  retired_files=sum(r['removed_files'] for r in retirement), retired_bytes=sum(r['removed_bytes'] for r in retirement))
    summary = {'format': 'wsc-extraction-pass-completion-1', 'scope': '武011—武053', 'stones_processed': len(stones),
               'pass_processed': True, 'all_applicable_versions_complete': False, 'totals': totals, 'stones': stones,
               'audit_issues': len(audit_value['issues']), 'updated_at_china': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()}
    write(OUT/'completion-summary.json', summary)
    state = read(OUT/'TASK_STATE.json')
    state['status'] = 'rear43_pass_processed_with_pending'
    state['cursor'] = {'stone_id': STONES[-1], 'phase': 'pass_processed_with_pending'}
    state['object_extraction_processed_stone_ids'] = STONES
    state['all_applicable_sources_complete'] = False
    state['active_task'] = 'rear43_object_extraction_pass_closed'
    state['next_action'] = ('Use full-applicability-matrix.json for unresolved source masks and original-anchor '
                            'identity review. Accepted fragments remain fragments; do not repeat unchanged accepted checks.')
    state['object_extraction_completion'] = {'scope': summary['scope'], 'status': 'pass_processed_with_pending',
                                           'summary': 'completion-summary.json',
                                           'results': 'RESULTS-武011-武053.md',
                                           'display_audit': 'display-data-audit.json',
                                           'all_applicable_versions_complete': False}
    state['updated_at_china'] = summary['updated_at_china']; write(OUT/'TASK_STATE.json', state)
    print(json.dumps({'totals': totals, 'audit_issues': summary['audit_issues']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
