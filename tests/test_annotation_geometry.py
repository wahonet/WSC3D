"""Geometry validation and legacy-data resilience, using only an in-memory DB."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='wsc-geometry-')
os.environ['STONELAB_DATA'] = _temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from app.db import Base, get_db
from app.models import Annotation, Asset, Stone
from app.routers.annotations import router
from app.routers.assets import router as assets_router


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        with Session(self.engine) as db:
            db.add(Stone(id='T1', code='T1', name='fixture', dirname='fixture'))
            db.flush()
            chain = {'s': 1, 'theta_deg': 0, 'tx': 0, 'ty': 0, 'master_asset_id': 1}
            for aid in (1, 2):
                db.add(Asset(id=aid, stone_id='T1', kind='photo', filename=f'{aid}.jpg', relpath=f'{aid}.jpg',
                             width=100, height=100, extra={'align_to_master': chain}))
            db.commit()
        app = FastAPI()
        app.include_router(router, prefix='/api')
        app.include_router(assets_router, prefix='/api')
        def session():
            with Session(self.engine, autoflush=False, expire_on_commit=False) as db:
                yield db
        app.dependency_overrides[get_db] = session
        self.client = TestClient(app)
        self.pin = patch('app.services.resource_versions.pin_asset', return_value=None)
        self.pin_mock = self.pin.start()

    def tearDown(self):
        self.pin.stop()
        self.client.close()
        self.engine.dispose()

    def payload(self, atype='polygon', geometry=None):
        return {'stone_id': 'T1', 'asset_id': 1, 'atype': atype,
                'geometry': geometry if geometry is not None else {'points': [[0, 0], [.5, 0], [0, .5]]}}

    def count(self):
        with Session(self.engine) as db:
            return len(db.scalars(select(Annotation)).all())

    def test_valid_shapes_preserve_measurements_skeletons_and_off_image_coordinates(self):
        shapes = [
            ('polygon', {'points': [[-.1, 0], [1.1, 0], [0, .5]], 'score': .9}),
            ('rect', {'x': -.1, 'y': .2, 'w': 1.2, 'h': .3}),
            ('ellipse', {'cx': .5, 'cy': .5, 'rx': .2, 'ry': .1}),
            ('point', {'p': [.2, .3]}), ('line', {'p1': [0, 0], 'p2': [1, 1]}),
            ('point3d', {'p': [1, 2, 3]}), ('line3d', {'p1': [1, 2, 3], 'p2': [4, 5, 6]}),
            ('none', {}), ('align', {'s': 1, 'theta_deg': 0, 'tx': 0, 'ty': 0, 'rmse_px': 0}),
        ]
        for atype, geometry in shapes:
            with self.subTest(atype=atype):
                response = self.client.post('/api/annotations', json=self.payload(atype, geometry))
                self.assertEqual(response.status_code, 201, response.text)
                self.assertEqual(response.json()['geometry'], geometry)

    def test_invalid_geometry_is_rejected_before_any_record_is_saved(self):
        shapes = [
            ('polygon', {}), ('polygon', {'points': []}), ('polygon', {'points': [[0, 0], [1, 1]]}),
            ('polygon', {'points': [[0, 0], [1, 1], ['bad', 1]]}),
            ('polygon', {'points': [[0, 0], [1, 1], [1, 2, 3]]}),
            ('polygon', {'points': [[0, 0], [1, 1], [True, 0]]}),
            ('rect', {'x': 0, 'y': 0, 'w': -1, 'h': 1}),
            ('ellipse', {'cx': 0, 'cy': 0, 'rx': 0, 'ry': 1}),
            ('point', {'p': [0]}), ('line', {'p1': [0, 1]}), ('point3d', {'p': [0, 1]}),
            ('rect', {'x': float('nan'), 'y': 0, 'w': 1, 'h': 1}),
            ('point', {'p': [float('inf'), 0]}),
        ]
        for atype, geometry in shapes:
            with self.subTest(atype=atype, geometry=geometry):
                response = self.client.post('/api/annotations', content=json.dumps(self.payload(atype, geometry)),
                                            headers={'Content-Type': 'application/json'})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.count(), 0)
        self.pin_mock.assert_not_called()

    def test_invalid_batch_rolls_back_prior_items(self):
        response = self.client.post('/api/annotations/batch', json={'items': [self.payload(), self.payload('polygon', {})]})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.count(), 0)

    def test_invalid_patch_leaves_geometry_and_content_unchanged(self):
        original = self.client.post('/api/annotations', json=self.payload()).json()
        path = f"/api/annotations/{original['id']}"
        for body in [{'atype': 'polygon', 'geometry': {}, 'label': 'must not save'}, {'geometry': {}}, {'atype': 'polygon'}]:
            self.assertEqual(self.client.patch(path, json=body).status_code, 422)
        saved = self.client.get('/api/annotations', params={'asset_id': 1}).json()[0]
        self.assertEqual(saved['label'], original['label'])
        self.assertEqual(saved['geometry'], original['geometry'])
        self.assertEqual(self.client.patch(path, json={'label': 'metadata only'}).status_code, 200)
        self.assertEqual(self.client.patch(path, json={'atype': 'point', 'geometry': {'p': [.4, .5]}}).status_code, 200)

    def test_legacy_bad_record_does_not_break_valid_projection(self):
        valid = self.client.post('/api/annotations', json=self.payload()).json()
        with Session(self.engine) as db:
            bad = Annotation(stone_id='T1', asset_id=1, tool='annotate', atype='polygon', geometry={}, label='legacy')
            db.add(bad); db.flush(); bad_id = bad.id; db.commit()
        result = self.client.get('/api/assets/2/projected')
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual([x['id'] for x in result.json()['items']], [valid['id']])
        self.assertEqual(result.json()['invalid_annotation_ids'], [bad_id])
        self.assertEqual(self.count(), 2, 'Reading must not delete research records')

    def test_invalid_legacy_geometry_cannot_be_adopted(self):
        target = self.client.post('/api/annotations', json=self.payload('none', {})).json()
        with Session(self.engine) as db:
            source = Annotation(stone_id='T1', asset_id=1, tool='annotate', atype='polygon', geometry={}, label='legacy')
            db.add(source); db.flush(); source_id = source.id; db.commit()
        result = self.client.post(f"/api/annotations/{target['id']}/adopt", json={'source_id': source_id})
        self.assertEqual(result.status_code, 422, result.text)
        self.assertEqual(self.count(), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
