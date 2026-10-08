"""Update finite per-stone task matrices without altering source catalogue evidence."""
from __future__ import annotations

import argparse
from collections import Counter
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from multiversion_context import OUT
from multiversion_sam import write


STATES = {'identity_pending', 'applicable_full', 'applicable_partial', 'candidate',
          'needs_correction', 'boundary_passed', 'published_and_ui_verified',
          'needs_new_evidence', 'not_visible_in_source', 'other_face', 'same_capture_duplicate'}


def initialize(stone):
    directory = OUT / 'stones' / stone
    path = directory / 'version-matrix.json'
    if not path.exists():
        catalogue = json.loads((directory / 'catalog-review/catalog.json').read_text(encoding='utf-8'))
        seed = json.loads((directory / 'catalog-review/matrix.json').read_text(encoding='utf-8'))
        records = []
        for row in seed:
            coverage = row['coverage_status']
            state = {'full_present': 'applicable_full', 'partial_present': 'applicable_partial',
                     'different_face': 'other_face', 'identity_pending': 'identity_pending'}[coverage]
            records.append({**row, 'state': state, 'publication_id': None, 'review_evidence': [], 'history': []})
        write(path, {'format': 'wsc-rear46-version-matrix-1', 'stone_id': stone,
                     'catalogue_evidence': 'catalog-review/catalog.json', 'entities': catalogue['entities'],
                     'source_groups': catalogue['source_groups'], 'original_subranges': catalogue['original_subranges'],
                     'records': records})
    return path, json.loads(path.read_text(encoding='utf-8'))


def update(stone, change_path=None):
    path, matrix = initialize(stone)
    now = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()
    if change_path:
        changes = json.loads(change_path.read_text(encoding='utf-8'))
        by_key = {row['task_key']: row for row in matrix['records']}
        assert len(by_key) == len(matrix['records'])
        for change in changes:
            row = by_key[change['task_key']]
            assert change['state'] in STATES
            if row['state'] == 'published_and_ui_verified' and change['state'] != row['state']:
                assert change.get('material_defect'), 'Passed tasks need a material defect before reopening'
            if change['state'] in ('boundary_passed', 'published_and_ui_verified'):
                assert row['applicable'] is True and change.get('review_evidence')
            if change['state'] == 'published_and_ui_verified':
                assert change.get('publication_id') and change.get('ui_evidence')
            row['history'].append({'at_china': now, 'before': row['state'], **change})
            row.update(change)
    counts = Counter(row['state'] for row in matrix['records'])
    applicable = [row for row in matrix['records'] if row['applicable'] is True]
    matrix['counts'] = {'catalogue_entities': len(matrix['entities']), 'known_applicable_tasks': len(applicable),
                        'identity_pending_tasks': sum(row['applicable'] is None for row in matrix['records']),
                        'states': dict(counts),
                        'passed_by_kind': dict(Counter(row['entity_kind'] for row in applicable if row['state']=='published_and_ui_verified'))}
    matrix['updated_at_china'] = now
    write(path, matrix)
    task_path = OUT / 'TASK_STATE.json'
    task = json.loads(task_path.read_text(encoding='utf-8'))
    task.setdefault('stone_checkpoints', {})[stone] = {'matrix': str(path.relative_to(OUT)), **matrix['counts']}
    matrices = [json.loads(p.read_text(encoding='utf-8')) for p in (OUT/'stones').glob('*/version-matrix.json')]
    rows = [row for m in matrices for row in m['records']]
    task['new_verified_version_keys'] = [row['task_key'] for row in rows if row['state']=='published_and_ui_verified' and not row.get('historic_reuse')]
    task['reused_verified_version_keys'] = [row['task_key'] for row in rows if row['state']=='published_and_ui_verified' and row.get('historic_reuse')]
    task['unresolved_version_keys'] = [row['task_key'] for row in rows if row['state'] in ('identity_pending','needs_new_evidence')]
    task['updated_at_china'] = now
    # An unresolved task always prevents a full-stone completion claim.
    complete = applicable and all(row['state']=='published_and_ui_verified' for row in applicable) and not any(row['applicable'] is None for row in matrix['records'])
    if complete and stone not in task['completed_stone_ids']:
        task['completed_stone_ids'].append(stone)
    write(task_path, task)
    print(json.dumps(matrix['counts'], ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stone')
    parser.add_argument('--changes', type=__import__('pathlib').Path)
    options = parser.parse_args()
    update(options.stone, options.changes)
