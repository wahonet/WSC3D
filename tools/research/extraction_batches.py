"""Stage reviewed stone faces once; rough face locations guide native extraction only."""
from __future__ import annotations

import cv2
import numpy as np

from extraction_pilot import (OUT, ROOT, WORK, candidates, export, prepare_cross,
                              prepare_stories, rows, sheet, stone_directory, write)
from extraction_reviews import read


def observe_face(stone, reference, target, source_quad, reference_quad, evidence):
    assets, _ = rows(stone)
    source = np.asarray(source_quad, np.float32) * [assets[target]['width'], assets[target]['height']]
    destination = np.asarray(reference_quad, np.float32) * [assets[reference]['width'], assets[reference]['height']]
    if source.shape != (4, 2) or destination.shape != (4, 2):
        raise ValueError('A face locator needs four observed corners')
    h = cv2.getPerspectiveTransform(source.astype(np.float32), destination.astype(np.float32))
    path = stone_directory(stone)/'source-localization.json'
    locators = read(path) if path.exists() else {}
    key = f'{target}:{reference}'
    value = {'master_asset_id': reference, 'homography': h.tolist(), 'rough_locator': True,
             'source_quad': source_quad, 'reference_quad': reference_quad,
             'evidence': evidence, 'purpose': 'Approximate native ROI only; no mask transfer or registration acceptance'}
    if key in locators and locators[key] != value:
        raise ValueError('A recorded observed locator cannot change silently')
    locators[key] = value
    write(path, locators)


def observe_via(stone, reference, guide, target, source_quad, guide_quad, evidence):
    """Use one already-localized photo to place a weak photo's broad native ROIs."""
    import json
    assets, _ = rows(stone)
    path = stone_directory(stone)/'source-localization.json'
    locators = read(path) if path.exists() else {}
    existing = locators.get(f'{guide}:{reference}') or locators.get(str(guide)) or json.loads(assets[guide]['extra'] or '{}').get('align_to_master', {})
    master = assets.get(existing.get('master_asset_id'), {})
    if existing.get('master_asset_id') != reference and master.get('sha256') != assets[reference]['sha256']:
        raise ValueError(f'{stone}: guide {guide} is not localized to face {reference}')
    if existing.get('homography'):
        guide_matrix = np.asarray(existing['homography'])
    else:
        s,theta = existing['s'],np.deg2rad(existing['theta_deg'])
        guide_matrix = np.array([[s*np.cos(theta),-s*np.sin(theta),existing['tx']],
                                 [s*np.sin(theta),s*np.cos(theta),existing['ty']],[0,0,1]])
    source = np.asarray(source_quad, np.float32)*[assets[target]['width'], assets[target]['height']]
    destination = np.asarray(guide_quad, np.float32)*[assets[guide]['width'], assets[guide]['height']]
    h = guide_matrix @ cv2.getPerspectiveTransform(source.astype(np.float32), destination.astype(np.float32))
    value = {'master_asset_id': reference, 'homography': (h/h[2,2]).tolist(), 'rough_locator': True,
             'observed_guide_asset_id': guide, 'source_quad': source_quad, 'guide_quad': guide_quad,
             'evidence': evidence, 'purpose': 'Approximate native ROI only; native segmentation independently reviewed'}
    key = f'{target}:{reference}'
    if key in locators and locators[key] != value:
        raise ValueError('An observed locator cannot change silently')
    locators[key] = value; write(path, locators)


def stage_faces(stone, faces, note, tag='object-20261004'):
    """Faces maps original annotation source IDs to actually observed target source IDs."""
    directory = stone_directory(stone)
    assets, annotations = rows(stone)
    scope = read(ROOT/'resources/authoring/research/multiversion-20261002/native-scope-policy.json')
    excluded = set(scope['do_not_stage_new_individual_mask_canonical_ids'])
    originals = [a for a in annotations if not a['geometry'].get('image_version')]
    ids = [a['id'] for a in originals if a['asset_id'] in faces and a['id'] not in excluded
           and a['level'] in ('figure', 'component', 'scene', 'band')
           and (a['atype']=='polygon' or (a['atype']=='rect' and a['level'] in ('scene', 'band')))]
    export(stone, ids)
    reused = {(a['asset_id'], a['id']) for a in originals if a['id'] in ids}
    loc_path = directory/'source-localization.json'
    locators = read(loc_path) if loc_path.exists() else {}
    for reference in faces:
        locators[f'{reference}:{reference}'] = {'master_asset_id': reference, 'homography': np.eye(3).tolist(), 'purpose': 'Original source identity'}
    write(loc_path, locators)
    jobs, stories, bands, pending, face_rows = [], [], [], [], []
    for reference, targets in faces.items():
        actual, seen = [], {assets[reference]['sha256']}
        aliases = []
        for target in targets:
            if assets[target]['sha256'] in seen:
                aliases.append(target)
            else:
                actual.append(target); seen.add(assets[target]['sha256'])
        subject_ids = [a['id'] for a in originals if a['asset_id']==reference and a['id'] not in excluded
                       and a['level'] in ('figure','component')]
        path = prepare_cross(stone, reference, [*actual, reference], tag, subject_ids, reused)
        jobs.extend(read(path)); pending.extend(read(directory/f'{tag}-pending.json'))
        stories.extend(prepare_stories(stone, reference, actual, tag=tag+'-story-context'))
        bands.extend(prepare_stories(stone, reference, actual, tag=tag+'-whole-bands', levels=('band',)))
        face_rows.append({'reference_asset_id': reference, 'target_asset_ids': actual,
                          'exact_sha_aliases': aliases, 'canonical_subject_ids': subject_ids,
                          'canonical_context_ids': [a['id'] for a in originals if a['asset_id']==reference and a['level'] in ('scene','band')]})
    path = WORK/f'native-jobs-{stone}-{tag}.json'
    write(path, jobs); write(directory/f'{tag}-pending.json', pending)
    candidates(stone, stories, 'stories'); candidates(stone, bands, 'bands')
    for start in range(0,len(ids),16):
        sheet(stone,start,16)
    write(directory/'batch-state.json', {'faces': face_rows, 'original_ids': ids, 'prepared_jobs': str(path),
          'source_evidence': str((directory/'sources.jpg').relative_to(OUT)), 'whole_source_viewed': True,
          'note': note, 'phase': 'native extraction staged'})
    print('STAGED', stone, len(jobs), 'native jobs', len(stories), 'stories', len(bands), 'whole bands', flush=True)
    return path
