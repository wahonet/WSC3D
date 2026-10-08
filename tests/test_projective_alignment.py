"""Exercise native-pixel homography chains and the real transparent preview renderer in isolation."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

_temp = tempfile.TemporaryDirectory(prefix='wsc-projective-')
os.environ['STONELAB_DATA'] = str(Path(_temp.name)/'data')
os.environ['STONELAB_LIBRARY'] = str(Path(_temp.name)/'library')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'src/backend'))

import numpy as np
from PIL import Image
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.db import Base
from app.models import Asset, Annotation, Stone
from app.services import transforms as tf, alignment
from app.services.alignment_preview import ensure_projective_preview


class ProjectiveTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.stone = Stone(id='武901', code='武901', name='测试', dirname='test')
        self.db.add(self.stone)
        self.left = Asset(stone_id='武901', kind='photo', filename='left.png', relpath='left.png', width=1200, height=900)
        self.right = Asset(stone_id='武901', kind='photo', filename='right.png', relpath='right.png', width=1200, height=900)
        self.db.add_all([self.left, self.right]); self.db.commit()
        self.left.extra = {'is_master': True, 'align_to_master': {**tf.identity(), 'master_asset_id': self.left.id}}
        self.h = tf.homography([[.93, -.04, 22], [.03, .95, 17], [.00005, -.00003, 1]])

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def test_mapping_composition_inverse_and_master_rebase(self):
        with patch('app.services.resource_versions.pin_asset'):
            result = alignment.commit_alignment(self.db, '武901', self.left, self.right,
                                                {**self.h, 'rmse_px': .4, 'target_asset_id': self.right.id})
            self.assertFalse(result.warning)
            source = Annotation(stone_id='武901', asset_id=self.right.id, tool='annotate', atype='polygon',
                geometry={'points': [[.1, .2], [.4, .2], [.3, .5]]}, label='真实轮廓')
            self.db.add(source); self.db.commit()
            projection = alignment.project_annotations(self.db, self.left)
            point = projection.items[0].geometry['points'][0]
            np.testing.assert_allclose(point, np.asarray(tf.apply(self.h, 120, 180))/[1200, 900], atol=1e-12)
            before = source.geometry.copy()
            alignment.set_master(self.db, '武901', self.right)
            np.testing.assert_allclose(tf.apply(self.left.chain, *tf.apply(self.h, 333, 222)), [333, 222], atol=1e-9)
            self.assertEqual(source.geometry, before, 'Projection must not rewrite original research geometry')
            self.assertEqual(self.right.chain['s'], 1)
        mixed = tf.compose(self.h, {'s': 1.3, 'theta_deg': 8, 'tx': 11, 'ty': -7})
        p = tf.apply({'s': 1.3, 'theta_deg': 8, 'tx': 11, 'ty': -7}, 155, 288)
        np.testing.assert_allclose(tf.apply(mixed, 155, 288), tf.apply(self.h, *p), atol=1e-10)
        np.testing.assert_allclose(tf.apply(tf.invert(mixed), *tf.apply(mixed, 155, 288)), [155, 288], atol=1e-9)

    def test_invalid_transforms_rejected_before_snapshot_or_write(self):
        bad = [[[1, 0, 0], [0, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0], [-.002, 0, 1]],
               [[-1, 0, 1200], [0, 1, 0], [0, 0, 1]], [[True, 0, 0], [0, 1, 0], [0, 0, 1]],
               [[float('nan'), 0, 0], [0, 1, 0], [0, 0, 1]]]
        with patch('app.services.resource_versions.pin_asset') as pin:
            for h in bad:
                with self.assertRaises(HTTPException):
                    alignment.commit_alignment(self.db, '武901', self.left, self.right, {'model': 'homography', 'homography': h})
            pin.assert_not_called()
        self.assertEqual(self.db.query(Annotation).count(), 0)

    def test_distinct_coordinate_frames_do_not_project(self):
        self.right.extra = {'align_to_master': {**tf.identity(), 'master_asset_id': 999}}
        self.db.add(Annotation(stone_id='武901', asset_id=self.right.id, tool='annotate', atype='point', geometry={'p': [.2, .3]}))
        self.db.commit()
        result = alignment.project_annotations(self.db, self.left)
        self.assertEqual(len(result.items), 0); self.assertEqual(result.skipped_unaligned, 1)

    def test_local_face_registration_does_not_connect_a_multiface_photo(self):
        before = self.left.extra.copy()
        with patch('app.services.resource_versions.pin_asset'):
            result = alignment.commit_alignment(self.db, '武901', self.left, self.right,
                {**self.h, 'target_asset_id': self.right.id, 'local_only': True})
        self.assertIn('局部配准', result.warning)
        self.assertEqual(result.chain_updates, [])
        self.assertEqual(self.left.extra, before)
        self.assertIsNone(self.right.chain)
        self.assertTrue(result.annotation.geometry['local_only'])
        self.db.add(Annotation(stone_id='武901', asset_id=self.right.id, tool='annotate', atype='point', geometry={'p': [.2, .3]}))
        self.db.commit()
        self.assertEqual(alignment.project_annotations(self.db, self.left).items, [])

    def test_render_preserves_original_rgb_and_transparent_margins(self):
        folder = Path(_temp.name)/'fixture'; folder.mkdir(exist_ok=True)
        source = folder/'source.png'; ref = folder/'left.jpg'
        Image.new('RGB', (80, 60), (43, 77, 131)).save(source)
        Image.new('RGB', (100, 80)).save(ref)
        left = SimpleNamespace(id=1, sha256='a', width=100, height=80, relpath='left')
        right = SimpleNamespace(id=2, sha256='b', width=80, height=60, relpath='source')
        with patch('app.services.previews.preview_path', return_value=ref), patch('app.services.previews.ensure_preview',
                side_effect=lambda aid, _: ref if aid == 1 else source):
            out = ensure_projective_preview(left, right, [[1, .05, 8], [.02, 1, 6], [.0003, .0001, 1]])
        with Image.open(out) as image:
            self.assertEqual(image.mode, 'RGBA'); self.assertEqual(image.size, (100, 80))
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            self.assertEqual(image.getpixel((30, 30)), (43, 77, 131, 255))
            self.assertEqual(image.getpixel((98, 78))[3], 0)


if __name__ == '__main__':
    unittest.main()
