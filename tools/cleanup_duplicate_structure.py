"""Merge structure nodes that the multi-version batch copied onto the very image they came from.

The 2026-10-02…04 multi-version runs gave every extra photo / rubbing its own copy of the
layer → scene skeleton (note: "…的结构节点；对应原图标注N。"). Copies on *other* images are
intended and stay. Copies on the *same* image as their original N are true duplicates: no
geometry, same label and level, citations and concepts already on the original.

For each duplicate D of original O (same image):
  * children of D that are not duplicates themselves move under O (the same structural
    place on the same image);
  * D is deleted together with its citation and concept rows (all already present on O).
Every safety condition is re-checked against the current database before anything changes.

    python tools/cleanup_duplicate_structure.py            # dry run: plan + report only
    python tools/cleanup_duplicate_structure.py --apply    # stop the platform first

--apply makes a verified backup in data/backups/duplicate-structure-cleanup-<time>/ first.
To roll back: stop the platform and copy that stonelab.db over data/stonelab.db.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.workspace_lock import workspace_lock  # noqa: E402

COPY_NOTE = re.compile(r'的结构节点；对应原图标注(\d+)。')
REF_IGNORED = {'id', 'annotation_id', 'created_at'}


def plan(db: sqlite3.Connection) -> dict:
    db.row_factory = sqlite3.Row
    rows = {r['id']: r for r in db.execute('select * from annotations')}
    duplicates: dict[int, int] = {}
    for annotation_id, row in rows.items():
        match = COPY_NOTE.search(row['note'] or '')
        if not match:
            continue
        original = rows.get(int(match.group(1)))
        if original is not None and original['asset_id'] == row['asset_id'] and original['stone_id'] == row['stone_id']:
            duplicates[annotation_id] = original['id']

    problems: list[str] = []

    def resolve(node: int) -> int:
        seen = set()
        while node in duplicates:
            if node in seen:
                raise RuntimeError(f'duplicate chain loops at {node}')
            seen.add(node)
            node = duplicates[node]
        return node

    ref_cols = [c[1] for c in db.execute('pragma table_info(annotation_references)')]
    refs: dict[int, set] = defaultdict(set)
    for r in db.execute('select * from annotation_references'):
        refs[r['annotation_id']].add(tuple(r[c] for c in ref_cols if c not in REF_IGNORED))
    concepts: dict[int, set] = defaultdict(set)
    for annotation_id, concept_id in db.execute('select annotation_id, concept_id from annotation_concepts'):
        concepts[annotation_id].add(concept_id)
    knowledge = {table: db.execute(f'select count(*) from {table} where annotation_id in ({",".join(map(str, duplicates)) or "NULL"})').fetchone()[0]
                 for table in ('knowledge_graph_bindings', 'annotation_knowledge_links')}
    for table, count in knowledge.items():
        if count:
            problems.append(f'{table}: {count} rows point at duplicates')

    children: dict[int, list[int]] = defaultdict(list)
    for annotation_id, row in rows.items():
        if row['parent_id'] is not None:
            children[row['parent_id']].append(annotation_id)

    items = []
    moves: list[tuple[int, int, int]] = []  # child, old parent, new parent
    for dup_id, original_id in sorted(duplicates.items()):
        dup, original = rows[dup_id], rows[original_id]
        geometry = json.loads(dup['geometry'] or 'null')
        if dup['atype'] != 'none' or geometry:
            problems.append(f'{dup_id}: has its own geometry')
        if dup['label'] != original['label'] or dup['level'] != original['level']:
            problems.append(f'{dup_id}: label/level differ from original {original_id}')
        if refs[dup_id] - refs[original_id]:
            problems.append(f'{dup_id}: {len(refs[dup_id] - refs[original_id])} citations not on original {original_id}')
        if concepts[dup_id] - concepts[original_id]:
            problems.append(f'{dup_id}: concepts not on original {original_id}')
        target = resolve(original_id)
        for child in children[dup_id]:
            if child not in duplicates:
                moves.append((child, dup_id, target))
        items.append({'duplicate': dup_id, 'original': original_id, 'stone': dup['stone_id'], 'asset': dup['asset_id'],
                      'level': dup['level'], 'label': dup['label'], 'citations': len(refs[dup_id]),
                      'concepts': len(concepts[dup_id]), 'children_moved': [c for c, d, _ in moves if d == dup_id]})
    return {
        'duplicates': items, 'moves': [{'child': c, 'from': f, 'to': t} for c, f, t in moves],
        'stones': sorted({i['stone'] for i in items}),
        'citation_rows': sum(i['citations'] for i in items), 'concept_rows': sum(i['concepts'] for i in items),
        'problems': problems,
    }


def counts(db: sqlite3.Connection) -> dict:
    return {t: db.execute(f'select count(*) from {t}').fetchone()[0]
            for t in ('annotations', 'annotation_references', 'annotation_concepts')}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--apply', action='store_true', help='back up, then merge and delete the duplicates')
    parser.add_argument('--expect', type=int, help='refuse to apply unless exactly this many duplicates are found')
    parser.add_argument('--data', type=Path, default=ROOT / 'data', help=argparse.SUPPRESS)
    args = parser.parse_args()
    data = args.data.resolve()
    database = data / 'stonelab.db'
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    report_dir = data / 'reports' / f'duplicate-structure-cleanup-{stamp}'

    if not args.apply:
        with closing(sqlite3.connect(f'file:{database}?mode=ro', uri=True)) as db:
            result = plan(db)
        report_dir.mkdir(parents=True, exist_ok=True)
        (report_dir / 'plan.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f"dry run: {len(result['duplicates'])} duplicates on {len(result['stones'])} stones, "
              f"{len(result['moves'])} children to move, problems: {len(result['problems'])}")
        for problem in result['problems'][:20]:
            print('  !', problem)
        print(f'plan written to {report_dir / "plan.json"}')
        return 1 if result['problems'] else 0

    with workspace_lock(data):
        backup_dir = data / 'backups' / f'duplicate-structure-cleanup-{stamp}'
        backup_dir.mkdir(parents=True, exist_ok=False)
        backup = backup_dir / 'stonelab.db'
        with closing(sqlite3.connect(database)) as db:
            result = plan(db)
            if result['problems']:
                print('refusing to apply; problems found:', *result['problems'][:20], sep='\n  ')
                return 2
            if args.expect is not None and len(result['duplicates']) != args.expect:
                print(f"refusing to apply: found {len(result['duplicates'])} duplicates, expected {args.expect}")
                return 2
            before = counts(db)
            fk_before = len(db.execute('pragma foreign_key_check').fetchall())
            # 1. verified backup
            with closing(sqlite3.connect(backup)) as copy:
                db.backup(copy)
                if copy.execute('pragma integrity_check').fetchone()[0] != 'ok' or counts(copy) != before:
                    print('backup verification failed; nothing changed')
                    return 3
            # 2. merge in one transaction
            db.row_factory = None
            db.execute('pragma foreign_keys=ON')
            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')
            ids = [i['duplicate'] for i in result['duplicates']]
            marks = ','.join('?' * len(ids))
            with db:
                moved = 0
                for move in result['moves']:
                    moved += db.execute('update annotations set parent_id=?, updated_at=? where id=? and parent_id=?',
                                        (move['to'], now, move['child'], move['from'])).rowcount
                if moved != len(result['moves']):
                    raise RuntimeError(f"moved {moved} of {len(result['moves'])} children; rolled back")
                db.execute(f'delete from annotation_references where annotation_id in ({marks})', ids)
                db.execute(f'delete from annotation_concepts where annotation_id in ({marks})', ids)
                db.execute(f'delete from annotations where id in ({marks})', ids)
                left = db.execute(f'select count(*) from annotations where parent_id in ({marks})', ids).fetchone()[0]
                if left:
                    raise RuntimeError(f'{left} annotations still point at removed nodes; rolled back')
            after = counts(db)
            checks = {'integrity': db.execute('pragma integrity_check').fetchone()[0],
                      'foreign_key_violations_before': fk_before,
                      'foreign_key_violations_after': len(db.execute('pragma foreign_key_check').fetchall())}
        result.update(before=before, after=after, checks=checks, backup=str(backup), applied_at=now)
        report_dir.mkdir(parents=True, exist_ok=True)
        (report_dir / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f"applied: removed {before['annotations'] - after['annotations']} duplicate nodes on {len(result['stones'])} stones, "
              f"moved {len(result['moves'])} children to their originals; "
              f"citation rows {before['annotation_references']}→{after['annotation_references']}, "
              f"concept rows {before['annotation_concepts']}→{after['annotation_concepts']}")
        print(f"checks: integrity {checks['integrity']}, foreign key violations {checks['foreign_key_violations_before']}→{checks['foreign_key_violations_after']}")
        print(f'backup: {backup}')
        print(f'report: {report_dir / "report.json"}')
        return 0 if checks['integrity'] == 'ok' and checks['foreign_key_violations_after'] <= fk_before else 4


if __name__ == '__main__':
    raise SystemExit(main())
