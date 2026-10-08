"""Original source aliases require real accepted evidence and preserved reference bindings."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/research'))
from multiversion_original_aliases import verified_original_aliases


class OriginalAliasTests(unittest.TestCase):
    def fixture(self, root):
        source = {'id': 2972, 'stone_id': '武008', 'asset_id': 811, 'level': 'scene', 'geometry': {}, 'references': []}
        alias = {**source, 'id': 3001, 'asset_id': 806,
                 'references': [{'id': 42, 'kind': 'figure', 'figure_id': 9, 'source_missing': False, 'excerpts': []}]}
        job = {'stone_id': '武008', 'target_asset_id': 806, 'source_sha256': '6' * 64}
        entry = {'stone_id': '武008', 'level': 'scene', 'canonical_annotation_id': 2972,
                 'original_annotation_id': 3001, 'source_sha256': '6' * 64, 'identity_confirmed': True}
        path = root / 'review.json'
        path.write_text(json.dumps({'format': 'wsc-original-alias-review-1', 'status': 'accepted',
                                    'verified_original_aliases': [entry]}), encoding='utf-8')
        evidence = {'format': 'wsc-source-identity-evidence-1', 'status': 'accepted', 'stone_id': '武008', 'level': 'scene',
                    'canonical_annotation_id': 2972, 'source_sha256': '6' * 64, 'verified_original_alias_ids': [3001],
                    'evidence': [{'path': 'review.json', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}]}
        decision = {'verified_original_alias_ids': [3001], 'source_identity_evidence': evidence}
        assets = {811: {'sha256': '5' * 64}, 806: {'sha256': '6' * 64}}
        return decision, job, source, {2972: source, 3001: alias}, assets, {2972, 3001}, root

    def test_accepted_identity_retains_all_original_reference_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory)); before = copy.deepcopy(args)
            metadata, originals = verified_original_aliases(*args)
            self.assertEqual(originals, [args[3][3001]])
            self.assertEqual(metadata['inherited_original_alias_references'],
                             [{'source_annotation_id': 3001, 'references': args[3][3001]['references']}])
            self.assertEqual(args, before, 'Identity verification never changes protected originals')

    def test_mismatched_original_stone_level_sha_and_new_alias_are_rejected(self):
        for field, value in [('stone_id', '武009'), ('level', 'figure'), ('asset_id', 811)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory)); args[3][3001][field] = value
                with self.assertRaisesRegex(ValueError, 'stone, level, or source SHA'):
                    verified_original_aliases(*args)
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory)); args[5].remove(3001)
            with self.assertRaises(ValueError): verified_original_aliases(*args)

    def test_changed_missing_and_unconfirmed_catalogue_evidence_is_rejected(self):
        for kind in ('changed', 'missing', 'unconfirmed'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory)); path = args[-1] / 'review.json'
                if kind == 'changed': path.write_text('{}', encoding='utf-8')
                elif kind == 'missing': path.unlink()
                else:
                    review = json.loads(path.read_text()); review['verified_original_aliases'][0]['identity_confirmed'] = False
                    path.write_text(json.dumps(review), encoding='utf-8')
                    args[0]['source_identity_evidence']['evidence'][0]['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                with self.assertRaises(ValueError): verified_original_aliases(*args)

    def test_unreviewed_or_conflicting_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory)); args[0]['source_identity_evidence']['status'] = 'candidate'
            with self.assertRaises(ValueError): verified_original_aliases(*args)
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            args[3][6005] = {'geometry': {'image_version': {'canonical_annotation_id': 2979, 'verified_original_alias_ids': [3001]}}}
            with self.assertRaisesRegex(ValueError, 'conflicting'): verified_original_aliases(*args)

    def test_legacy_decisions_do_not_infer_aliases(self):
        self.assertEqual(verified_original_aliases({}, {}, {}, {}, {}, set(), ROOT), ({}, []))


if __name__ == '__main__': unittest.main()
