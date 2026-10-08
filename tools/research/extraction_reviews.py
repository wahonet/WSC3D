"""Record actual object reviews, publish once, and retire reconstructible inputs."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from extraction_pilot import OUT, ROOT, WORK, POLICY, export, rows, sha, stone_directory, write


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def record_pages(stone, tag, pages, accepted, overrides=None):
    """Persist each actual visual page decision while a large stone is reviewed."""
    directory = stone_directory(stone)
    path = directory/f'{tag}-page-decisions.json'
    value = read(path) if path.exists() else {'viewed_pages': [], 'accepted_keys': [], 'overrides': {}}
    viewed = [str(p.relative_to(OUT)) if isinstance(p, Path) else p for p in pages]
    rows_ = [r for r in read(directory/f'{tag}-index.json') if r.get('review_sheet') in viewed]
    keys = {(r['asset_id'],r['canonical_annotation_id']) for r in rows_}
    accepted = set(accepted)
    if not accepted.issubset(keys):
        raise ValueError('Acceptance has no evidence on these actually viewed pages')
    value['viewed_pages'] = sorted(set(value['viewed_pages']) | set(viewed))
    value['accepted_keys'] = [list(k) for k in sorted({tuple(k) for k in value['accepted_keys']} | accepted)]
    for key, fields in (overrides or {}).items():
        if key not in accepted:
            raise ValueError('Scope override for an unaccepted object')
        value['overrides'][f'{key[0]}:{key[1]}'] = fields
    write(path,value)
    print('PAGES_REVIEWED',stone,tag,len(value['viewed_pages']),'accepted',len(value['accepted_keys']),flush=True)
    return path


def finish_pages(stone, tag):
    directory = stone_directory(stone); saved = read(directory/f'{tag}-page-decisions.json')
    accepted = {tuple(k) for k in saved['accepted_keys']}
    index = read(directory/f'{tag}-index.json')
    if {r.get('review_sheet') for r in index if r.get('review_sheet')} - set(saved['viewed_pages']):
        raise ValueError('There are visual pages still awaiting object review')
    rejected = {(r['asset_id'],r['canonical_annotation_id']):saved.get('scope_rejections', {}).get(f'{r["asset_id"]}:{r["canonical_annotation_id"]}', '一次整体检查未通过：主体遗漏、明显邻物或背景误选；保留待修正记录。')
                for r in index if (r['asset_id'],r['canonical_annotation_id']) not in accepted}
    overrides = {tuple(map(int,k.split(':'))):v for k,v in saved['overrides'].items()}
    return accept_index(stone,tag,saved['viewed_pages'],rejected,overrides)


def trace_subject(proposal_path, preview_path, points_px, tag, note, exclusions=()):
    """One observed outline on this source's preview; rasterize on its native crop."""
    import numpy as np
    import cv2
    from PIL import Image
    from app.sam_worker import encode_native_mask
    from multiversion_pixel_frames import validate_pixel_frame
    parent = read(proposal_path); job = parent['job']
    frame = validate_pixel_frame(job)
    width, height = frame['crop_size']
    with Image.open(preview_path) as preview:
        pw, ph = preview.size
    binary = np.zeros((height, width), np.uint8)
    recorded = []
    for operation, points in [('include', points_px), *[('exclude', p) for p in exclusions]]:
        observed = np.asarray(points, float)
        if len(observed) < 3 or np.any(observed < 0) or np.any(observed > [pw, ph]):
            raise ValueError('Observed points leave this source preview')
        native = np.rint(observed * [width/pw, height/ph]).astype(np.int32)
        native = np.minimum(native, [width-1, height-1])
        cv2.fillPoly(binary, [native], int(operation == 'include'))
        recorded.append({'operation': operation, 'native_crop_points_px': native.tolist()})
    x0, y0, x1, y1 = job['crop_extent']
    polygon = [[x0+x/pw*(x1-x0), y0+y/ph*(y1-y0)] for x, y in points_px]
    mask = {**encode_native_mask(binary), 'extent': job['crop_extent']}
    value = {'job': job, 'weight_sha256': None, 'visual_reviewed': False,
             'request': {'method': 'one whole-subject outline observed on this source',
                         'model_used': False, 'rgb_modified': False,
                         'observed_preview': str(preview_path), 'preview_sha256': sha(preview_path),
                         'preview_size': [pw, ph], 'native_size': [width, height],
                         'corrections': recorded, 'note': note},
             'result': {'detections': [{'native_mask': mask, 'polygon': polygon,
                                        'localization_overlap': 1}]}}
    path = OUT/'native-proposals'/f'{job["stone_id"]}-{job["target_asset_id"]}-{job["canonical_annotation_id"]}-{tag}.json'
    if path.exists() and read(path) != value:
        raise ValueError('Observed native outline is immutable')
    write(path, value)
    return path


