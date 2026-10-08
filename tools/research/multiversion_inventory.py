"""Snapshot and inventory the requested multiversion research scope without changing data."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from multiversion_context import ROOT, OUT, BASELINE, RUN


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def snapshot() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    baseline_path = BASELINE
    if baseline_path.is_file():
        return json.loads(baseline_path.read_text(encoding='utf-8'))
    database = ROOT / 'data/stonelab.db'
    backup_path = ROOT / 'data/backups' / RUN / 'stonelab-before.db'
    if backup_path.exists():
        raise RuntimeError('Backup already exists without baseline; inspect before proceeding')
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(backup_path) as backup:
            source.backup(backup)
            assert backup.execute('pragma quick_check').fetchone()[0] == 'ok'
    with sqlite3.connect(backup_path) as db:
        db.row_factory = sqlite3.Row
        tables = ['stones', 'assets', 'annotations', 'annotation_references', 'annotation_concepts']
        baseline = {table: [dict(row) for row in db.execute(f'SELECT * FROM {table}')] for table in tables}
    baseline['backup'] = str(backup_path)
    baseline['backup_sha256'] = hashlib.file_digest(backup_path.open('rb'), 'sha256').hexdigest()
    write(baseline_path, baseline)
    return baseline


def batch_label(asset: dict) -> str:
    filename = asset['filename']
    explicit = re.search(r'[（(]((?:19|20)\d{2}年[^）)]*)[）)]', filename)
    if explicit:
        return explicit.group(1)
    year = re.search(r'((?:19|20)\d{2})年', filename)
    if year:
        return year.group(1) + '年 · ' + ('拓片' if asset['kind'] == 'rubbing' else '照片')
    return '来源批次未注明 · ' + filename


def inventory(stone_ids=None) -> dict:
    baseline = snapshot()
    # Inventory uses the live database while the immutable backup anchors later preservation checks.
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        stones = [dict(row) for row in db.execute('SELECT * FROM stones ORDER BY id')]
        assets = [dict(row) for row in db.execute("SELECT * FROM assets WHERE kind NOT LIKE 'model%' ORDER BY stone_id,id")]
        annotations = [dict(row) for row in db.execute('SELECT * FROM annotations')]
    layouts = {name: json.loads((ROOT / f'data/layouts/{name}.json').read_text(encoding='utf-8'))
               for name in ('rear', 'xcl')}
    groups = {name: sorted({item['id'] for item in layout['stones']}) for name, layout in layouts.items()}
    requested = set(stone_ids) if stone_ids else None
    if requested is not None:
        groups = {name: sorted(set(values) & requested) for name, values in groups.items()}
    required = set(groups['rear'] + groups['xcl'])
    if requested is not None:
        required |= requested
    rows = []
    for stone in stones:
        if requested is not None and stone['id'] not in requested:
            continue
        local = [dict(asset) for asset in assets if asset['stone_id'] == stone['id']]
        if not local:
            continue
        for asset in local:
            asset['extra'] = json.loads(asset['extra'] or '{}')
            asset['version_label'] = batch_label(asset)
            local_annos = [a for a in annotations if a['asset_id'] == asset['id'] and a['tool'] != 'align']
            asset['research_annotations'] = len(local_annos)
            asset['saved_segment_polygons'] = sum(a['tool'] == 'segment' and a['atype'] == 'polygon' for a in local_annos)
        distinct = len({a['sha256'] or f"id:{a['id']}" for a in local if not a['missing']})
        explicit_batches = {a['version_label'] for a in local if not a['version_label'].startswith('来源批次未注明')}
        additional = requested is None and stone['id'] not in required and (len(explicit_batches) >= 3 or distinct >= 8)
        if stone['id'] not in required and not additional:
            continue
        rows.append({
            'stone_id': stone['id'], 'name': stone['name'],
            'scope': ('rear' if stone['id'] in groups['rear'] else 'xcl' if stone['id'] in groups['xcl'] else 'many-versions'),
            'assets': local, 'distinct_originals': distinct,
            'explicit_batches': sorted(explicit_batches),
            'master_asset_ids': [a['id'] for a in local if a['extra'].get('is_master')],
            'aligned_asset_ids': [a['id'] for a in local if a['extra'].get('align_to_master')],
        })
    result = {'format': 'wsc-multiversion-inventory-1', 'created_date': '2026-10-02',
              'requirements': ['align', 'segment-other-versions', 'associate', 'update-readme'],
              'scope_rules': ({'explicit_stones': sorted(requested)} if requested is not None else
                              {'rear': 'current rear layout stones', 'xcl': 'current west corridor layout stones',
                               'additional': 'at least three explicit batches or eight distinct originals'}),
              'layouts': groups, 'missing_catalogue_stones': sorted(required - {r['stone_id'] for r in rows}),
              'baseline_annotation_count': len(baseline['annotations']), 'stones': rows}
    write(OUT / 'inventory.json', result)
    print(json.dumps({
        'rear': len(groups['rear']), 'xcl': len(groups['xcl']), 'required_unique': len(required),
        'additional': len([r for r in rows if r['scope'] == 'many-versions']), 'total_scope': len(rows),
        'images': sum(len(r['assets']) for r in rows), 'distinct_originals': sum(r['distinct_originals'] for r in rows),
        'existing_master_stones': sum(bool(r['master_asset_ids']) for r in rows),
        'existing_chains': sum(len(r['aligned_asset_ids']) for r in rows),
        'missing_catalogue_stones': result['missing_catalogue_stones'],
        'backup': baseline['backup'], 'inventory': str(OUT / 'inventory.json'),
    }, ensure_ascii=False, indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stones', nargs='+')
    options = parser.parse_args()
    inventory(options.stones)
