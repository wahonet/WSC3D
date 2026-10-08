"""Import only explicitly accepted visual decisions, without changing existing annotations."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sqlite3
import sys

import numpy as np
from multiversion_align import ROOT, OUT, write

sys.path.insert(0, str(ROOT / 'src/backend'))
sys.path.insert(0, str(ROOT / 'tmp/wsc-check-backup'))
from app.services import transforms as tf
from api import call, q
from multiversion_frames import reviewed_pair
from multiversion_context import RUN, BASELINE


def preserve_baseline():
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
    issues = []
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri()+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        for table in ['annotations', 'annotation_references', 'annotation_concepts', 'stones']:
            key = 'id' if table != 'annotation_concepts' else None
            actual = [dict(row) for row in db.execute(f'SELECT * FROM {table}')]
            if key:
                indexed = {row[key]: row for row in actual}
                issues.extend(f'{table}:{row[key]}' for row in baseline[table] if indexed.get(row[key]) != row)
            else:
                available = {json.dumps(row, sort_keys=True, ensure_ascii=False) for row in actual}
                issues.extend('annotation_concepts:'+str(row) for row in baseline[table]
                              if json.dumps(row, sort_keys=True, ensure_ascii=False) not in available)
    if issues:
        raise RuntimeError(f'Existing research baseline changed: {issues[:10]}')
    return {'issues': [], 'preserved_annotations': len(baseline['annotations']),
            'preserved_references': len(baseline['annotation_references'])}


def main():
    preserve_baseline()
    inventory = json.loads((OUT / 'inventory.json').read_text(encoding='utf-8'))
    plan = json.loads((OUT / 'alignment-review-plan.json').read_text(encoding='utf-8'))
    decisions = json.loads((OUT / 'alignment-decisions.json').read_text(encoding='utf-8'))['decisions']
    proposals = {p['review_key']: p for stone in plan['stones'] for p in stone['pairs']}
    log_path = OUT / 'alignment-commits.json'
    log = json.loads(log_path.read_text(encoding='utf-8')) if log_path.exists() else {'run': RUN, 'records': []}
    for stone_id in sorted({d['review_key'].split('-')[0] for d in decisions if d['decision'] == 'accepted'}):
        stone = next(s for s in inventory['stones'] if s['stone_id'] == stone_id)
        assets = {a['id']: a for a in stone['assets']}
        local = [d for d in decisions if d['decision'] == 'accepted' and d['review_key'].startswith(stone_id+'-')]
        nodes = {proposals[d['review_key']][k] for d in local for k in ('left_asset_id', 'right_asset_id')}
        live = next(s for s in call('GET', '/stones') if s['id'] == stone_id)
        current = {a['id']: a for g in live['groups'] for a in g['assets']}
        master = next((a for a in current.values() if a['is_master']), None)
        if master is None:
            chosen = max((assets[a] for a in nodes), key=lambda a: (a['saved_segment_polygons'], a['research_annotations'], a['width']*a['height']))
            result = call('POST', f'/stones/{q(stone_id)}/master/{chosen["id"]}')
            if not result['ok']:
                raise RuntimeError(result)
            live = next(s for s in call('GET', '/stones') if s['id'] == stone_id)
            current = {a['id']: a for g in live['groups'] for a in g['assets']}
        connected = {a['id'] for a in current.values() if a['in_frame']}
        existing = call('GET', '/stones/'+q(stone_id)+'/annotations')
        remaining = list(local)
        while remaining:
            decision = next((d for d in remaining if {proposals[d['review_key']]['left_asset_id'], proposals[d['review_key']]['right_asset_id']} & connected), remaining[0])
            remaining.remove(decision)
            p = proposals[decision['review_key']]
            if decision.get('baseline_annotation_id') is not None:
                baseline_id = int(decision['baseline_annotation_id'])
                baseline_record = next(a for a in existing if a['id'] == baseline_id)
                pair = reviewed_pair(baseline_record, assets)
                if pair is None or pair[:2] != (p['left_asset_id'], p['right_asset_id']):
                    raise ValueError('Reused baseline pair does not match the reviewed source identities')
                if p['status'] != 'identity-awaiting-review' or not np.allclose(tf.matrix(pair[2]), np.eye(3)):
                    raise ValueError('Baseline reuse requires the already verified identical-source mapping')
                reused = log.setdefault('reused_baseline', [])
                if not any(r['review_key'] == p['review_key'] for r in reused):
                    reused.append({'review_key': p['review_key'], 'annotation_id': baseline_id})
                    write(log_path, log)
                continue
            previous = next((a for a in existing if a['tool'] == 'align' and a['geometry'].get('research_run') == RUN and a['geometry'].get('review_key') == p['review_key']), None)
            if previous:
                # A saved pair may be local-only or disconnected from the master.
                # Its existence alone never proves that either source entered a chain.
                # `connected` was read from live assets once at this stone's start;
                # skipped records cannot mutate it. New successful commits update it below.
                continue
            left, right = assets[p['left_asset_id']], assets[p['right_asset_id']]
            with sqlite3.connect(ROOT / 'data/stonelab.db') as db:
                for source in (left, right):
                    sha = db.execute('SELECT sha256 FROM assets WHERE id=?', (source['id'],)).fetchone()[0]
                    assert sha == source['sha256'], 'Original image fingerprint changed'
            if p['status'] == 'identity-awaiting-review':
                transform, rmse = tf.identity(), 0.
            elif decision['model'] == 'homography':
                transform = tf.homography(p['homography'])
                rmse = p['projective_holdout_rmse_px']
            else:
                m = np.asarray(p['sim_matrix'])
                transform = {'s': float(np.hypot(m[0, 0], m[1, 0])), 'theta_deg': float(np.degrees(np.arctan2(m[1, 0], m[0, 0]))),
                             'tx': float(m[0, 2]), 'ty': float(m[1, 2])}
                rmse = p['rmse_original_px']
            geometry = {**transform, 'target_asset_id': right['id'], 'pairs': p.get('pairs') or [],
                'rmse_px': rmse, 'wl': left['width'], 'hl': left['height'], 'wr': right['width'], 'hr': right['height'],
                'research_run': RUN, 'review_key': p['review_key'], 'source_sha256': [left['sha256'], right['sha256']],
                'visual_review': decision, 'holdout_count': p.get('holdout_count', 0),
                'projective_holdout_p95_fraction': p.get('projective_holdout_p95_fraction'),
                'registration_method': p.get('method'),
                'face_regions': p.get('face_regions'),
                'face_match_params': p.get('face_match_params'),
                'roi_source_spec': p.get('roi_source_spec'),
                'local_only': decision.get('local_only') is True,
                'localization_only_for_segmentation': True}
            result = call('POST', '/align/commit', {'stone_id': stone_id, 'left_asset_id': left['id'], 'right_asset_id': right['id'], 'geometry': geometry})
            record = result['annotation']
            call('PATCH', '/annotations/'+str(record['id']), {'note': '多版本配准；已检查同件同面与叠加。\n'+decision['visual_note']+'\n证据：'+decision['evidence']})
            log['records'].append({'review_key': p['review_key'], 'annotation_id': record['id'], 'model': decision['model'],
                                   'warning': result['warning'], 'chain_updates': result['chain_updates']})
            write(log_path, log)
            if not result['warning']:
                connected.update([left['id'], right['id']])
            print(p['review_key'], 'saved', record['id'], decision['model'], flush=True)
    log['baseline_preservation'] = preserve_baseline()
    write(log_path, log)


if __name__ == '__main__':
    # Argument parsing must finish before any accepted-decision import.
    argparse.ArgumentParser(description=__doc__).parse_args()
    main()
