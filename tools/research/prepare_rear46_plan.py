"""Prepare a rear-hall-only handoff without running segmentation or imports."""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import csv
import hashlib
import json
import sqlite3
import sys

ROOT = Path('F:/wsc-unified')
OLD = ROOT / 'resources/authoring/research/multiversion-20261002'
DEST = ROOT / 'resources/authoring/research/rear46-plan-20261003'

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def write_csv(name, rows):
    with (DEST / name).open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

def main():
    inventory = read(OLD / 'inventory.json')
    baseline = read(OLD / 'baseline.json')
    policy = read(OLD / 'native-scope-policy.json')
    manifest = read(OLD / 'native-commits.json')
    audit = read(OLD / 'progress-audit.json')
    stop = read(OLD / 'stop-review-20261003/停止时只读核验.json')
    scope = inventory['layouts']['rear']
    assert scope == [f'武{n:03}' for n in range(8, 54)]
    scope_set = set(scope)
    original = [row for row in baseline['annotations'] if row['stone_id'] in scope_set]
    original_by_id = {row['id']: row for row in baseline['annotations']}
    inventory_stones = {row['stone_id']: row for row in inventory['stones']}
    assets_by_stone = {stone: inventory_stones[stone]['assets'] for stone in scope}
    assets = {row['id']: row for rows in assets_by_stone.values() for row in rows}
    blocked = {i for i in policy['do_not_stage_new_individual_mask_canonical_ids'] if original_by_id[i]['stone_id'] in scope_set}
    aggregates = {i for i in policy['aggregate_semantic_targets_from_independent_index'] if original_by_id[i]['stone_id'] in scope_set}
    # The earlier aggregate index was a subset. Redirect every stopped rear
    # unit to its recorded full-band parent as a metadata seed, including
    # Wu031/3070 and Wu034/3772. Visual identity/extent still needs review.
    redirected_bands = {original_by_id[i]['parent_id'] for i in blocked
                        if original_by_id[i]['parent_id'] is not None
                        and original_by_id[original_by_id[i]['parent_id']]['level'] == 'band'}
    aggregates.update(redirected_bands)
    primary = [row for row in original if row['level'] in ('figure', 'component', 'scene') and row['id'] not in blocked]
    targets = {row['id']: row for row in primary}
    targets.update({i: original_by_id[i] for i in aggregates})
    imported = [row for row in manifest['versions'] if original_by_id[row['canonical_annotation_id']]['stone_id'] in scope_set]
    differences = [row for row in stop['current_native_status_differences_from_canonical']
                   if original_by_id[row['canonical_id']]['stone_id'] in scope_set]
    difference_ids = {row['annotation_id'] for row in differences}
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        current = {row['id']: dict(row) for row in db.execute('SELECT * FROM annotations')}
    for row in original:
        assert current[row['id']] == row, 'Original row changed before plan'
    imported_pairs = {}
    for row in imported:
        imported_pairs.setdefault((row['canonical_annotation_id'], row['asset_id']), []).append(row)
    references = Counter(row['annotation_id'] for row in baseline['annotation_references'])
    concepts = Counter(row['annotation_id'] for row in baseline['annotation_concepts'])
    ann_counts = {stone: Counter(row['level'] for row in original if row['stone_id'] == stone) for stone in scope}
    imported_counts = {stone: Counter(current[row['annotation_id']]['level'] for row in imported
                                     if original_by_id[row['canonical_annotation_id']]['stone_id'] == stone) for stone in scope}
    audit_stones = {row['stone_id']: row for row in audit['stones']}
    stone_rows = []
    asset_rows = []
    catalog_rows = []
    matrix_rows = []
    for stone in scope:
        idx = int(stone[1:]) - 8
        group = idx // 4 + 1
        counts = ann_counts[stone]
        native = imported_counts[stone]
        stone_assets = assets_by_stone[stone]
        stone_rows.append({'批次': group, '石号': stone, '名称': inventory_stones[stone]['name'],
                           '源文件数': len(stone_assets), '不同SHA文件组': len({a['sha256'] for a in stone_assets}),
                           '原人物记录': counts['figure'], '原物象记录': counts['component'], '原场景记录': counts['scene'],
                           '整体纹饰目标原ID': ';'.join(str(i) for i in sorted(aggregates) if original_by_id[i]['stone_id'] == stone),
                           '停止逐单元补版原ID': ';'.join(str(i) for i in sorted(blocked) if original_by_id[i]['stone_id'] == stone),
                           '已有新增人物版本': native['figure'], '已有新增物象版本': native['component'],
                           '已有新增场景版本': native['scene'], '已有新增整体版本': native['whole'],
                           '已有新增分层版本': native['layer'], '已有新增配准': audit_stones[stone]['saved_pairs'],
                           '原图全幅查漏': '未在本计划执行', '对象合并及故事目录验收': '待执行',
                           '全部适用来源验收': '待执行'})
        for asset in stone_assets:
            asset_rows.append({'石号': stone, '资产ID': asset['id'], '原文件名': asset['filename'],
                               '来源标签': asset.get('version_label', ''), '原文件SHA256': asset['sha256'],
                               '宽': asset['width'], '高': asset['height'], '原相对路径': asset['relpath'],
                               '刻面及局部覆盖核对': '待执行', '同次拍摄转码核对': '待执行'})
    for row in sorted(original, key=lambda r: (r['stone_id'], r['id'])):
        if row['id'] in blocked:
            role = '按整体纹饰处理，不新增单元版'
        elif row['id'] in aggregates:
            role = '整体纹饰目标'
        elif row['level'] in ('figure', 'component'):
            role = '形象目录种子，需识别整主体/局部/重复'
        elif row['level'] == 'scene':
            role = '故事场景目录种子，需核对重复与叙事范围'
        elif row['level'] in ('whole', 'layer', 'band'):
            role = '结构上下文，需核对有无遗漏故事/整体纹饰'
        else:
            role = '其他原记录，保留并核对与形象故事的关系'
        catalog_rows.append({'石号': row['stone_id'], '原标注ID': row['id'], '原来源资产ID': row['asset_id'],
                             '原名称': row['label'], '原级别': row['level'], '原父ID': row['parent_id'],
                             '原质量': row['quality'], '原研究状态': row['review_status'], '原范围性质': row['geometry_intent'],
                             '原引用数': references[row['id']], '原概念关联数': concepts[row['id']],
                             '计划处理类别': role, '独立对象身份是否已核定': '否，仅原记录索引'})
    for canonical_id, row in sorted(targets.items(), key=lambda pair: (pair[1]['stone_id'], pair[0])):
        by_sha = {}
        for asset in assets_by_stone[row['stone_id']]:
            by_sha.setdefault(asset['sha256'], []).append(asset)
        for sha, copies in by_sha.items():
            own = next((asset for asset in copies if asset['id'] == row['asset_id']), None)
            selected = own or max(copies, key=lambda asset: ((asset.get('width') or 0)*(asset.get('height') or 0), -asset['id']))
            records = [record for asset in copies for record in imported_pairs.get((canonical_id, asset['id']), [])]
            if records:
                status = '已有导入，元数据待核对' if any(record['annotation_id'] in difference_ids for record in records) else '已有导入，可核对复用'
                identity = '已有来源对象关联，须核对既有证据'
            elif own:
                status = '原来源，需检查原掩膜是否达到本轮精度'
                identity = '原来源对象；独立主体身份仍需目录核对'
            else:
                status = '待核对来源是否包含该对象及已有候选'
                identity = '尚未核定同面和对象可见范围'
            matrix_rows.append({'候选行键': f'{row["stone_id"]}:{canonical_id}:{sha[:16]}', '石号': row['stone_id'],
                                '原标注ID': canonical_id, '原对象名称': row['label'], '原级别': row['level'],
                                '整体纹饰': '是' if canonical_id in aggregates else '否',
                                '来源代表资产ID': selected['id'], '同SHA资产ID': ';'.join(str(asset['id']) for asset in copies),
                                '来源标签': selected.get('version_label', ''), '原文件名': selected['filename'], '源SHA256': sha,
                                '来源适用性': identity, '准备状态': status,
                                '已有新增版本ID': ';'.join(str(record['annotation_id']) for record in records),
                                '已核定实体ID': '', '执行结果': '尚未在新任务执行', '精确边界验收': '尚未在新任务执行'})
    batches = [{'batch': n + 1, 'stones': scope[n*4:(n+1)*4]} for n in range((len(scope)+3)//4)]
    now = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
    summary = {'created_at_china': now, 'planning_only': True, 'execution_started': False,
               'scope': {'rear': scope, 'exclude_western_and_extras': True, 'assets': len(assets),
                         'sha_groups_per_stone': sum(len({asset['sha256'] for asset in rows}) for rows in assets_by_stone.values())},
               'catalog_limits': {'original_annotation_rows': len(original),
                                  'figure_rows': ann_counts and sum(c['figure'] for c in ann_counts.values()),
                                  'component_rows': sum(c['component'] for c in ann_counts.values()),
                                  'scene_rows': sum(c['scene'] for c in ann_counts.values()),
                                  'after_ornament_filter_primary_seed_rows': len(primary),
                                  'primary_seed_level_counts': dict(Counter(row['level'] for row in primary)),
                                  'whole_ornament_aggregate_ids': sorted(aggregates),
                                  'aggregate_seeds_from_redirected_original_band_parents': sorted(redirected_bands),
                                  'stopped_individual_rear_ids': sorted(blocked),
                                  'primary_and_aggregate_seed_rows': len(targets),
                                  'candidate_source_matrix_rows': len(matrix_rows),
                                  'unique_visible_entities_or_final_required_version_count_not_asserted': True,
                                  'needs_whole_source_missing_object_discovery': True},
               'existing': {'imported_versions': len(imported),
                            'imported_level_counts': dict(Counter(current[row['annotation_id']]['level'] for row in imported)),
                            'new_alignments': sum(row['已有新增配准'] for row in stone_rows),
                            'metadata_difference_versions': len(differences),
                            'metadata_difference_field_counts': dict(Counter(key for row in differences for key in row['fields']))},
               'batches': batches,
               'inputs': {name: hashlib.sha256((OLD/name).read_bytes()).hexdigest()
                          for name in ('inventory.json','baseline.json','native-commits.json','progress-audit.json','native-scope-policy.json')},
               'matrix_warning': 'Cross-product enumerates SAME-SHA-deduplicated source candidates, not visually confirmed applicability, independent photography batches, pending segmentation quantity or acceptance.'}
    DEST.mkdir(parents=True, exist_ok=True)
    assert not (DEST/'scope-and-seed-index.json').exists() or '--refresh-plan' in sys.argv, 'Plan already prepared; do not silently replace it'
    write_csv('后展厅46件清单.csv', stone_rows)
    write_csv('后展厅286份来源清单.csv', asset_rows)
    write_csv('原对象与结构目录-2323条.csv', catalog_rows)
    write_csv('对象来源组合候选矩阵.csv', matrix_rows)
    write_csv('已有109份新增版本.csv', [{'石号': original_by_id[row['canonical_annotation_id']]['stone_id'],
                                     '新标注ID': row['annotation_id'], '原对象ID': row['canonical_annotation_id'],
                                     '来源资产ID': row['asset_id'], '来源标签': row['source_label'],
                                     '级别': current[row['annotation_id']]['level'],
                                     '质量': current[row['annotation_id']]['quality'],
                                     '范围': current[row['annotation_id']]['geometry_intent'],
                                     '字段整理': '需核对' if row['annotation_id'] in difference_ids else '与原对象字段一致',
                                     '提案': row['proposal']} for row in imported])
    (DEST/'scope-and-seed-index.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'plan_dir': str(DEST), 'summary': summary}, ensure_ascii=False))

if __name__ == '__main__':
    main()
