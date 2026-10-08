"""Finite rear-hall task checkpoints; never infer completion from candidate counts.

Initialization reads the live database through SQLite's backup API. Original IDs
come from the historical immutable baseline, not from an ID threshold.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
PLAN = ROOT / 'resources/authoring/research/rear46-plan-20261003'
TASK = ROOT / 'resources/authoring/research/rear46-execution-20261003'
OLD = ROOT / 'resources/authoring/research/multiversion-20261002'
CHINA = timezone(timedelta(hours=8))
TABLES = ('stones', 'assets', 'annotations', 'annotation_references', 'annotation_concepts')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def original_preservation(db, baseline):
    issues = []
    for table in ('annotations', 'annotation_references', 'annotation_concepts', 'stones'):
        actual = [dict(row) for row in db.execute(f'SELECT * FROM {table}')]
        if table == 'annotation_concepts':
            present = {json.dumps(row, sort_keys=True, ensure_ascii=False) for row in actual}
            issues.extend({'table': table, 'row': row} for row in baseline[table]
                          if json.dumps(row, sort_keys=True, ensure_ascii=False) not in present)
        else:
            present = {row['id']: row for row in actual}
            issues.extend({'table': table, 'id': row['id']} for row in baseline[table]
                          if present.get(row['id']) != row)
    return {'checked_at_china': datetime.now(CHINA).isoformat(), 'issues': issues,
            'protected_counts': {table: len(baseline[table]) for table in
                                 ('annotations', 'annotation_references', 'annotation_concepts', 'stones')}}


def initialize():
    state_path = TASK / 'TASK_STATE.json'
    if state_path.exists():
        state = read(state_path)
        if state.get('scope_stones') != read(PLAN / 'scope-and-seed-index.json')['scope']['rear']:
            raise RuntimeError('Existing checkpoint scope differs; inspect before resuming')
        return state
    index = read(PLAN / 'scope-and-seed-index.json')
    baseline = read(OLD / 'baseline.json')
    manifest = read(OLD / 'native-commits.json')
    for filename, expected in index['inputs'].items():
        if sha(OLD / filename) != expected:
            raise RuntimeError(f'Planning input changed: {filename}')
    backup_path = ROOT / 'data/backups/rear46-execution-20261003/stonelab-before.db'
    if backup_path.exists():
        raise RuntimeError('Backup without state exists; recover its snapshot explicitly')
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    database = ROOT / 'data/stonelab.db'
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(backup_path) as backup:
            source.backup(backup)
            if backup.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('SQLite backup integrity failed')
    with sqlite3.connect(backup_path) as db:
        db.row_factory = sqlite3.Row
        snapshot = {table: [dict(row) for row in db.execute(f'SELECT * FROM {table}')] for table in TABLES}
        preservation = original_preservation(db, baseline)
        if preservation['issues']:
            raise RuntimeError('Original research baseline differs; inspect saved backup')
        snapshot['schema'] = [dict(row) for row in db.execute('SELECT * FROM sqlite_master')]
        snapshot['all_table_counts'] = {row['name']: db.execute('SELECT COUNT(*) FROM "' + row['name'].replace('"', '""') + '"').fetchone()[0]
                                        for row in snapshot['schema'] if row['type'] == 'table'}
    original_ids = sorted(row['id'] for row in baseline['annotations'])
    old_versions = sorted(row['annotation_id'] for row in manifest['versions'])
    old_parents = sorted(set(manifest['parents'].values()))
    current = {row['id']: row for row in snapshot['annotations']}
    classification = {'original_annotation_ids': original_ids,
                      'old_imported_version_ids': old_versions,
                      'old_added_parent_ids': old_parents,
                      'old_empty_parent_ids': [key for key in old_parents if current[key]['atype'] == 'none'],
                      'other_annotation_ids': sorted(set(current) - set(original_ids) - set(old_versions) - set(old_parents)),
                      'protection_rule': 'Exact historical baseline rows and IDs; never ID magnitude.'}
    write(TASK / 'preflight/start-snapshot.json', snapshot)
    write(TASK / 'preflight/id-classification.json', classification)
    write(TASK / 'preflight/original-preservation-start.json', preservation)
    write(TASK / 'preflight/input-fingerprints.json', {
        'plan_inputs': {path.name: sha(path) for path in PLAN.iterdir() if path.is_file()},
        'historical_inputs': index['inputs'], 'sqlite_backup': str(backup_path),
        'sqlite_backup_sha256': sha(backup_path), 'live_snapshot_tables': {key: len(snapshot[key]) for key in TABLES}})
    state = read(PLAN / 'TASK_STATE.template.json')
    state.update(status='executing', execution_started=True,
                 started_at_china=datetime.now(CHINA).isoformat(),
                 snapshot_path='preflight/start-snapshot.json', backup_path=str(backup_path))
    state['cursor']['phase'] = 'preflight_and_full_source_census'
    state['next_action'] = 'Complete rear-only metadata preparation and Wu008 source/entity census; reuse existing candidates.'
    state['notes'] = [note for note in state['notes'] if 'template' not in note]
    state['notes'].append('One GPU worker and one serial publisher; unresolved tasks remain incomplete.')
    write(state_path, state)
    return state


def verify():
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        result = original_preservation(db, read(OLD / 'baseline.json'))
    write(TASK / 'preflight/original-preservation-latest.json', result)
    if result['issues']:
        raise RuntimeError(f'Original rows changed: {result["issues"][:10]}')
    return result


def prepare_context():
    """Reuse historical source/parent evidence while keeping new results separate."""
    state = initialize()
    scope = set(state['scope_stones'])
    old_inventory = read(OLD / 'inventory.json')
    inventory = {**old_inventory, 'format': 'wsc-rear46-execution-inventory-1',
                 'scope_rules': {'rear': 'Fixed Wu008-Wu053; original seeds are not accepted entities'},
                 'layouts': {'rear': state['scope_stones']},
                 'stones': [stone for stone in old_inventory['stones'] if stone['stone_id'] in scope],
                 'historical_inventory': str(OLD / 'inventory.json')}
    if {stone['stone_id'] for stone in inventory['stones']} != scope:
        raise RuntimeError('Historical source inventory does not cover the fixed46 scope')
    inventory_path = TASK / 'inventory.json'
    if not inventory_path.exists():
        write(inventory_path, inventory)
    old_manifest = read(OLD / 'native-commits.json')
    snapshot = read(TASK / 'preflight/start-snapshot.json')
    by_id = {row['id']: row for row in snapshot['annotations']}
    inherited = {key: value for key, value in old_manifest['parents'].items() if by_id[value]['stone_id'] in scope}
    manifest_path = TASK / 'native-commits.json'
    if not manifest_path.exists():
        write(manifest_path, {'run': TASK.name, 'parents': inherited, 'versions': [],
                             'inherited_parent_ids': sorted(set(inherited.values())),
                             'inherited_parent_source': str(OLD / 'native-commits.json'),
                             'note': 'Reused structure IDs only; historical109 versions are audited separately, never reimported.'})
    state['metadata_preparation_completed'] = (TASK / 'preflight/metadata-audit/metadata-patches-applied.json').exists()
    state['cursor']['phase'] = 'wu008_full_census_and_native_boundaries'
    state['next_action'] = 'Validate Wu008 subjects and each applicable source; review original-pixel masks and independently check corrected boundaries.'
    state['updated_at_china'] = datetime.now(CHINA).isoformat()
    write(TASK / 'TASK_STATE.json', state)
    return {'scope_stones': len(scope), 'inherited_parent_ids': len(set(inherited.values())),
            'metadata_preparation_completed': state['metadata_preparation_completed']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('init', 'verify', 'prepare-context'))
    options = parser.parse_args()
    result = {'init': initialize, 'verify': verify, 'prepare-context': prepare_context}[options.action]()
    print(json.dumps(result, ensure_ascii=False, indent=2))
