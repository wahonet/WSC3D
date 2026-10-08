"""Save reviewed native masks and explicit source relationships through the platform API."""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from multiversion_sam import ROOT, OUT, decode, write
from multiversion_commit_alignments import preserve_baseline
from multiversion_context import BASELINE, RUN
from multiversion_publication import publication_fields
from multiversion_pixel_frames import validate_pixel_frame
from multiversion_original_aliases import verified_original_aliases
sys.path.insert(0, str(ROOT / 'tmp/wsc-check-backup'))
from api import call, q


def main(decisions_file=None, manifest_file=None, stones=None):
    preserve_baseline()
    decisions = json.loads((decisions_file or OUT/'native-decisions.json').read_text(encoding='utf-8'))
    manifest = manifest_file or OUT/'native-commits.json'
    records = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {'parents': {}, 'versions': []}
    protected = {a['id'] for a in json.loads(BASELINE.read_text(encoding='utf-8'))['annotations']}
    stone_cache = {}
    checked_parents = set()
    for decision in decisions['accepted']:
        saved = json.loads((OUT/decision['proposal']).read_text(encoding='utf-8'))
        job = saved['job']; target = decision['target_asset_id']; canonical = decision['canonical_annotation_id']
        if stones and job['stone_id'] not in stones:
            continue
        assert job['target_asset_id'] == target and job['canonical_annotation_id'] == canonical
        frame = validate_pixel_frame(job, enrich=True) if job.get('pixel_frame_record') else None
        with Path(job['crop_path']).open('rb') as crop_stream:
            assert hashlib.file_digest(crop_stream, 'sha256').hexdigest() == job['crop_sha256']
        det = saved['result']['detections'][decision['detection_index']]
        binary = decode(det['native_mask'])
        assert hashlib.sha256(binary.tobytes()).hexdigest() == det['native_mask']['binary_sha256']
        assert int(binary.sum()) == det['native_mask']['foreground_pixels']
        with Image.open(job['crop_path']) as native_source:
            assert binary.shape == (native_source.height, native_source.width), 'Native corrections and publication require the inspected source pixel frame'
        ys, xs = np.nonzero(binary)
        assert len(xs) > 0
        if job['stone_id'] not in stone_cache:
            stone_cache[job['stone_id']] = {a['id']: a for a in call('GET', '/stones/'+q(job['stone_id'])+'/annotations')}
        by_id = stone_cache[job['stone_id']]
        source = by_id[canonical]
        assert source['asset_id'] == job['canonical_asset_id']
        assets = {}
        if decision.get('verified_original_alias_ids') or decision.get('source_identity_evidence') is not None:
            stone = next(node for node in call('GET', '/stones') if node['id'] == job['stone_id'])
            assets = {asset['id']: asset for group in stone['groups'] for asset in group['assets']}
        alias_metadata, aliases = verified_original_aliases(decision, job, source, by_id, assets, protected, ROOT)
        display_label = decision.get('display_label', decision.get('label', source['label']))
        assert isinstance(display_label, str) and display_label.strip()
        research_fields = publication_fields(source, decision)
        publication_quality = research_fields['quality']
        publication_geometry_intent = research_fields['geometry_intent']
        existing = next((a for a in by_id.values() if a['asset_id'] == target and
                        a['geometry'].get('image_version', {}).get('canonical_annotation_id') == canonical), None)
        previous_version_id = existing['id'] if existing and decision.get('new_revision') else None
        if previous_version_id is not None:
            existing = None
        if existing:
            assert existing['id'] not in protected, 'Original annotations cannot be repaired by the version publisher'
        def shared_descriptions(original):
            return [{'format': 'wsc-shared-description-reference-1', 'source_annotation_id': original['id'],
                     'reference_id': ref['id'], **{k: ref[k] for k in ('desc_source', 'desc_start', 'desc_end', 'text')},
                     'excerpts': ref.get('excerpts', [])}
                    for ref in original['references'] if ref['kind'] == 'description']
        def add_refs(new_id, original):
            assert new_id not in protected, 'Reference inheritance cannot modify an original annotation'
            current = by_id[new_id]
            originals = [original, *aliases] if original['id'] == canonical else [original]
            shared = [ref for inherited in originals for ref in shared_descriptions(inherited)]
            if shared:
                # A description range remains bound to its original annotation.
                # Native versions reference that exact binding; no duplicate
                # description POST or modification of the original is allowed.
                assert new_id not in protected
                geometry = current['geometry']
                assert geometry['image_version']['canonical_annotation_id'] == original['id']
                if geometry['image_version'].get('inherited_description_references') != shared:
                    geometry['image_version']['inherited_description_references'] = shared
                    note = current['note'] + f"\n共享释文关联保留在原标注{original['id']}，本版本通过同一对象身份引用该原关联，不新增重叠释文区间。"
                    current = call('PATCH', f'/annotations/{new_id}', {'atype': current['atype'], 'geometry': geometry, 'note': note})
            mapped = []
            for ref in [ref for inherited in originals for ref in inherited['references']]:
                if ref['source_missing']:
                    raise ValueError('A missing source cannot acquire a new identity on a different image version')
                if ref['kind'] == 'description':
                    assert current['geometry']['image_version']['inherited_description_references'] == shared
                    continue
                else:
                    body = {'kind': ref['kind'], ref['kind']+'_id': ref[ref['kind']+'_id']}
                def identity(r):
                    return (r['kind'], r.get('segment_id'), r.get('figure_id'), r.get('desc_source'), r.get('desc_start'), r.get('desc_end'))
                match = next((r for r in current['references'] if identity(r) == identity(ref)), None)
                if match is None:
                    current = call('POST', f'/annotations/{new_id}/references', body)
                    match = next(r for r in current['references'] if identity(r) == identity(ref))
                mapped.extend({'reference_id': match['id'], **excerpt} for excerpt in ref.get('excerpts', []))
            mapped = list({json.dumps(excerpt, sort_keys=True): excerpt for excerpt in mapped}.values())
            status = publication_fields(original)['review_status']
            by_id[new_id] = call('PATCH', f'/annotations/{new_id}', {'semantics': original['semantics'], 'review_status': status,
                                                                  'reference_excerpts': mapped})
        def parent_copy(original_id):
            if original_id is None:
                return None
            key = f'{target}:{original_id}'
            if key in records['parents']:
                assert records['parents'][key] in by_id, 'Recorded parent disappeared'
                assert records['parents'][key] not in protected, 'An original node cannot be a new version parent'
                if key not in checked_parents:
                    add_refs(records['parents'][key], by_id[original_id])
                    checked_parents.add(key)
                return records['parents'][key]
            old = by_id[original_id]
            reviewed_parent = next((a for a in by_id.values() if a['asset_id'] == target and
                                    a['level'] == old['level'] and
                                    a['geometry'].get('image_version', {}).get('canonical_annotation_id') == original_id and
                                    a['geometry'].get('image_version', {}).get('native_boundary_reviewed') is True), None)
            if reviewed_parent:
                assert reviewed_parent['id'] not in protected
                records['parents'][key] = reviewed_parent['id']
                write(manifest, records)
                add_refs(reviewed_parent['id'], old)
                checked_parents.add(key)
                return reviewed_parent['id']
            parent = parent_copy(old['parent_id'])
            note = old['note'] + f"\n{job['version_label']}照片的结构节点；对应原图标注{original_id}。本版本场景几何尚待核验。"
            new = call('POST', '/annotations', {'stone_id': job['stone_id'], 'asset_id': target, 'tool': 'annotate',
                'atype': 'none', 'geometry': {}, 'label': old['label'], 'note': note, 'color': old['color'],
                'parent_id': parent, 'level': old['level'], 'category': old['category'], 'seq': old['seq'],
                **publication_fields(old),
                'concept_ids': old['concept_ids'], 'auto_parent': False})
            records['parents'][key] = new['id']; by_id[new['id']] = new
            write(manifest, records)
            add_refs(new['id'], old)
            checked_parents.add(key)
            call('PATCH', f'/annotations/{new["id"]}', {'semantics': old['semantics']})
            return new['id']
        parent_canonical = decision.get('reviewed_story_parent_id', source['parent_id'])
        if parent_canonical != source['parent_id']:
            reviewed_story = by_id[parent_canonical]
            assert source['level'] in ('figure', 'component')
            assert reviewed_story['level'] == 'scene' and reviewed_story['asset_id'] == source['asset_id']
            assert reviewed_story['parent_id'] == source['parent_id'], 'Story must belong to the same original narrative layer'
            assert decision.get('story_parent_evidence'), 'Changed story association requires observed evidence'
        parent = parent_copy(parent_canonical)
        if existing:
            assert existing['geometry']['image_version']['segmentation']['proposal'] == decision['proposal'], 'Review decision changed after import'
            assert existing['geometry']['native_mask'] == det['native_mask'], 'A stored native mask differs from its reviewed artifact'
            if ('display_label' in decision or 'label' in decision) and existing['label'] != display_label:
                call('PATCH', f'/annotations/{existing["id"]}', {'label': display_label})
                records.setdefault('metadata_changes', []).append({'annotation_id': existing['id'],
                    'reason': 'apply-recorded-object-review-scope-label',
                    'before': {'label': existing['label']}, 'after': {'label': display_label}})
                existing['label'] = display_label
                write(manifest, records)
            if alias_metadata and any(existing['geometry']['image_version'].get(key) != value for key, value in alias_metadata.items()):
                before = {key: existing['geometry']['image_version'].get(key) for key in alias_metadata}
                geometry = existing['geometry']
                geometry['image_version'].update(alias_metadata)
                call('PATCH', f'/annotations/{existing["id"]}', {'geometry': geometry})
                records.setdefault('metadata_changes', []).append({'annotation_id': existing['id'],
                    'reason': 'verified-original-source-aliases', 'before': before, 'after': alias_metadata})
                write(manifest, records)
            add_refs(existing['id'], source)
            if existing['quality'] != publication_quality or existing['geometry_intent'] != publication_geometry_intent:
                call('PATCH', f'/annotations/{existing["id"]}', {'quality': publication_quality, 'geometry_intent': publication_geometry_intent})
                records.setdefault('metadata_changes', []).append({'annotation_id': existing['id'],
                    'canonical_annotation_id': canonical, 'reason': 'preserve-canonical-research-fields',
                    'before': {k: existing[k] for k in ('quality', 'geometry_intent')},
                    'after': {k: research_fields[k] for k in ('quality', 'geometry_intent')}})
                write(manifest, records)
            continue
        metadata = {'format': 'wsc-segmentation-version-1', 'canonical_annotation_id': canonical,
            'canonical_asset_id': source['asset_id'], 'source_asset_id': target, 'source_filename': job['source_filename'],
            'source_sha256': job['source_sha256'], 'source_label': job['version_label'], 'native_boundary_reviewed': True,
            'research_run': RUN, 'publication_policy': 'canonical-research-fields-1',
            'segmentation': {'proposal': decision['proposal'], 'detection_index': decision['detection_index'],
                'checkpoint_sha256': saved['weight_sha256'], 'crop_sha256': job['crop_sha256'],
                'work_image_sha256': job['work_image_sha256'], 'native_input_region': job['crop_extent'],
                'request': saved['request'], 'review_evidence': decision['evidence'], 'review_note': decision['visual_note']}}
        metadata.update(alias_metadata)
        if parent_canonical != source['parent_id']:
            metadata['reviewed_story_parent'] = {'canonical_annotation_id': parent_canonical,
                'original_parent_id': source['parent_id'], 'evidence': decision['story_parent_evidence']}
        if previous_version_id is not None:
            metadata['segmentation']['previous_version_id'] = previous_version_id
        if decision.get('review_policy'):
            metadata['segmentation']['review_policy'] = decision['review_policy']
            metadata['segmentation']['micro_boundary_exhaustive'] = False
            metadata['segmentation']['uncertainty_note'] = decision.get('uncertainty_note', '')
            if decision.get('review_scope'):
                metadata['segmentation']['review_scope'] = decision['review_scope']
        shared = [ref for original in [source, *aliases] for ref in shared_descriptions(original)]
        if frame is not None:
            metadata['segmentation']['pixel_frame_record'] = job['pixel_frame_record']
            metadata['segmentation']['pixel_frame'] = {'format': 'wsc-original-pixel-frame-1',
                **{key: frame[key] for key in ('source_sha256', 'frame_index', 'original_size', 'working_size',
                   'working_sha256', 'working_rgb_sha256', 'working_conversion', 'crop_pixels', 'crop_size', 'crop_sha256')}}
        if shared:
            metadata['inherited_description_references'] = shared
        body = {'stone_id': job['stone_id'], 'asset_id': target, 'tool': 'segment',
            'atype': 'polygon', 'geometry': {'points': det['polygon'], 'native_mask': det['native_mask'], 'image_version': metadata},
            'label': display_label, 'note': source['note']+'\n'+decision['visual_note'], 'color': source['color'],
            'parent_id': parent, 'level': source['level'], 'category': source['category'], 'seq': source['seq'],
            **research_fields,
            'concept_ids': source['concept_ids'], 'auto_parent': False}
        if shared:
            body['note'] += f"\n共享释文关联保留在原标注{source['id']}，本版本通过同一对象身份引用该原关联，不新增重叠释文区间。"
        draft_id = records['parents'].get(f'{target}:{canonical}')
        if draft_id is not None and by_id[draft_id]['geometry']:
            previous_parent = by_id[draft_id]
            assert previous_version_id is not None, 'A completed parent needs an explicit new revision'
            assert draft_id not in protected and previous_parent['asset_id'] == target
            assert previous_parent['geometry'].get('image_version', {}).get('canonical_annotation_id') == canonical
            draft_id = None
        if draft_id is not None:
            # Any reviewed parent can acquire native geometry on this run's empty
            # node. Components can precede their figure; child links retain the ID.
            # Original annotations remain protected, and only empty nodes upgrade.
            assert draft_id not in protected and source['level'] in ('whole', 'layer', 'scene', 'figure', 'component', 'band')
            draft = by_id[draft_id]
            assert draft['asset_id'] == target and draft['stone_id'] == job['stone_id']
            assert draft['atype'] == 'none' and draft['geometry'] == {}, 'Only a new empty structure node may be upgraded'
            assert draft['parent_id'] == parent and draft['level'] == source['level']
            new = call('PATCH', f'/annotations/{draft_id}', body)
        else:
            new = call('POST', '/annotations', body)
        by_id[new['id']] = new
        records['versions'].append({'annotation_id': new['id'], 'asset_id': target, 'canonical_annotation_id': canonical,
                                    'source_label': job['version_label'], 'proposal': decision['proposal'],
                                    **({'upgraded_parent': True} if draft_id is not None else {})})
        if source['level'] in ('whole', 'layer', 'scene') or f'{target}:{canonical}' in records['parents']:
            records['parents'][f'{target}:{canonical}'] = new['id']
        write(manifest, records)
        add_refs(new['id'], source)
        verified = call('PATCH', f'/annotations/{new["id"]}', {'semantics': source['semantics'], 'label': display_label,
            'quality': publication_quality, 'geometry_intent': publication_geometry_intent})
        by_id[new['id']] = verified
        assert {r['kind']+':'+str(r.get('segment_id') or r.get('figure_id')) for r in verified['references'] if r['kind'] != 'description'} == {
            r['kind']+':'+str(r.get('segment_id') or r.get('figure_id')) for original in [source, *aliases]
            for r in original['references'] if r['kind'] != 'description'}
        if shared:
            assert verified['geometry']['image_version']['inherited_description_references'] == shared
        assert verified['concept_ids'] == source['concept_ids']
        assert verified['geometry']['native_mask'] == det['native_mask']
        print('Saved native version', new['id'], 'canonical', canonical, 'asset', target, job['version_label'], flush=True)
    records['baseline_preservation'] = preserve_baseline()
    write(manifest, records)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--decisions-file', type=Path)
    parser.add_argument('--manifest-file', type=Path)
    parser.add_argument('--stones', nargs='+')
    options = parser.parse_args()
    main(options.decisions_file, options.manifest_file, options.stones)
