"""Research metadata and task paths must survive native-version publication."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/research'))
from multiversion_context import DEFAULT_OUT, DEFAULT_WORK
from multiversion_publication import publication_fields
import multiversion_commit_masks as publisher


class PublicationPolicyTests(unittest.TestCase):
    def test_native_boundary_acceptance_preserves_weak_semantic_scope(self):
        source = {'quality': 'weak', 'geometry_intent': 'semantic_extent', 'review_status': 'candidate'}
        self.assertEqual(publication_fields(source), source)
        for field, promotion in (('publication_quality', 'gold'), ('publication_geometry_intent', 'visible_trace')):
            with self.subTest(field=field), self.assertRaises(ValueError):
                publication_fields(source, {field: promotion})

    def test_expert_approval_is_not_inherited_by_a_new_version(self):
        self.assertEqual(publication_fields({'quality': 'silver', 'geometry_intent': '', 'review_status': 'approved'}),
                         {'quality': 'silver', 'geometry_intent': '', 'review_status': 'reviewed'})
        self.assertEqual(publication_fields({'quality': '', 'geometry_intent': '', 'review_status': 'unreviewed'}),
                         {'quality': '', 'geometry_intent': '', 'review_status': 'candidate'})


class TaskContextTests(unittest.TestCase):
    def context(self, updates):
        env = {key: value for key, value in os.environ.items() if not key.startswith('WSC_RESEARCH_')}
        env.update(updates)
        result = subprocess.run([sys.executable, '-B', '-c',
            "import json,sys;sys.path.insert(0,'tools/research');import multiversion_context as c;"
            "print(json.dumps([str(c.OUT),str(c.WORK),str(c.BASELINE),c.RUN,sorted(c.REVIEWED_RUNS)]))"],
            cwd=ROOT, env=env, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_historical_defaults_and_independent_original_baseline(self):
        defaults = self.context({})
        self.assertEqual(Path(defaults[0]), DEFAULT_OUT)
        self.assertEqual(Path(defaults[1]), DEFAULT_WORK)
        configured = self.context({'WSC_RESEARCH_OUT': 'resources/authoring/research/rear46-execution-20261003',
                                   'WSC_RESEARCH_WORK': 'tmp/wsc-rear46-20261003'})
        self.assertEqual(Path(configured[0]), ROOT / 'resources/authoring/research/rear46-execution-20261003')
        self.assertEqual(Path(configured[1]), ROOT / 'tmp/wsc-rear46-20261003')
        self.assertEqual(configured[2], defaults[2])
        self.assertEqual(configured[3], 'rear46-execution-20261003')
        self.assertEqual(set(configured[4]), {'multiversion-20261002', 'rear46-execution-20261003'})

    def test_publisher_help_never_reads_or_imports_decisions(self):
        # The output path has no baseline/decision files. An importer entered
        # before argument parsing would fail here (and could write to live data).
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'WSC_RESEARCH_OUT': directory, 'WSC_RESEARCH_BASELINE': directory + '/missing.json'}
            for name in ('multiversion_commit_masks.py', 'multiversion_commit_alignments.py'):
                result = subprocess.run([sys.executable, '-B', str(ROOT / 'tools/research' / name), '--help'],
                                        cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('usage:', result.stdout)
                self.assertEqual(list(Path(directory).iterdir()), [])


class PublisherRequestTests(unittest.TestCase):
    def fixture(self, directory, original_frame=False):
        output = Path(directory)
        crop = output / 'crop.png'
        Image.new('RGB', (2, 2), '#887766').save(crop)
        source = {'id': 151, 'asset_id': 1, 'stone_id': '武008', 'label': '人物', 'note': '', 'color': '#cc0000',
                  'parent_id': None, 'level': 'figure', 'category': 'figure', 'seq': 1, 'references': [],
                  'semantics': {}, 'concept_ids': [12], 'quality': 'weak', 'geometry_intent': 'semantic_extent',
                  'review_status': 'candidate', 'geometry': {}}
        job = {'stone_id': '武008', 'canonical_annotation_id': 151, 'canonical_asset_id': 1,
               'target_asset_id': 2, 'crop_path': str(crop), 'crop_sha256': hashlib.sha256(crop.read_bytes()).hexdigest(),
               'crop_extent': [0, 0, 1, 1], 'source_filename': 'source.png', 'source_sha256': 'b' * 64,
               'work_image_sha256': 'c' * 64, 'version_label': '来源未注明'}
        binary = np.ones((2, 2), np.uint8)
        mask = {'size': [2, 2], 'counts': [0, 4], 'extent': [0, 0, 1, 1], 'foreground_pixels': 4,
                'binary_sha256': hashlib.sha256(binary.tobytes()).hexdigest()}
        saved = {'job': job, 'result': {'detections': [{'native_mask': mask, 'polygon': [[0, 0], [1, 0], [1, 1]]}]},
                 'request': {}, 'weight_sha256': None}
        decision = {'proposal': 'proposal.json', 'target_asset_id': 2, 'canonical_annotation_id': 151,
                    'detection_index': 0, 'evidence': ['evidence.png'], 'visual_note': '本源边界已复核'}
        if original_frame:
            job['source_sha256'] = job['work_image_sha256'] = job['crop_sha256']
            job['pixel_frame_record'] = str(output / 'frame.json')
            frame = {'source_file': str(crop), 'source_sha256': job['source_sha256'], 'frame_index': 0, 'frame_count': 1,
                     'original_size': [2, 2], 'working_size': [2, 2], 'working_path': str(crop),
                     'working_sha256': job['work_image_sha256'], 'working_conversion': 'Pillow RGB decode; no resize',
                     'crop_path': str(crop), 'crop_pixels': [0, 0, 2, 2], 'crop_size': [2, 2], 'crop_sha256': job['crop_sha256']}
            (output / 'frame.json').write_text(json.dumps(frame), encoding='utf-8')
        (output / 'proposal.json').write_text(json.dumps(saved), encoding='utf-8')
        (output / 'baseline.json').write_text(json.dumps({'annotations': [source]}), encoding='utf-8')
        (output / 'native-decisions.json').write_text(json.dumps({'accepted': [decision]}), encoding='utf-8')
        return output, source, saved, decision

    def test_initial_create_request_already_has_preserved_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            output, source, _, _ = self.fixture(directory)
            rows = [source]
            creates = []

            def call(method, path, body=None):
                if method == 'GET':
                    return rows
                if method == 'POST':
                    creates.append(body)
                    row = {**body, 'id': 9000, 'references': []}
                    rows.append(row)
                    return row
                row = rows[-1]
                row.update(body)
                return row

            with mock.patch.object(publisher, 'OUT', output), mock.patch.object(publisher, 'BASELINE', output / 'baseline.json'), \
                 mock.patch.object(publisher, 'preserve_baseline', return_value={'issues': []}), mock.patch.object(publisher, 'call', call):
                publisher.main()
            self.assertEqual(len(creates), 1)
            self.assertEqual({key: creates[0][key] for key in ('quality', 'geometry_intent', 'review_status')},
                             publication_fields(source))
            self.assertEqual(creates[0]['geometry']['image_version']['publication_policy'], 'canonical-research-fields-1')

    def test_original_frame_metadata_is_verified_and_published_with_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            output, source, saved, _ = self.fixture(directory, original_frame=True)
            rows, creates = [source], []
            def call(method, path, body=None):
                if method == 'GET': return rows
                if method == 'POST':
                    creates.append(body); rows.append({**body, 'id': 9000, 'references': []})
                else: rows[-1].update(body)
                return rows[-1]
            with mock.patch.object(publisher, 'OUT', output), mock.patch.object(publisher, 'BASELINE', output / 'baseline.json'), \
                 mock.patch.object(publisher, 'preserve_baseline', return_value={'issues': []}), mock.patch.object(publisher, 'call', call):
                publisher.main()
            segmentation = creates[0]['geometry']['image_version']['segmentation']
            self.assertEqual(segmentation['pixel_frame_record'], saved['job']['pixel_frame_record'])
            self.assertEqual(segmentation['pixel_frame']['format'], 'wsc-original-pixel-frame-1')
            self.assertEqual(segmentation['pixel_frame']['working_sha256'], saved['job']['work_image_sha256'])
            self.assertEqual(segmentation['pixel_frame']['crop_size'], [2, 2])
            self.assertNotIn('source_file', segmentation['pixel_frame'])

    def test_bad_original_frame_cannot_create_any_parent_or_version(self):
        with tempfile.TemporaryDirectory() as directory:
            output, source, saved, _ = self.fixture(directory, original_frame=True)
            frame_path = Path(saved['job']['pixel_frame_record'])
            frame = json.loads(frame_path.read_text(encoding='utf-8')); frame['working_sha256'] = '0' * 64
            frame_path.write_text(json.dumps(frame), encoding='utf-8')
            with mock.patch.object(publisher, 'OUT', output), mock.patch.object(publisher, 'BASELINE', output / 'baseline.json'), \
                 mock.patch.object(publisher, 'preserve_baseline', return_value={'issues': []}), mock.patch.object(publisher, 'call') as call, \
                 self.assertRaises(ValueError):
                publisher.main()
            call.assert_not_called()

    def test_verified_alias_references_are_inherited_without_writing_original_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            output, source, saved, decision = self.fixture(directory)
            alias = {**source, 'id': 152, 'asset_id': 2,
                     'references': [{'id': 42, 'kind': 'figure', 'figure_id': 9, 'source_missing': False, 'excerpts': []}]}
            accepted = {'stone_id': '武008', 'level': source['level'], 'canonical_annotation_id': 151,
                        'original_annotation_id': 152, 'source_sha256': saved['job']['source_sha256'], 'identity_confirmed': True}
            evidence_file = output / 'alias-review.json'
            evidence_file.write_text(json.dumps({'format': 'wsc-original-alias-review-1', 'status': 'accepted',
                                                 'verified_original_aliases': [accepted]}), encoding='utf-8')
            decision['verified_original_alias_ids'] = [152]
            decision['source_identity_evidence'] = {'format': 'wsc-source-identity-evidence-1', 'status': 'accepted',
                'stone_id': '武008', 'level': source['level'], 'canonical_annotation_id': 151,
                'source_sha256': saved['job']['source_sha256'], 'verified_original_alias_ids': [152],
                'evidence': [{'path': 'alias-review.json', 'sha256': hashlib.sha256(evidence_file.read_bytes()).hexdigest()}]}
            (output / 'native-decisions.json').write_text(json.dumps({'accepted': [decision]}), encoding='utf-8')
            (output / 'baseline.json').write_text(json.dumps({'annotations': [source, alias]}), encoding='utf-8')
            rows, writes = [source, alias], []
            original_before = json.dumps(rows, sort_keys=True)
            def call(method, path, body=None):
                if method == 'GET':
                    if path == '/stones':
                        return [{'id': '武008', 'groups': [{'assets': [{'id': 2, 'sha256': saved['job']['source_sha256']}]}]}]
                    return rows
                writes.append((method, path))
                if method == 'POST' and path == '/annotations':
                    rows.append({**body, 'id': 9000, 'references': []})
                elif method == 'POST':
                    rows[-1]['references'].append({**body, 'id': 100, 'source_missing': False, 'excerpts': []})
                else: rows[-1].update(body)
                return rows[-1]
            with mock.patch.object(publisher, 'ROOT', output), mock.patch.object(publisher, 'OUT', output), \
                 mock.patch.object(publisher, 'BASELINE', output / 'baseline.json'), \
                 mock.patch.object(publisher, 'preserve_baseline', return_value={'issues': []}), mock.patch.object(publisher, 'call', call):
                publisher.main()
            self.assertEqual(json.dumps(rows[:2], sort_keys=True), original_before)
            self.assertTrue(all(path == '/annotations' or path.startswith('/annotations/9000') for _, path in writes))
            self.assertEqual(rows[-1]['references'][0]['figure_id'], 9)
            version = rows[-1]['geometry']['image_version']
            self.assertEqual(version['verified_original_alias_ids'], [152])
            self.assertEqual(version['inherited_original_alias_references'][0]['references'], alias['references'])

    def test_rejected_alias_cannot_create_a_parent_or_version(self):
        with tempfile.TemporaryDirectory() as directory:
            output, source, saved, decision = self.fixture(directory)
            decision['verified_original_alias_ids'] = [152]
            decision['source_identity_evidence'] = {'status': 'candidate'}
            (output / 'native-decisions.json').write_text(json.dumps({'accepted': [decision]}), encoding='utf-8')
            def call(method, path, body=None):
                self.assertEqual(method, 'GET', 'Rejected alias must not write any record')
                return [{'id': '武008', 'groups': []}] if path == '/stones' else [source]
            with mock.patch.object(publisher, 'OUT', output), mock.patch.object(publisher, 'BASELINE', output / 'baseline.json'), \
                 mock.patch.object(publisher, 'preserve_baseline', return_value={'issues': []}), mock.patch.object(publisher, 'call', call), \
                 self.assertRaises(ValueError):
                publisher.main()

    def test_existing_original_id_cannot_be_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            output, source, saved, decision = self.fixture(directory)
            original = {**source, 'id': 152, 'asset_id': 2, 'geometry': {'native_mask': saved['result']['detections'][0]['native_mask'],
                        'image_version': {'canonical_annotation_id': 151, 'segmentation': {'proposal': decision['proposal']}}}}
            (output / 'baseline.json').write_text(json.dumps({'annotations': [source, original]}), encoding='utf-8')
            calls = []

            def call(method, path, body=None):
                calls.append(method)
                return [source, original]

            with mock.patch.object(publisher, 'OUT', output), mock.patch.object(publisher, 'BASELINE', output / 'baseline.json'), \
                 mock.patch.object(publisher, 'preserve_baseline', return_value={'issues': []}), mock.patch.object(publisher, 'call', call), \
                 self.assertRaisesRegex(AssertionError, 'Original annotations'):
                publisher.main()
            self.assertEqual(calls, ['GET'])


if __name__ == '__main__':
    unittest.main()
