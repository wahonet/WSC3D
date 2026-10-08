"""Seal a finite stone review, retaining every unresolved source task."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import datetime
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from multiversion_context import OUT
from multiversion_sam import write

TERMINAL_APPLICABLE = {'published_and_ui_verified', 'needs_new_evidence'}


def close_stone(stone: str, subrange_review: Path | None):
    directory = OUT / 'stones' / stone
    matrix_path = directory / 'version-matrix.json'
    matrix = json.loads(matrix_path.read_text(encoding='utf-8'))
    catalogue = json.loads((directory / 'catalog-review/catalog.json').read_text(encoding='utf-8'))
    rows = matrix['records']
    assert len({row['task_key'] for row in rows}) == len(rows)
    entities = {row['entity_id'] for row in matrix['entities']}
    groups = {row['source_group_id'] for row in matrix['source_groups']}
    assert {(r['entity_id'],r['source_group_id']) for r in rows} == {
        (entity,group) for entity in entities for group in groups}
    pending = [r['task_key'] for r in rows if r['applicable'] is True and r['state'] not in TERMINAL_APPLICABLE]
    if pending:
        raise ValueError(f'Finite native review is still pending for {len(pending)} tasks: {pending[:5]}')
    identity_requirements = {}
    for row in rows:
        if row['applicable'] is True:
            assert row.get('review_evidence'), row['task_key']
            for evidence in row['review_evidence']:
                path = Path(evidence)
                assert (path if path.is_absolute() else OUT/path).is_file(), evidence
            if row['state'] == 'published_and_ui_verified':
                assert row.get('publication_id') and row.get('ui_evidence'), row['task_key']
                ui = row['ui_evidence']
                for evidence in [ui] if isinstance(ui,str) else ui:
                    path = Path(evidence)
                    assert (path if path.is_absolute() else OUT/path).is_file(), evidence
            else:
                regions = row.get('unresolved_original_regions') or row.get('unresolved_regions_original_pixels')
                required = row.get('required_new_evidence') or row.get('required_evidence')
                assert regions and required, f"Missing concrete unresolved coordinates or evidence: {row['task_key']}"
        elif row['applicable'] is None:
            assert row['state'] == 'identity_pending' and row.get('coverage_note'), row['task_key']
            issues = [issue for issue in catalogue.get('issues',[]) if row['asset_id'] in issue.get('assets',[])
                and row['entity_id'].rsplit('/',1)[-1] in issue.get('entities',[])
                and issue.get('new_evidence_needed')]
            assert issues, f"Missing source identity evidence requirement: {row['task_key']}"
            identity_requirements[row['task_key']] = '；'.join(issue['new_evidence_needed'] for issue in issues)
        else:
            assert row['state'] in {'other_face','not_visible_in_source','same_capture_duplicate'}, row['task_key']
    subranges = matrix.get('original_subranges', [])
    subrange_record = None
    if subranges:
        assert subrange_review and subrange_review.is_file(), 'Every retained original subrange requires a finite review record'
        subrange_record = json.loads(subrange_review.read_text(encoding='utf-8'))
        reviewed = {r['original_anchor_id'] for r in subrange_record['rows']}
        expected = {r['original_anchor_id'] for r in subranges}
        assert reviewed == expected, (reviewed,expected)
        assert all(r.get('actual_visual_evidence') and r.get('quality_disposition') for r in subrange_record['rows'])
    now = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()
    unresolved = [r for r in rows if r['applicable'] is not False and r['state'] != 'published_and_ui_verified']
    complete = not unresolved
    status = 'complete' if complete else 'processed_with_unresolved_evidence'
    record = {'format':'wsc-finite-stone-review-1','stone_id':stone,'review_sealed_at_china':now,
        'status':status,'all_applicable_versions_completed':complete,
        'counts':dict(Counter(r['state'] for r in rows)),
        'catalogue_entities':len(entities),'known_applicable_tasks':sum(r['applicable'] is True for r in rows),
        'identity_pending_tasks':sum(r['applicable'] is None for r in rows),
        'matrix':'version-matrix.json','matrix_sha256':hashlib.sha256(matrix_path.read_bytes()).hexdigest(),
        'original_subrange_review':str(subrange_review.relative_to(OUT)) if subrange_review else None,
        'source_identity_issues':catalogue.get('issues',[]),
        'unresolved_tasks':[{'task_key':r['task_key'],'entity':r['name'],'asset_id':r['asset_id'],
            'source_sha256':r['source_sha256'],'state':r['state'],
            'unresolved_original_regions':r.get('unresolved_original_regions') or r.get('unresolved_regions_original_pixels'),
            'issue':r.get('issue') or r.get('reason') or r.get('coverage_note'),
            'required_new_evidence':r.get('required_new_evidence') or r.get('required_evidence') or identity_requirements.get(r['task_key']),
            'review_evidence':r.get('review_evidence',[])} for r in unresolved],
        'concentrated_doubt_review':'Pending once after all identifiable tasks across the 46 stones have received finite review.'}
    write(directory/'finite-review.json',record)
    with (directory/'version-matrix.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        fields=['task_key','entity_id','entity_kind','name','source_group_id','asset_id','source_sha256',
            'coverage_status','applicable','state','publication_id','review_evidence','ui_evidence']
        writer=csv.DictWriter(stream,fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({key:json.dumps(row.get(key),ensure_ascii=False) if isinstance(row.get(key),(list,dict))
                else row.get(key) for key in fields})
    state_path=OUT/'TASK_STATE.json'
    state=json.loads(state_path.read_text(encoding='utf-8'))
    processed=state.setdefault('processed_stone_ids',[])
    if stone not in processed:
        processed.append(stone)
    if complete and stone not in state['completed_stone_ids']:
        state['completed_stone_ids'].append(stone)
    state.setdefault('finite_reviews',{})[stone]={'status':status,'evidence':str((directory/'finite-review.json').relative_to(OUT))}
    scope=state['scope_stones']
    cursor=scope.index(stone)
    if cursor+1<len(scope):
        state['cursor'].update(stone_id=scope[cursor+1],batch=(cursor+1)//4+1,
            phase='full_source_visual_entity_census',entity_source_key=None)
        state['next_action']=f"Review every unique source and all original entity seeds for {scope[cursor+1]}; establish complete actual entity and source applicability catalogue before native segmentation."
    else:
        state['cursor']['phase']='concentrated_doubt_review'
        state['next_action']='Perform the one finite concentrated review of all unresolved evidence tasks, preserving incomplete tasks and required new evidence.'
    state['updated_at_china']=now
    write(state_path,state)
    print(json.dumps({k:record[k] for k in ('stone_id','status','counts','all_applicable_versions_completed')},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stone')
    parser.add_argument('--subrange-review',type=Path)
    args=parser.parse_args()
    close_stone(args.stone,args.subrange_review)
