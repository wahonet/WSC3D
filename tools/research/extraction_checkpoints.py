"""Small, evidence-based checkpoints for the sequential object extraction pass."""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

from extraction_pilot import OUT, ROOT, stone_directory, rows, write
from extraction_reviews import read


def checkpoint(stone, applicable=None, note=''):
    directory = stone_directory(stone)
    assets, annotations = rows(stone)
    by_id = {a['id']: a for a in annotations}
    finals = read(directory/'cutouts.json')['versions']
    commits = read(OUT/'native-commits.json')['versions']
    imported = {v['annotation_id']: v for v in commits}
    decisions, rejected = {}, {}
    for path in directory.glob('*-review.json'):
        review = read(path)
        if review.get('format') != 'wsc-object-review-1':
            continue
        for decision in review['accepted']:
            decisions[decision['proposal']] = decision
        for decision in review['pending']:
            rejected[(decision['asset_id'], decision['canonical_annotation_id'])] = decision
    source_groups = {}
    for asset in assets.values():
        group = source_groups.setdefault(asset['sha256'], {'source_sha256': asset['sha256'], 'asset_ids': [], 'filenames': []})
        group['asset_ids'].append(asset['id']); group['filenames'].append(asset['filename'])
    available, output_rows = {}, []
    for final in finals:
        annotation = by_id[final['annotation_id']]
        committed = imported.get(annotation['id'])
        decision = decisions.get(committed['proposal'], {}) if committed else {}
        canonical = committed['canonical_annotation_id'] if committed else annotation['id']
        scope = decision.get('review_scope', 'existing_original_scope' if not committed else 'object_reviewed_scope')
        for key in ('png', 'mask'):
            path = final.get(key)
            if path and not (ROOT/path).is_file() and not (OUT/path).is_file() and not (directory/path).is_file():
                raise ValueError(f'Missing final artifact: {path}')
        row = {'canonical_annotation_id': canonical, 'annotation_id': annotation['id'],
               'asset_id': annotation['asset_id'], 'source_sha256': assets[annotation['asset_id']]['sha256'],
               'label': annotation['label'], 'level': annotation['level'], 'parent_id': annotation['parent_id'],
               'review_scope': scope, 'state': 'usable', 'reused_original': not bool(committed),
               'png': final['png'], 'mask': final['mask'], 'rgb_modified': False}
        output_rows.append(row)
        available[(row['asset_id'], canonical)] = row
    tasks = []
    if applicable is None:
        applicable = {(r['asset_id'], r['canonical_annotation_id']) for r in output_rows} | set(rejected)
    for asset, canonical in sorted(applicable):
        if (asset, canonical) in available:
            tasks.append(available[(asset, canonical)])
        else:
            previous = rejected.get((asset, canonical), {})
            tasks.append({'asset_id': asset, 'canonical_annotation_id': canonical,
                          'state': 'pending_correction', 'reason': previous.get('reason', 'No independently accepted native version yet')})
    counts = Counter(row['state'] for row in tasks)
    value = {'format': 'wsc-object-extraction-checkpoint-1', 'stone_id': stone,
             'status': 'pass_processed_with_pending' if counts['pending_correction'] else 'reviewed_tasks_processed',
             'full_stone_complete': False,
             'denominator': 'Explicit source/scope tasks; fragment and group records are not counts of independent physical figures.',
             'source_groups_by_exact_sha': list(source_groups.values()), 'tasks': tasks, 'outputs': output_rows,
             'counts': {'usable_outputs': len(output_rows), 'reused_originals': sum(r['reused_original'] for r in output_rows),
                        'new_native_versions': sum(not r['reused_original'] for r in output_rows),
                        'task_states': dict(counts), 'review_scopes': dict(Counter(r['review_scope'] for r in output_rows))},
             'note': note, 'updated_at_china': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()}
    write(directory/'version-matrix.json', value)
    state_path = OUT/'TASK_STATE.json'; state = read(state_path)
    state.setdefault('object_extraction_checkpoints', {})[stone] = {
        'path': str((directory/'version-matrix.json').relative_to(OUT)),
        'counts': value['counts'], 'full_stone_complete': False, 'status': value['status']}
    state['updated_at_china'] = value['updated_at_china']; write(state_path, state)
    print('CHECKPOINT', stone, value['counts'], flush=True)
    return value
