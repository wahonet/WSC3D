"""Build per-face crop-locator frames from saved, explicitly reviewed image pairs.

These frames never alter platform chains or annotations. A different face can
have its own reference without being joined to the stone's primary image.
"""
from __future__ import annotations

from collections import deque
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.services import transforms as tf

from multiversion_context import RUN, REVIEWED_RUNS
# The four source-checked Wu010 demonstrations were reviewed before this run.
BASELINE_REVIEWED = frozenset((5183, 5184, 5185, 5186))


def geometry(row):
    value = row['geometry']
    return json.loads(value) if isinstance(value, str) else value


def reviewed_pair(row, assets):
    if row['tool'] != 'align':
        return None
    g = geometry(row)
    if g.get('local_only') is True:
        return None
    fresh = (g.get('research_run') in REVIEWED_RUNS and
             g.get('visual_review', {}).get('decision') == 'accepted')
    baseline = row['id'] in BASELINE_REVIEWED and row['stone_id'] == '武010'
    if not fresh and not baseline:
        return None
    left, right = row['asset_id'], g.get('target_asset_id')
    if left not in assets or right not in assets or left == right:
        raise ValueError('Reviewed pair has missing or identical asset identities')
    a, b = assets[left], assets[right]
    if a['stone_id'] != b['stone_id'] or a['stone_id'] != row['stone_id']:
        raise ValueError('A registration cannot join different stones')
    if fresh and g.get('source_sha256') != [a['sha256'], b['sha256']]:
        raise ValueError('Reviewed pair source fingerprint changed')
    if baseline:
        validation = g.get('validation', {})
        if 'identical_source_sha256' in validation:
            if not a['sha256'] == b['sha256'] == validation['identical_source_sha256']:
                raise ValueError('Baseline identity no longer matches its originals')
        elif validation.get('method') != 'distributed-landmark-guided-SIFT-RANSAC-similarity':
            raise ValueError('Unexpected baseline registration evidence')
    transform = tf.homography(g['homography']) if g.get('model') == 'homography' else {
        k: g[k] for k in ('s', 'theta_deg', 'tx', 'ty')}
    tf.validate_domain(transform, b['width'], b['height'])
    tf.validate_domain(tf.invert(transform), a['width'], a['height'])
    return left, right, transform


def reviewed_frames(assets, annotations, source_priority=None):
    """Return disjoint face frames, each mapping source pixels into its own root.

Traversal records alignment IDs as localization provenance. Unsupported and
local-only edges cannot supply a path to a different face. A failed domain
validation aborts instead of quietly substituting an affine approximation.
"""
    priority = source_priority or {}
    neighbours = {key: [] for key in assets}
    for row in sorted(annotations, key=lambda r: r['id']):
        pair = reviewed_pair(row, assets)
        if pair is None:
            continue
        left, right, transform = pair
        neighbours[left].append((right, transform, row['id']))
        neighbours[right].append((left, tf.invert(transform), row['id']))
    remaining = set(assets)
    families = []
    while remaining:
        root = max(remaining, key=lambda k: (priority.get(k, 0), -k))
        transforms = {root: tf.identity()}
        paths = {root: []}
        queue = deque((root,))
        remaining.remove(root)
        while queue:
            current = queue.popleft()
            for neighbour, neighbour_to_current, annotation_id in neighbours[current]:
                if neighbour in transforms:
                    continue
                if neighbour not in remaining:
                    raise ValueError('A reviewed graph crossed previously separated frames')
                mapped = tf.compose(transforms[current], neighbour_to_current)
                source = assets[neighbour]
                tf.validate_domain(mapped, source['width'], source['height'])
                transforms[neighbour] = mapped
                paths[neighbour] = [*paths[current], annotation_id]
                remaining.remove(neighbour)
                queue.append(neighbour)
        families.append({'reference_asset_id': root, 'to_reference': transforms,
                         'alignment_paths': paths})
    return families
