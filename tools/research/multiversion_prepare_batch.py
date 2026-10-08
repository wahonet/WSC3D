"""Localize independently inferred versions from reviewed coordinate chains, never copy final outlines."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import numpy as np
from PIL import Image
from multiversion_sam import ROOT, OUT, WORK, write
from multiversion_context import BASELINE
from multiversion_frames import reviewed_frames, reviewed_pair
from app.services import previews, transforms as tf


def prompt_for(annotation):
    label, category = annotation['label'], annotation['category']
    # A rider or horse handler is a person; an animal in the contextual suffix
    # must not replace the actual subject, e.g. '飞鸟（马背上空）'.
    subject = label.split('（', 1)[0].split('(', 1)[0]
    if ('车体' in subject or '车轮' in subject) and '车' in subject:
        return 'chariot'
    if any(v in subject for v in ('人', '者', '吏', '侍女', '童子', '小儿', '冠服')):
        return 'person'
    # Narrative categories also contain people. Inspect the subject before animal words
    # in descriptions such as '树上射鸟者' or '喂凤仙人'.
    if '马' in subject:
        return 'horse'
    if category.startswith('figure'):
        return 'person'
    if any(v in subject for v in ('龙', '虎', '兽', '犬', '鱼', '鹿', '鸟')):
        return 'animal'
    if '车' in label:
        return 'chariot'
    return 'object'


def capture_classes(assets, alignments):
    """Collapse only equal originals or explicitly reviewed same-capture derivatives."""
    parent = {a['id']: a['id'] for a in assets}
    indexed = {a['id']: a for a in assets}
    def root(key):
        while parent[key] != key:
            key = parent[key]
        return key
    def union(left, right):
        a, b = root(left), root(right)
        parent[max(a, b)] = min(a, b)
    by_hash = {}
    for asset in assets:
        if asset['sha256'] in by_hash:
            union(asset['id'], by_hash[asset['sha256']])
        else:
            by_hash[asset['sha256']] = asset['id']
    for row in alignments:
        geometry = json.loads(row['geometry']) if isinstance(row['geometry'], str) else row['geometry']
        if geometry.get('visual_review', {}).get('same_capture_derivative') is not True:
            continue
        pair = reviewed_pair(row, indexed)
        if pair:
            union(pair[0], pair[1])
    return {key: root(key) for key in parent}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stones', nargs='+', required=True)
    ap.add_argument('--tag', required=True)
    options = ap.parse_args()
    if not options.tag.replace('-', '').isalnum():
        raise ValueError('Invalid batch tag')
    jobs_path = WORK/f'native-jobs-{options.tag}.json'
    if jobs_path.exists():
        raise ValueError('A prepared batch is immutable; choose a new tag')
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
    inventory = json.loads((OUT/'inventory.json').read_text(encoding='utf-8'))
    with sqlite3.connect(ROOT/'data/stonelab.db') as db:
        db.row_factory = sqlite3.Row
        assets = {row['id']: dict(row) for row in db.execute('SELECT * FROM assets')}
        alignments = [dict(row) for row in db.execute("SELECT * FROM annotations WHERE tool='align'")]
    for asset in assets.values():
        asset['extra'] = json.loads(asset['extra'] or '{}')
    jobs, skipped = [], []
    planned = {(j['target_asset_id'], j['canonical_annotation_id'])
               for path in WORK.glob('native-jobs*.json')
               for j in json.loads(path.read_text(encoding='utf-8'))}
    for stone in inventory['stones']:
        if stone['stone_id'] not in options.stones:
            continue
        local = [assets[a['id']] for a in stone['assets']]
        local_alignments = [a for a in alignments if a['stone_id'] == stone['stone_id']]
        captures = capture_classes(local, local_alignments)
        already = {(captures[target], canonical) for target, canonical in planned if target in captures}
        eligible = {}
        for asset in local:
            eligible[asset['id']] = [a for a in baseline['annotations'] if a['asset_id'] == asset['id'] and
                a['tool'] in ('segment', 'annotate') and a['atype'] == 'polygon' and
                a['level'] in ('figure', 'component', 'object', 'ornament', 'inscription', 'group') and
                a['geometry_intent'] != 'reconstructed_extent' and a['review_status'] in ('reviewed', 'candidate', 'approved')]
        frames = reviewed_frames({a['id']: a for a in local},
                                 local_alignments,
                                 {a: len(rows) for a, rows in eligible.items()})
        for frame in frames:
            family = [assets[a] for a in frame['to_reference']]
            source = assets[frame['reference_asset_id']]
            if not eligible[source['id']]:
                continue
            for target in family:
                if captures[target['id']] == captures[source['id']]:
                    continue
                reference_to_target = tf.invert(frame['to_reference'][target['id']])
                work_path = previews.ensure_work_image(target['id'], target['relpath'])
                work_sha = hashlib.file_digest(work_path.open('rb'), 'sha256').hexdigest()
                version_label = next(a['version_label'] for a in stone['assets'] if a['id'] == target['id'])
                with Image.open(work_path) as image:
                    width, height = image.size
                    for annotation in eligible[source['id']]:
                        if (target['id'], annotation['id']) in planned:
                            skipped.append({'stone_id': stone['stone_id'], 'asset_id': target['id'],
                                            'canonical_id': annotation['id'], 'reason': 'already-planned-native-job'})
                            continue
                        capture_key = (captures[target['id']], annotation['id'])
                        if capture_key in already:
                            skipped.append({'stone_id': stone['stone_id'], 'asset_id': target['id'],
                                            'canonical_id': annotation['id'], 'reason': 'same-capture-version-already-planned'})
                            continue
                        g = json.loads(annotation['geometry'])
                        source_points = np.asarray(g['points'], dtype=float)
                        if source_points.ndim != 2 or source_points.shape[1] != 2:
                            continue
                        points = np.asarray([tf.apply(reference_to_target, x*source['width'], y*source['height']) for x, y in source_points])/[target['width'], target['height']]
                        low, high = points.min(0), points.max(0)
                        region = [*low.tolist(), *high.tolist()]
                        if not np.isfinite(points).all() or np.any(high <= 0) or np.any(low >= 1) or np.any(high-low > .8):
                            skipped.append({'stone_id': stone['stone_id'], 'asset_id': target['id'], 'canonical_id': annotation['id'], 'reason': 'insufficient-native-coverage'})
                            continue
                        margin = np.maximum((high-low)*.28, [.006, .006])
                        low, high = np.maximum(0, low-margin), np.minimum(1, high+margin)
                        px = [int(np.floor(low[0]*width)), int(np.floor(low[1]*height)),
                              int(np.ceil(high[0]*width)), int(np.ceil(high[1]*height))]
                        if min(px[2]-px[0], px[3]-px[1]) < 22:
                            skipped.append({'stone_id': stone['stone_id'], 'asset_id': target['id'], 'canonical_id': annotation['id'], 'reason': 'native-region-too-small'})
                            continue
                        crop_path = WORK/'native-inputs'/options.tag/f"{target['id']}-{annotation['id']}.png"
                        crop_path.parent.mkdir(parents=True, exist_ok=True)
                        image.crop(tuple(px)).convert('RGB').save(crop_path)
                        crop_sha = hashlib.file_digest(crop_path.open('rb'), 'sha256').hexdigest()
                        jobs.append({'stone_id': stone['stone_id'], 'canonical_annotation_id': annotation['id'],
                            'canonical_asset_id': source['id'], 'label': annotation['label'], 'target_asset_id': target['id'],
                            'source_sha256': target['sha256'], 'source_filename': target['filename'], 'version_label': version_label,
                            'work_image_sha256': work_sha, 'crop_path': str(crop_path), 'crop_sha256': crop_sha,
                            'crop_extent': [px[0]/width, px[1]/height, px[2]/width, px[3]/height],
                            'expected_outline': points.tolist(), 'expected_prompt': prompt_for(annotation),
                            'localization_method': 'reviewed-same-face-pair-path; projected outline is only a crop locator',
                            'localization_alignment_ids': frame['alignment_paths'][target['id']],
                            'variants': ['native', 'enhance', 'rubbing']})
                        already.add(capture_key)
    write(jobs_path, jobs)
    write(OUT/f'native-batch-{options.tag}.json', {'jobs_file': str(jobs_path), 'stones': options.stones,
        'regions': len(jobs), 'requests': sum(len(j['variants']) for j in jobs), 'skipped': skipped, 'accepted_masks': 0})
    print(json.dumps({'regions': len(jobs), 'requests': len(jobs)*3, 'skipped': len(skipped), 'jobs_file': str(jobs_path)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