def accept_index(stone, tag, viewed_pages, rejected=None, overrides=None,
                 note='已实际查看本源原色对象及透明结果；通过项仅按所记录的主体、组合或残刻范围使用。'):
    """Call only after inspecting every supplied page; no score grants acceptance."""
    directory = stone_directory(stone)
    index = read(directory / f'{tag}-index.json')
    rejected, overrides = rejected or {}, overrides or {}
    viewed = {str(p.relative_to(OUT)) if isinstance(p, Path) else p for p in viewed_pages}
    if any(not (OUT / p).is_file() for p in viewed):
        raise ValueError('Missing actual visual evidence')
    accepted, pending = [], []
    for row in index:
        key = (row['asset_id'], row['canonical_annotation_id'])
        if row['detection_index'] is None or key in rejected:
            pending.append({**row, 'state': 'needs_correction',
                            'reason': rejected.get(key, '模型未产生可用单体候选')})
            continue
        if row['review_sheet'] not in viewed:
            raise ValueError(f'Unviewed page: {row["review_sheet"]}')
        original = OUT / row['proposal']
        saved = read(original)
        override = overrides.get(key, {})
        index_number = override.get('detection_index', row['detection_index'])
        detection = saved['result']['detections'][index_number]
        selected = directory / 'accepted' / (original.stem + '-selected.json')
        compact = {**saved, 'result': {**saved['result'], 'detections': [detection]},
                   'visual_reviewed': True,
                   'selection': {'source_proposal_sha256': sha(original),
                                 'original_detection_index': index_number,
                                 'review_evidence': [row['review_sheet']], 'policy': POLICY}}
        if selected.exists() and read(selected) != compact:
            raise ValueError('A saved review cannot change silently')
        write(selected, compact)
        accepted.append({'proposal': str(selected.relative_to(OUT)), 'detection_index': 0,
                         'target_asset_id': key[0], 'canonical_annotation_id': key[1],
                         'evidence': [row['review_sheet']], 'visual_note': note,
                         'review_policy': POLICY,
                         'uncertainty_note': '按对象整体检查；细小磨蚀刻线未作逐像素穷举。',
                         **{k: v for k, v in override.items() if k != 'detection_index'}})
    result = {'format': 'wsc-object-review-1', 'stone_id': stone, 'review_policy': POLICY,
              'actual_viewed_pages': sorted(viewed), 'accepted': accepted, 'pending': pending,
              'reviewed_at_china': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()}
    path = directory / f'{tag}-review.json'
    write(path, result)
    print('REVIEW', stone, tag, 'accepted', len(accepted), 'pending', len(pending), flush=True)
    return path


def publish(stone, review_path):
    """Serial publication; previously imported decisions are skipped by exact key."""
    from multiversion_commit_masks import main
    review = read(review_path)
    records = read(OUT / 'native-commits.json')
    existing_proposals = {v['proposal'] for v in records['versions']}
    assets, annotations = rows(stone)
    accepted = []
    for decision in review['accepted']:
        if decision['proposal'] in existing_proposals:
            continue
        previous = [a for a in annotations if a['asset_id'] == decision['target_asset_id']
                    and a['geometry'].get('image_version', {}).get('canonical_annotation_id')
                    == decision['canonical_annotation_id']]
        if previous:
            decision = {**decision, 'new_revision': True}
        accepted.append(decision)
    pending_path = Path(review_path).with_name(Path(review_path).stem + '-publication.json')
    write(pending_path, {**review, 'accepted': accepted})
    if accepted:
        main(pending_path, OUT / 'native-commits.json', [stone])
    committed = read(OUT / 'native-commits.json')['versions']
    proposals = {d['proposal'] for d in review['accepted']}
    ids = [v['annotation_id'] for v in committed if v['proposal'] in proposals]
    if len(ids) != len(proposals):
        raise ValueError('Not every accepted version has been published')
    export(stone, ids)
    print('PUBLISHED_AND_EXPORTED', stone, len(ids), flush=True)
    return ids


def close_stone(stone, original_pages, context_pages, note='', context_rejected=None):
    """Publish explicitly viewed figures and contexts through the single writer."""
    import contextlib
    import io
    from multiversion_commit_masks import main as _initialize_api
    from extraction_checkpoints import checkpoint
    directory = stone_directory(stone)
    assets, annotations = rows(stone)
    original_ids = {a['id'] for a in annotations if not a['geometry'].get('image_version')}
    originals = [r['annotation_id'] for r in read(directory/'cutouts.json')['versions'] if r['annotation_id'] in original_ids]
    for page in original_pages:
        if not (directory/page).is_file():
            raise ValueError('Original review evidence missing')
    write(directory/'original-review.json', {'actually_viewed_pages':[str(directory/p) for p in original_pages],
          'annotation_ids':originals, 'result':'Original source masks reused at their existing object, component, or group scope.'})
    reviews = [finish_pages(stone, 'figures')]
    for tag, viewed in context_pages.items():
        index = read(directory/f'{tag}-index.json')
        scope = 'whole_native_band_context' if 'bands' in tag else 'native_story_context'
        reviews.append(accept_index(stone,tag,[directory/p for p in viewed], (context_rejected or {}).get(tag),
            overrides={(r['asset_id'],r['canonical_annotation_id']):{'review_scope':scope} for r in index}))
    with contextlib.redirect_stdout(io.StringIO()):
        for review in reviews:
            publish(stone, review)
        linked = sync_reviewed_parent_links(stone, reviews)
        if linked:
            export(stone, [change['annotation_id'] for change in linked])
    value = checkpoint(stone,note=note)
    retire_inputs(stone,reviews)
    return value


