"""Verify explicit original-record identity without modifying protected rows."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


def verified_original_aliases(decision, job, source, by_id, assets, protected, root):
    """Return publication metadata and protected originals after checking real evidence."""
    ids = decision.get('verified_original_alias_ids', [])
    evidence = decision.get('source_identity_evidence')
    if not ids and evidence is None:
        return {}, []
    if (not isinstance(ids, list) or not ids or
            any(type(ident) is not int or ident <= 0 or ident == source['id'] for ident in ids) or len(set(ids)) != len(ids)):
        raise ValueError('Original aliases must be unique, positive, non-canonical original IDs')
    expected = {'format': 'wsc-source-identity-evidence-1', 'status': 'accepted',
                'stone_id': job['stone_id'], 'level': source['level'],
                'canonical_annotation_id': source['id'], 'source_sha256': job['source_sha256'],
                'verified_original_alias_ids': ids}
    if not isinstance(evidence, dict) or any(evidence.get(key) != value for key, value in expected.items()):
        raise ValueError('Original alias evidence does not match this accepted source identity')
    entries = evidence.get('evidence')
    if not isinstance(entries, list) or not entries:
        raise ValueError('Original alias identity requires fingerprinted review evidence')
    confirmations = []
    root = Path(root).resolve()
    for entry in entries:
        if (not isinstance(entry, dict) or not isinstance(entry.get('path'), str) or
                not re.fullmatch(r'[a-f0-9]{64}', str(entry.get('sha256', '')))):
            raise ValueError('Invalid alias review evidence fingerprint')
        path = (root / entry['path']).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('Alias review evidence must be an existing workspace file')
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                raise ValueError('Alias review evidence changed after acceptance')
        review = json.loads(path.read_text(encoding='utf-8'))
        if review.get('format') != 'wsc-original-alias-review-1' or review.get('status') != 'accepted':
            raise ValueError('Alias review evidence has not explicitly accepted original identity')
        confirmations.extend(review.get('verified_original_aliases', []))
    originals = []
    target = assets.get(job['target_asset_id'])
    if not target or target.get('sha256') != job['source_sha256']:
        raise ValueError('Native version source SHA differs from the real asset')
    if source['id'] not in protected:
        raise ValueError('Alias canonical identity must be a protected original')
    for ident in ids:
        original = by_id.get(ident)
        asset = assets.get(original['asset_id']) if original else None
        if (ident not in protected or not original or original.get('geometry', {}).get('image_version') or
                original['stone_id'] != job['stone_id'] or original['level'] != source['level'] or
                not asset or asset.get('sha256') != job['source_sha256']):
            raise ValueError('Original alias differs in protected identity, stone, level, or source SHA')
        required = {'stone_id': job['stone_id'], 'level': source['level'],
                    'canonical_annotation_id': source['id'], 'original_annotation_id': ident,
                    'source_sha256': job['source_sha256'], 'identity_confirmed': True}
        if not any(isinstance(row, dict) and row.get('identity_confirmed') is True and
                   all(row.get(key) == value for key, value in required.items())
                   for row in confirmations):
            raise ValueError('The accepted catalogue review does not confirm this original alias')
        for row in by_id.values():
            version = row.get('geometry', {}).get('image_version', {})
            if ident in version.get('verified_original_alias_ids', []) and version.get('canonical_annotation_id') != source['id']:
                raise ValueError('An original alias already claims a conflicting canonical identity')
        if any(ref.get('source_missing') for ref in original['references']):
            raise ValueError('A missing alias reference source cannot acquire a new binding')
        originals.append(original)
    return {'verified_original_alias_ids': ids, 'source_identity_evidence': evidence,
            'inherited_original_alias_references': [
                {'source_annotation_id': original['id'], 'references': original['references']}
                for original in originals]}, originals
