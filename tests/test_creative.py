"""Publication, anonymous ownership, rendering and paid-image request boundaries."""
import base64
from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from video_fixtures import SourceFixture
from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.db import get_db
from app.models import Annotation, AnnotationReference
from app.routers import creative, videos, workspace
from app.services import creative_jobs as jobs, creative_render as render, creative_store as store, seedream


class CreativeTests(SourceFixture, unittest.TestCase):
    def setUp(self):
        config = replace(self.setup_sources(), root=self.root)
        self.enterContext(patch.object(store, 'settings', config))
        self.enterContext(patch.object(seedream, 'settings', config))
        self.enterContext(patch.object(workspace, '_sessions', {}))
        self.enterContext(patch.object(creative, '_limits', creative.defaultdict(creative.deque)))
        app = FastAPI()
        app.include_router(workspace.router, prefix='/api')
        app.include_router(creative.router, prefix='/api')
        app.include_router(videos.router, prefix='/api')
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = self.enterContext(TestClient(app))
        self.other = self.enterContext(TestClient(app))
        self.item = store.from_annotations(self.db, [11])
        self.design = render.Design(template='sticker', layers=[render.Layer(material_id=self.item['id'])])
        for key in render.TEMPLATES:
            store.save('templates', {'id': key, 'published': True})

    def publish(self):
        self.item = store.publish(self.item['id'], True)
        return self.item

    def login(self):
        self.client.post('/api/workspace/login', json={'username': 'admin', 'password': '123456'})

    def test_transparent_export_retains_reference_without_reviewing_candidate(self):
        self.assertEqual(self.item['source']['annotation_ids'], [11])
        self.assertEqual(self.item['source']['references'][0]['document_id'], 1)
        with Image.open(store.material_file(self.item)) as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((image.width-1, image.height-1))[3], 0)
            self.assertGreater(image.getpixel((2, 2))[3], 0)
        self.assertEqual(self.db.get(Annotation, 11).review_status, 'candidate')
        self.assertEqual(self.db.query(AnnotationReference).count(), 1)
        self.assertEqual(store.from_annotations(self.db, [11])['id'], self.item['id'])
        self.assertEqual(self.original_bytes, self.image_path.read_bytes())
        with self.assertRaises(ValueError):
            store.from_annotations(self.db, [11, 14])

    def test_only_published_files_visible_and_admin_routes_need_login(self):
        for endpoint in ('materials', 'templates', 'image-settings', 'image-jobs', f'materials/{self.item["id"]}/image'):
            self.assertEqual(self.client.get('/api/creative/admin/' + endpoint).status_code, 401)
        self.assertEqual(self.client.post('/api/creative/admin/annotations', json={'annotation_ids': [11]}).status_code, 401)
        result = self.client.get('/api/creative/catalogue')
        self.assertEqual(result.json()['materials'], [])
        self.assertIn('httponly', result.headers['set-cookie'].lower())
        image_url = '/api/creative/materials/' + self.item['id'] + '/image'
        self.assertEqual(self.client.get(image_url).status_code, 404)
        self.publish()
        self.assertEqual(self.client.get(image_url).status_code, 200)
        public = self.client.get('/api/creative/catalogue').json()['materials'][0]
        self.assertNotIn('snapshot', public)
        self.assertNotIn(str(self.root), json.dumps(public))
        store.publish(self.item['id'], False)
        self.assertEqual(self.client.get(image_url).status_code, 404)
        self.assertEqual(self.client.get('/api/creative/materials/../../config/creative.json').status_code, 404)

    def test_preview_is_free_and_does_not_create_work_or_call_models(self):
        self.publish()
        with patch.object(seedream, 'generate') as external:
            result = self.client.post('/api/creative/preview', json=self.design.model_dump(mode='json'))
            self.assertEqual(result.status_code, 200, result.text)
            self.assertTrue(result.json()['image'].startswith('data:image/png;base64,'))
            self.assertEqual(store.records('works'), [])
            external.assert_not_called()
        self.assertEqual(self.client.post('/api/creative/preview', json=self.design.model_dump(mode='json'), headers={'Origin': 'https://elsewhere.test'}).status_code, 403)
        invalid = {**self.design.model_dump(mode='json'), 'layers': [{'material_id': self.item['id'], 'scale': 100}]}
        self.assertEqual(self.client.post('/api/creative/preview', json=invalid).status_code, 422)
        store.publish(self.item['id'], False)
        self.assertEqual(self.client.post('/api/creative/preview', json=self.design.model_dump(mode='json')).status_code, 400)

    def test_unpublished_sample_does_not_leak_through_template_cover(self):
        self.publish()
        self.login()
        path = '/api/creative/admin/templates/sticker'
        body = {'published': True, 'design': self.design.model_dump(mode='json')}
        self.assertEqual(self.client.patch(path, json=body).status_code, 200)
        self.assertEqual(self.other.get('/api/creative/templates/sticker/cover').status_code, 200)
        store.publish(self.item['id'], False)
        template = next(t for t in self.other.get('/api/creative/catalogue').json()['templates'] if t['id'] == 'sticker')
        self.assertNotIn('design', template)
        self.assertIsNone(template['cover_url'])
        self.assertEqual(self.other.get('/api/creative/templates/sticker/cover').status_code, 404)
        self.assertEqual(self.client.patch(path, json={'published': True}).status_code, 400)

    def make_work(self):
        self.publish()
        self.client.get('/api/creative/catalogue')
        with patch.object(jobs.threading, 'Thread'):
            response = self.client.post('/api/creative/works', json={'request_id': str(uuid4()), 'design': self.design.model_dump(mode='json')})
        self.assertEqual(response.status_code, 202, response.text)
        item = store.get('works', response.json()['id'])
        jobs._worker(item, self.design, [self.item])
        return store.get('works', item['id'])

    def test_private_exports_explicit_share_and_revocation(self):
        item = self.make_work()
        path = '/api/creative/works/' + item['id']
        self.assertEqual(self.client.get(path+'/image').status_code, 200)
        self.assertEqual(self.other.get(path).status_code, 404)
        self.assertEqual(self.other.get(path+'/image').status_code, 404)
        shared = self.client.post(path+'/share', json={'enabled': True}).json()
        token = shared['share']
        self.assertEqual(self.other.get('/api/creative/share/'+token).status_code, 200)
        self.assertEqual(self.other.get('/api/creative/share/'+token+'/image').status_code, 200)
        self.assertNotIn('owner', self.other.get('/api/creative/share/'+token).json())
        store.publish(self.item['id'], False)
        self.assertEqual(self.other.get('/api/creative/share/'+token).status_code, 404)
        self.assertEqual(self.client.get(path+'/image').status_code, 200)
        self.publish()
        self.client.post(path+'/share', json={'enabled': False})
        self.assertEqual(self.other.get('/api/creative/share/'+token+'/image').status_code, 404)

    def test_export_idempotence_checks_owner_and_design(self):
        item = self.make_work()
        self.assertEqual(jobs.create(item['id'], item['owner'], self.design)['id'], item['id'])
        with self.assertRaises(ValueError):
            jobs.create(item['id'], 'another-owner', self.design)
        with self.assertRaises(ValueError):
            jobs.create(item['id'], item['owner'], self.design.model_copy(update={'title': 'another'}))
        self.assertEqual(len(store.records('works')), 1)

    def test_png_templates_dimensions_and_transparent_sticker(self):
        self.publish()
        for key, template in render.TEMPLATES.items():
            design = self.design.model_copy(update={'template': key})
            image, video = render.composition(design)
            self.assertEqual(image.size, (template['width'], template['height']))
            self.assertEqual(image.getpixel((0, 0))[3], 0 if key == 'sticker' else 255)
            self.assertIsNone(video)

    def test_video_composite_is_five_seconds_with_overlaid_motif(self):
        import cv2
        import imageio_ffmpeg
        self.publish()
        video = store.add_image(Image.new('RGB', (480, 320), '#dc2828'), '行旅', origin='video')
        video.update(kind='video', published=True)
        store.save('materials', video)
        dest = store.folder('materials', video['id'])/'video.mp4'
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'color=c=0xdc2828:s=480x320:r=24', '-t', '5', '-c:v', 'libx264', '-threads', '1', str(dest)],
                       check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        design = self.design.model_copy(update={'template': 'postcard', 'layers': [render.Layer(material_id=video['id']), render.Layer(material_id=self.item['id'], x=50, y=50, scale=.3)]})
        frame, region = render.composition(design, omit_video=True)
        self.assertEqual(frame.getpixel((region['x']+10, region['y']+10))[3], 0)
        target = self.root/'video-export'
        result = render.export(design, target, [video, self.item])
        self.assertEqual(result['duration'], 5)
        capture = cv2.VideoCapture(str(target/'video.mp4'))
        self.assertAlmostEqual(capture.get(cv2.CAP_PROP_FRAME_COUNT)/capture.get(cv2.CAP_PROP_FPS), 5, places=2)
        ok, frame = capture.read(); capture.release()
        self.assertTrue(ok)
        b,g,r = map(int, frame[region['y']+30, region['x']+30])
        self.assertGreater(r, g+100)
        # A PNG motif remains in front of the video, just like the preview.
        b,g,r = map(int, frame[510, 675])
        self.assertGreater(b, r)

    def test_seedream_key_encrypted_and_paid_request_is_one_output(self):
        self.login()
        response = self.client.put('/api/creative/admin/image-settings', json={'api_key': 'test-ark-key'})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('test-ark-key', seedream.config_path().read_text('utf-8'))
        self.assertNotIn('key_ciphertext', response.text)
        output = BytesIO(); Image.new('RGB', (512, 512), '#70b5a0').save(output, 'PNG')
        reply = Mock(status_code=200)
        reply.iter_content.return_value = [json.dumps({'data': [{'b64_json': base64.b64encode(output.getvalue()).decode()}], 'usage': {'generated_images': 1}}).encode()]
        session = Mock(); session.post.return_value = reply
        factory = Mock(); factory.return_value.__enter__ = Mock(return_value=session); factory.return_value.__exit__ = Mock(return_value=False)
        with patch.object(seedream.requests, 'Session', factory):
            image, _ = seedream.generate('测试画面', self.original_bytes)
        self.assertEqual(image.size, (512, 512))
        self.assertEqual(session.post.call_count, 1)
        args, kwargs = session.post.call_args
        self.assertEqual(args[0], seedream.ENDPOINT)
        body = kwargs['json']
        self.assertEqual(body['model'], 'doubao-seedream-5-0-260128')
        self.assertEqual(body['sequential_image_generation'], 'disabled')
        self.assertEqual(body['size'], '2K')
        self.assertTrue(body['image'].startswith('data:image/jpeg;base64,'))
        self.assertFalse(kwargs['allow_redirects'])

    def test_seedream_idempotence_and_restart_never_repost(self):
        seedream.save_settings('test-key')
        identifier = str(uuid4())
        with patch.object(seedream.threading, 'Thread') as thread:
            first = seedream.create(identifier, self.item['id'])
            self.assertEqual(seedream.create(identifier, self.item['id'])['id'], first['id'])
            self.assertEqual(thread.call_count, 1)
            with self.assertRaises(ValueError):
                seedream.create(identifier, self.item['id'], 'night')
            seedream.recover()
            self.assertEqual(seedream.create(identifier, self.item['id'])['status'], 'interrupted')
            self.assertEqual(thread.call_count, 1)
        self.login()
        for extra in ({'model': 'another'}, {'size': '4K'}, {'count': 4}, {'api_base': 'https://elsewhere.test'}):
            self.assertEqual(self.client.post('/api/creative/admin/image-jobs', json={'request_id': str(uuid4()), **extra}).status_code, 422)

    def test_live_annotation_image_preview_does_not_import_or_pay(self):
        path = '/api/creative/admin/image-prepare'
        self.assertEqual(self.client.post(path, json={'annotation_ids': [11]}).status_code, 401)
        self.assertEqual(self.client.get('/api/videos/source-annotations').status_code, 401)
        self.login()
        self.figure.label = '新标注的乐人'
        self.figure.review_status = 'reviewed'
        self.db.commit()
        records_before = store.records('materials')
        with patch.object(seedream, 'generate') as paid:
            result = self.client.get('/api/videos/source-annotations', params={'q': '新标注', 'limit': 24})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()['items'][0]['label'], '新标注的乐人')
            self.assertEqual(result.headers['Cache-Control'], 'no-store')
            result = self.client.post(path, json={'annotation_ids': [11], 'style': 'paper'})
            self.assertEqual(result.status_code, 200, result.text)
            data = result.json()
            for text in ('新标注的乐人', '一人席地抚琴', '宴饮中的奏乐场景', '双手拨弦', '第 7 页'):
                self.assertIn(text, data['prompt'])
            self.assertEqual(data['source']['annotation_ids'], [11])
            self.assertEqual(self.client.get(data['image_url']).status_code, 200)
            self.assertEqual(self.other.get(data['image_url']).status_code, 401)
            self.assertEqual(self.client.post(path, json={'annotation_ids': [11, 14]}).status_code, 400)
            self.assertEqual(self.client.post(path, json={'annotation_ids': [10]}).status_code, 400)
            self.assertEqual(self.client.get('/api/videos/source-annotations?limit=10000').status_code, 422)
            paid.assert_not_called()
        self.assertEqual(store.records('materials'), records_before)
        self.assertEqual(store.records('image_jobs'), [])
        self.assertEqual(self.figure.review_status, 'reviewed')
        self.figure.semantics = {'pre_iconographic': '新保存的姿态描述'}
        self.db.commit()
        next_preview = self.client.post(path, json={'annotation_ids': [11]}).json()
        self.assertNotEqual(next_preview['id'], data['id'])
        self.assertIn('新保存的姿态描述', next_preview['prompt'])
        self.assertNotIn('新保存的姿态描述', seedream.load_source(data['id'])['prompt'])

    def test_image_request_uses_preview_snapshot_and_persists_book_provenance(self):
        self.login()
        data = self.client.post('/api/creative/admin/image-prepare', json={'annotation_ids': [11]}).json()
        seedream.save_settings('test-key')
        body = {'request_id': str(uuid4()), 'source_id': data['id'], 'style': 'paper'}
        self.figure.label = '后续修改的名称'
        self.db.commit()
        with patch.object(seedream.threading, 'Thread') as worker:
            result = self.client.post('/api/creative/admin/image-jobs', json=body)
            self.assertEqual(result.status_code, 202, result.text)
            self.assertEqual(self.client.post('/api/creative/admin/image-jobs', json=body).json()['id'], body['request_id'])
            self.assertEqual(worker.call_count, 1)
            record = result.json()
        with patch.object(seedream, 'generate', return_value=(Image.new('RGB', (256, 256)), {})) as paid:
            seedream._worker(record, seedream.load_source(data['id'])['item'])
            self.assertEqual(paid.call_count, 1)
            self.assertEqual(paid.call_args.args[0], data['prompt'])
            self.assertEqual(paid.call_args.args[1], (seedream.source_dir(data['id']) / 'base.jpg').read_bytes())
        image = store.get('materials', store.get('image_jobs', body['request_id'])['result_id'])
        self.assertEqual(image['source']['annotation_ids'], [11])
        self.assertEqual(image['source']['references'][0]['page_no'], 7)
        self.assertFalse(image['published'])
        self.assertIn('抚琴者', image['title'])
        self.assertNotIn('后续修改', image['title'])
        conflict = {**body, 'material_id': self.item['id']}
        self.assertEqual(self.client.post('/api/creative/admin/image-jobs', json=conflict).status_code, 422)
        with self.assertRaisesRegex(ValueError, '画风'):
            seedream.create(uuid4(), style='night', source_id=data['id'])

    def test_tampered_image_preview_cannot_be_submitted(self):
        data = seedream.prepare(self.db, [11])
        (seedream.source_dir(data['id']) / 'base.jpg').write_bytes(b'tampered')
        with patch.object(seedream, 'generate') as paid, self.assertRaisesRegex(ValueError, '失效'):
            seedream.create(uuid4(), source_id=data['id'])
        paid.assert_not_called()


if __name__ == '__main__':
    unittest.main()