def sync_reviewed_parent_links(stone, review_paths):
    """Link this batch's children to a parent published later in the same batch."""
    from multiversion_commit_masks import call
    assets, annotations = rows(stone)
    by_id = {a['id']: a for a in annotations}
    records = read(OUT/'native-commits.json')
    proposals = {d['proposal'] for p in review_paths for d in read(p)['accepted']}
    changes = []
    for version in records['versions']:
        if version['proposal'] not in proposals:
            continue
        child = by_id[version['annotation_id']]
        metadata = child['geometry']['image_version']
        source = by_id[metadata['canonical_annotation_id']]
        canonical_parent = metadata.get('reviewed_story_parent', {}).get('canonical_annotation_id', source['parent_id'])
        parent_id = records['parents'].get(f'{child["asset_id"]}:{canonical_parent}')
        if parent_id is None or child['parent_id'] == parent_id:
            continue
        assert by_id[parent_id]['asset_id'] == child['asset_id']
        updated = call('PATCH', f'/annotations/{child["id"]}', {'parent_id': parent_id, 'auto_parent': False})
        assert updated['geometry'] == child['geometry']
        for field in ('quality', 'review_status', 'geometry_intent'):
            assert updated[field] == child[field]
        changes.append({'annotation_id':child['id'], 'before':child['parent_id'], 'after':parent_id})
    write(stone_directory(stone)/'parent-link-review.json', {'new_batch_only':True, 'changes':changes})
    return changes


def retire_inputs(stone, review_paths, raw_proposals=()):
    """Final cutouts and coordinate proofs remain; input PNGs rebuild byte-for-byte."""
    from multiversion_pixel_frames import validate_pixel_frame
    directory = stone_directory(stone)
    finals = read(directory / 'cutouts.json')['versions']
    committed = read(OUT / 'native-commits.json')['versions']
    protected = {v['proposal'] for v in committed}
    jobs, reviewed_proposals = {}, set()
    for path in review_paths:
        review = read(path)
        for decision in review['accepted']:
            proposal = decision['proposal']
            matches = [v for v in committed if v['proposal'] == proposal]
            if not matches or not any(v['annotation_id'] in {f['annotation_id'] for f in finals} for v in matches):
                raise ValueError('Accepted output has no final cutout')
            saved = read(OUT / proposal)
            job = saved['job']; jobs[job['crop_path']] = job
            reviewed_proposals.add(proposal)
        for decision in review.get('pending', []):
            proposal = decision.get('proposal')
            if proposal and (OUT/proposal).is_file():
                job = read(OUT/proposal)['job']
                if job.get('pixel_frame_record'):
                    jobs[job['crop_path']] = job
    removed_bytes, removed_files = 0, 0
    boundary = (WORK / 'native-inputs').resolve()
    for job in jobs.values():
        path = Path(job['crop_path']).resolve()
        if not path.is_relative_to(boundary):
            raise ValueError('Input cache is outside this task')
        if path.is_file():
            validate_pixel_frame(job)
            removed_bytes += path.stat().st_size; removed_files += 1; path.unlink()
    raw_boundary = (OUT / 'native-proposals').resolve()
    for raw in raw_proposals:
        path = Path(raw).resolve()
        if not path.is_relative_to(raw_boundary) or str(path.relative_to(OUT)) in protected:
            raise ValueError('Cannot retire a published or unrelated proposal')
        if path.is_file():
            removed_bytes += path.stat().st_size; removed_files += 1; path.unlink()
    record = {'format': 'wsc-reconstructible-cache-retirement-1', 'stone_id': stone,
              'removed_files': removed_files, 'removed_bytes': removed_bytes,
              'retained_accepted_proposals': sorted(reviewed_proposals),
              'reconstruction': 'Original source + native frame/crop coordinates; regenerated PNG must match recorded SHA256.'}
    previous_path = directory / 'cache-retirement.json'
    if previous_path.exists():
        previous = read(previous_path)
        record['removed_files'] += previous['removed_files']
        record['removed_bytes'] += previous['removed_bytes']
        record['retained_accepted_proposals'] = sorted(set(record['retained_accepted_proposals']) | set(previous['retained_accepted_proposals']))
    write(previous_path, record)
    print('RETIRED', stone, removed_files, removed_bytes, flush=True)
    return record
