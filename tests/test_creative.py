"""Theme production, visitor take-away, stamps and printing boundaries."""
import base64
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import subprocess
import time
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from video_fixtures import SourceFixture
from PIL import Image, ImageDraw
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.db import get_db
from app.models import Annotation, AnnotationReference
from app.routers import creative, workspace
from app.services import (creative_jobs as jobs, creative_render as render, creative_store as store,
                          creative_themes as themes, model_gateway, seedream)

THEME = 'yinyue'
STORY = '乐人跽坐席上，双手拨弦，宾主举杯。' * 7
REFS = [{'document_id': 1, 'document_title': '画像研究试验册', 'page_no': 7, 'text': '乐人跽坐，双手拨弦。'}]


def line_drawing(size=(1024, 768)):
    image = Image.new('RGB', size, 'white')
    draw = ImageDraw.Draw(image)
    draw.ellipse((300, 120, 520, 340), outline='black', width=8)
    draw.line((410, 340, 410, 620), fill='black', width=8)
    draw.line((250, 450, 580, 420), fill='black', width=8)
    draw.rectangle((620, 380, 900, 560), outline='black', width=8)
    return image


def painting(size=(1024, 768)):
    image = Image.new('RGB', size, '#e9dcc0')
    draw = ImageDraw.Draw(image)
    draw.ellipse((300, 120, 520, 340), fill='#b8332a')
    draw.rectangle((620, 380, 900, 560), fill='#2e6b5e')
    return image


class CreativeTests(SourceFixture, unittest.TestCase):
    def setUp(self):
        config = replace(self.setup_sources(), root=self.root)
        for module in (store, seedream, themes):
            self.enterContext(patch.object(module, 'settings', config))
        self.enterContext(patch.object(themes, 'lan_address', return_value='10.0.0.8'))
        # Background refreshes would outlive the temporary folders.
        self.enterContext(patch.object(themes, 'refresh_later'))
        self.enterContext(patch.object(jobs, '_start'))
        self.enterContext(patch.object(jobs, '_queue', jobs.queue.Queue()))
        self.enterContext(patch.object(workspace, '_sessions', {}))
        self.enterContext(patch.object(creative, '_limits', creative.defaultdict(creative.deque)))
        app = FastAPI()
        app.include_router(workspace.router, prefix='/api')
        app.include_router(creative.router, prefix='/api')
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = self.enterContext(TestClient(app))
        self.other = self.enterContext(TestClient(app))
        self.admin = self.enterContext(TestClient(app))
        self.admin.post('/api/workspace/login', json={'username': 'admin', 'password': '123456'})

    # ------------------------------------------------------------ helpers

    def api(self, method, path, expect=200, **kwargs):
        response = getattr(self.admin, method)('/api/creative/admin' + path, **kwargs)
        self.assertEqual(response.status_code, expect, response.text)
        return response.json()

    def wait_job(self, identifier):
        for _ in range(200):
            job = store.get('image_jobs', identifier)
            if job['status'] != 'running' and identifier not in themes._threads:
                return job
            time.sleep(.05)
        self.fail('生图任务未结束')

    def candidates(self, role, image, style=None, count=1):
        identifier = str(uuid4())
        with patch.object(seedream, 'generate', return_value=(image, {'generated_images': 1})) as paid:
            job = self.api('post', f'/themes/{THEME}/candidates', 202,
                           json={'request_id': identifier, 'role': role, 'style': style, 'count': count})
            job = self.wait_job(job['id'])
        self.assertEqual(job['status'], 'succeeded', job.get('error'))
        self.assertEqual(paid.call_count, count)
        return job, paid

    def build(self, publish=True):
        """A theme taken through every step with mocked paid requests."""
        self.api('post', '/themes', json={'id': THEME, 'title': '宴饮奏乐', 'annotation_ids': [11], 'hall': 'xuting',
                                          'subject': '一人席地抚琴'})
        self.api('post', f'/themes/{THEME}/original')
        seedream.save_settings('test-key')
        job, paid = self.candidates('line', line_drawing())
        self.assertIn('一人席地抚琴', paid.call_args.args[0])
        line = job['results'][0]
        self.api('post', f'/themes/{THEME}/approve', json={'role': 'line', 'material_id': line, 'reviewer': '核对员',
                                                           'checklist': {k: True for k in themes.CHECKLIST}})
        job, _ = self.candidates('color', painting(), 'paper')
        self.api('post', f'/themes/{THEME}/approve', json={'role': 'color', 'material_id': job['results'][0], 'reviewer': '核对员'})
        self.api('patch', f'/themes/{THEME}', json={
            'hook': '席间一曲', 'story': STORY, 'story_refs': REFS, 'greetings': ['知音难觅', '岁岁欢宴'],
            'emoji': [{'phrase': '弹一曲', 'crop': [0, 0, 1, 1]}, {'phrase': '好听', 'crop': [0, 0, .6, 1], 'accent': True}],
            'avatar_crop': [0.2, 0, 0.8, 0.8]})
        self.figure.review_status = 'reviewed'
        self.db.commit()
        self.api('post', f'/themes/{THEME}/render')
        if publish:
            self.api('post', f'/themes/{THEME}/publish', json={'published': True})
        return self.api('get', f'/themes/{THEME}')

    def work(self, client=None, **design):
        client = client or self.client
        body = {'request_id': str(uuid4()), 'design': {'theme': THEME, 'product': 'postcard', **design}}
        response = client.post('/api/creative/works', json=body)
        self.assertEqual(response.status_code, 202, response.text)
        record = store.get('works', response.json()['id'])
        jobs.render_work(record)
        return store.get('works', record['id'])

    # ------------------------------------------------------------ sources

    def test_transparent_export_retains_reference_without_reviewing_candidate(self):
        item = store.from_annotations(self.db, [11])
        self.assertEqual(item['source']['annotation_ids'], [11])
        self.assertEqual(item['source']['references'][0]['document_id'], 1)
        with Image.open(store.material_file(item)) as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((image.width-1, image.height-1))[3], 0)
            self.assertGreater(image.getpixel((2, 2))[3], 0)
        self.assertEqual(self.db.get(Annotation, 11).review_status, 'candidate')
        self.assertEqual(self.db.query(AnnotationReference).count(), 1)
        self.assertEqual(store.from_annotations(self.db, [11])['id'], item['id'])
        self.assertEqual(self.original_bytes, self.image_path.read_bytes())
        with self.assertRaises(ValueError):
            store.from_annotations(self.db, [11, 14])

    def test_quarter_turn_source_keeps_annotation_coordinates_and_original_file(self):
        plain = store.from_annotations(self.db, [11])
        rotated = store.from_annotations(self.db, [11], rotation=1)
        with Image.open(store.material_file(plain)) as original, Image.open(store.material_file(rotated)) as upright:
            self.assertEqual(upright.size, original.size[::-1])
            self.assertEqual(upright.tobytes(), original.transpose(Image.Transpose.ROTATE_90).tobytes())
        self.assertNotEqual(plain['id'], rotated['id'])
        self.assertEqual(rotated['source']['rotation'], 1)
        self.assertEqual(rotated['source']['annotation_ids'], [11])
        self.assertEqual(store.from_annotations(self.db, [11], rotation=1)['id'], rotated['id'])
        self.assertEqual(self.original_bytes, self.image_path.read_bytes())
        self.assertEqual(self.db.get(Annotation, 11).review_status, 'candidate')
        with self.assertRaises(ValueError):
            store.from_annotations(self.db, [11], rotation=4)

    # ------------------------------------------------------------ production

    def test_admin_routes_need_login(self):
        for path in ('themes', f'themes/{THEME}', 'venue', 'stats', 'prints', 'posters.pdf', 'materials', 'image-settings', 'image-jobs'):
            self.assertEqual(self.client.get('/api/creative/admin/' + path).status_code, 401, path)
        self.assertEqual(self.client.post('/api/creative/admin/themes', json={'id': THEME, 'title': '宴饮奏乐', 'annotation_ids': [11]}).status_code, 401)
        self.assertEqual(themes.records(), [])

    def test_steps_gate_publication_and_review_checklist_is_enforced(self):
        theme = self.api('post', '/themes', json={'id': THEME, 'title': '宴饮奏乐', 'annotation_ids': [11]})
        self.assertEqual(theme['stone_id'], 'T001')
        self.assertEqual([s['done'] for s in theme['steps']], [False, False, False, False, True, False, False, False])
        self.api('post', '/themes', 400, json={'id': THEME, 'title': '重复', 'annotation_ids': [11]})
        self.api('post', '/themes', 400, json={'id': 'missing', 'title': '缺失', 'annotation_ids': [11, 999]})
        self.api('post', '/themes', 422, json={'id': 'Bad Id', 'title': '宴饮', 'annotation_ids': [11]})
        self.api('post', f'/themes/{THEME}/candidates', 400, json={'request_id': str(uuid4()), 'role': 'line'})
        self.api('post', f'/themes/{THEME}/original')
        with patch.object(seedream, 'generate') as paid:
            self.api('post', f'/themes/{THEME}/candidates', 400, json={'request_id': str(uuid4()), 'role': 'line'})
            paid.assert_not_called()
        seedream.save_settings('test-key')
        job, _ = self.candidates('line', line_drawing())
        line = job['results'][0]
        candidate = store.get('materials', line)
        self.assertEqual((candidate['theme'], candidate['role'], candidate['candidate_for']), (THEME, 'candidate', 'line'))
        self.assertTrue((store.folder('materials', line) / 'ink.png').is_file())
        self.assertFalse(candidate['published'])
        partial = {k: k != 'inscription' for k in themes.CHECKLIST}
        detail = self.api('post', f'/themes/{THEME}/approve', 400, json={'role': 'line', 'material_id': line, 'reviewer': '核对员', 'checklist': partial})
        self.assertIn('榜题', detail['detail'])
        self.api('post', f'/themes/{THEME}/approve', 400, json={'role': 'line', 'material_id': line, 'checklist': {k: True for k in themes.CHECKLIST}})
        self.api('post', f'/themes/{THEME}/approve', 400, json={'role': 'color', 'material_id': line, 'reviewer': '核对员'})
        theme = self.api('post', f'/themes/{THEME}/approve', json={'role': 'line', 'material_id': line, 'reviewer': '核对员',
                                                                   'checklist': {k: True for k in themes.CHECKLIST}, 'note': '逐项核对'})
        self.assertEqual(theme['approvals']['line']['reviewer'], '核对员')
        self.assertEqual(store.get('materials', line)['review']['status'], 'approved')
        self.api('post', f'/themes/{THEME}/publish', 400, json={'published': True})
        self.api('patch', f'/themes/{THEME}', 422, json={'hook': '一' * 15})
        self.api('patch', f'/themes/{THEME}', 422, json={'emoji': [{'phrase': '好', 'crop': [.5, 0, .2, 1]}]})
        self.api('patch', f'/themes/{THEME}', 422, json={'greetings': ['换行\u0007']})

    def test_full_theme_renders_products_with_provenance_and_publishes(self):
        theme = self.build()
        self.assertTrue(all(s['done'] for s in theme['steps']), theme['steps'])
        self.assertEqual(theme['status'], 'published')
        products = {p['id']: p for p in theme['products']}
        self.assertEqual(set(products), {'wallpaper', 'postcard', 'card', 'emoji', 'avatar'})
        self.assertEqual(len(products['emoji']['files']), 2)
        folder = themes.product_dir(THEME)
        for name, spec in (('wallpaper', render.PRODUCTS['wallpaper']), ('postcard', render.PRODUCTS['postcard']), ('card', render.PRODUCTS['card'])):
            with Image.open(folder / f'{name}.png') as image:
                self.assertEqual(image.size, (spec['width'], spec['height']))
        with Image.open(folder / 'print_postcard.png') as image:
            self.assertEqual(round(image.info['dpi'][0]), 300)
        with Image.open(folder / 'print_stickers.png') as image:
            self.assertEqual((image.size, round(image.info['dpi'][0])), ((render.PRODUCTS['print_stickers']['width'], render.PRODUCTS['print_stickers']['height']), 300))
        self.assertEqual({k for k, p in products.items() if p['printable']}, {'postcard', 'emoji'})
        with Image.open(folder / 'emoji-1.png') as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((0, 0))[3], 0)
        # The provenance line names the stone, the archive link and the AI label.
        ctx = themes.context(themes.get(THEME))
        self.assertIn('T001', render.provenance(ctx, 'color'))
        self.assertIn('艺术演绎', render.provenance(ctx, 'color'))
        self.assertIn('10.0.0.8', ctx['archive_url'])
        # Even individually shared small products must return to the same source stone.
        import cv2
        import numpy as np
        for name in ('avatar.png', 'emoji-1.png', 'print_postcard.png'):
            with Image.open(folder / name) as image:
                rgb = np.asarray(image.convert('RGB'))
                decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(rgb)
                self.assertEqual(decoded, ctx['archive_url'], name)
        for kind in ('line', 'rubbing'):
            self.assertIn('艺术演绎', render.provenance(ctx, kind))
        # The sticker sheet is white paper, so even the dark palette prints its provenance in dark ink.
        dark = {**ctx, 'palette': 'midnight'}
        sheet = render.sticker_sheet(dark, [{**spec, 'line': dark['line'], 'palette': 'midnight'} for spec in themes.get(THEME)['emoji']])
        spec = render.PRODUCTS['print_stickers']
        band = sheet.convert('L').crop((0, spec['height'] - 190, spec['width'] // 2, spec['height'] - 70))
        self.assertLess(band.getextrema()[0], 90)
        # Editing the theme makes the products stale until the next render.
        self.api('patch', f'/themes/{THEME}', json={'greetings': ['知音难觅']})
        self.assertFalse(next(s for s in self.api('get', f'/themes/{THEME}')['steps'] if s['key'] == 'products')['done'])
        self.api('delete', f'/themes/{THEME}', 400)
        pdf = self.admin.get('/api/creative/admin/posters.pdf')
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.content.startswith(b'%PDF'))

    def test_unselected_candidates_expire_but_adopted_items_stay(self):
        self.build(publish=False)
        old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        spare = themes.add_candidate(themes.get(THEME), 'line', line_drawing(), prompt='p', size='1x1')
        store.save('materials', {**spare, 'candidate_at': old})
        kept = store.add_image(painting(), '馆藏', origin='annotation')
        _, kept = themes.adopt(THEME, kept['id'], 'color')
        store.save('materials', {**kept, 'candidate_at': old})
        themes.cleanup()
        ids = {m['id'] for m in store.records('materials')}
        self.assertNotIn(spare['id'], ids)
        self.assertIn(kept['id'], ids)
        self.assertEqual(len(themes.get(THEME)['assets']['colors']), 1)
        self.assertIn(themes.get(THEME)['assets']['line'], ids)

    # ------------------------------------------------------------ visitors

    def test_only_published_themes_are_visible_and_public_payload_is_trimmed(self):
        self.build(publish=False)
        listing = self.client.get('/api/creative/themes')
        self.assertEqual(listing.json(), [])
        self.assertIn('httponly', listing.headers['set-cookie'].lower())
        self.assertEqual(self.client.get(f'/api/creative/themes/{THEME}').status_code, 404)
        self.assertEqual(self.client.get(f'/api/creative/themes/{THEME}/files/wallpaper.png').status_code, 404)
        self.api('post', f'/themes/{THEME}/publish', json={'published': True})
        public = self.client.get('/api/creative/themes').json()[0]
        for key in ('assets', 'approvals', 'subject', 'annotations', 'steps', 'emoji'):
            self.assertNotIn(key, public)
        self.assertNotIn(str(self.root), json.dumps(public))
        self.assertEqual(public['hall']['name'], '序厅')
        self.assertEqual(public['story_refs'][0]['page_no'], 7)
        wallpaper = next(p for p in public['products'] if p['id'] == 'wallpaper')['files'][0]
        response = self.client.get(wallpaper['url'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['content-type'], 'image/png')
        download = self.client.get(f'/api/creative/themes/{THEME}/files/wallpaper.png?download=1')
        self.assertIn('attachment', download.headers['content-disposition'])
        self.assertEqual(self.client.get(f'/api/creative/themes/{THEME}/files/manifest.json').status_code, 404)
        self.assertIn(self.client.get(f'/api/creative/themes/{THEME}/files/..%2F..%2Fx.png').status_code, (404, 422))
        self.assertEqual(self.client.get(f'/api/creative/themes/{THEME}/qr').headers['content-type'], 'image/png')
        self.client.get(f'/api/creative/themes/{THEME}?view=1')
        stats = self.api('get', '/stats')
        self.assertEqual(stats['totals']['view'], 1)
        self.assertEqual(stats['downloads'][0]['key'], f'{THEME}:wallpaper')
        links = self.other.get('/api/creative/links')
        self.assertNotIn('set-cookie', links.headers)
        self.assertEqual(set(links.json()[0]), {'id', 'title', 'hook', 'stone_id', 'hall', 'cover_url', 'nodes'})
        self.assertEqual(links.json()[0]['hall'], 'xuting')
        self.assertEqual(self.client.get(links.json()[0]['cover_url']).status_code, 200)
        self.api('post', f'/themes/{THEME}/publish', json={'published': False})
        self.assertEqual(self.client.get(wallpaper['url']).status_code, 404)
        self.assertEqual(self.other.get('/api/creative/links').json(), [])

    def test_visitor_routes_never_call_models(self):
        self.build()
        with patch.object(seedream, 'generate') as paid, patch.object(model_gateway, 'answer') as text, \
                patch.object(seedream.requests, 'Session') as network:
            self.client.get('/api/creative/venue')
            self.client.get('/api/creative/themes')
            self.client.get(f'/api/creative/themes/{THEME}?view=1')
            preview = self.client.post('/api/creative/preview', json={'theme': THEME, 'product': 'wallpaper', 'art': 'line', 'greeting': '知音难觅', 'signature': '小明'})
            self.assertEqual(preview.status_code, 200, preview.text)
            self.assertTrue(preview.json()['image'].startswith('data:image/webp;base64,'))
            item = self.work(greeting='岁岁欢宴', palette='jade')
            self.assertEqual(item['status'], 'succeeded', item.get('error'))
            self.client.post('/api/creative/handoff', json={'work_id': item['id']})
            paid.assert_not_called()
            text.assert_not_called()
            network.assert_not_called()
        self.assertEqual(store.records('image_jobs')[0]['kind'], 'theme_batch')
        self.assertEqual(len(store.records('image_jobs')), 2)

    def test_preview_validation_and_origin(self):
        self.build()
        body = {'theme': THEME, 'product': 'postcard'}
        self.assertEqual(self.client.post('/api/creative/preview', json=body, headers={'Origin': 'https://elsewhere.test'}).status_code, 403)
        self.assertEqual(self.client.post('/api/creative/preview', json={**body, 'product': 'emoji'}).status_code, 422)
        self.assertEqual(self.client.post('/api/creative/preview', json={**body, 'signature': '一' * 13}).status_code, 422)
        self.assertEqual(self.client.post('/api/creative/preview', json={**body, 'greeting': '换\n行'}).status_code, 422)
        self.assertEqual(self.client.post('/api/creative/preview', json={**body, 'product': 'card', 'motion': True}).status_code, 422)
        self.assertEqual(self.client.post('/api/creative/preview', json={**body, 'layers': []}).status_code, 422)
        self.assertEqual(self.client.post('/api/creative/preview', json={**body, 'theme': 'missing'}).status_code, 404)
        self.assertEqual(store.records('works'), [])

    def test_works_are_private_and_handoff_codes_expire(self):
        self.build()
        item = self.work(signature='小明')
        self.assertEqual(item['status'], 'succeeded', item.get('error'))
        path = '/api/creative/works/' + item['id']
        self.assertEqual(self.client.get(path).json()['files'][0]['name'], 'image.png')
        self.assertEqual(self.client.get(path + '/image.png').status_code, 200)
        self.assertEqual(self.other.get(path).status_code, 404)
        self.assertEqual(self.other.get(path + '/image.png').status_code, 404)
        self.assertEqual(self.other.get('/api/creative/works').json(), [])
        shared = self.client.post('/api/creative/handoff', json={'work_id': item['id']})
        self.assertEqual(shared.status_code, 200, shared.text)
        shared = shared.json()
        self.assertTrue(shared['qr'].startswith('data:image/png;base64,'))
        self.assertTrue(shared['url'].startswith('http://10.0.0.8:'))
        token = shared['token']
        taken = self.other.get('/api/creative/take/' + token).json()
        self.assertEqual(taken['product'], 'postcard')
        self.assertNotIn('owner', json.dumps(taken))
        self.assertEqual(self.other.get(taken['files'][0]['url']).status_code, 200)
        self.assertEqual(self.other.post('/api/creative/handoff', json={'work_id': item['id']}).status_code, 404)
        self.assertEqual(self.other.get('/api/creative/take/' + 'x' * 24).status_code, 404)
        record = store.get('handoffs', jobs.digest(token))
        store.save('handoffs', {**record, 'expires_at': (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()})
        self.assertEqual(self.other.get('/api/creative/take/' + token).status_code, 404)
        product = self.client.post('/api/creative/handoff', json={'theme': THEME, 'product': 'emoji'}).json()
        taken = self.other.get('/api/creative/take/' + product['token']).json()
        self.assertEqual(len(taken['files']), 2)
        self.assertEqual(self.other.get(taken['files'][1]['url']).status_code, 200)
        self.assertEqual(self.client.post('/api/creative/handoff', json={'theme': THEME}).status_code, 422)
        self.assertEqual(self.client.post('/api/creative/handoff', json={'theme': THEME, 'product': 'postcard_video'}).status_code, 404)
        # A kiosk reset hands the next visitor a fresh identity.
        self.assertEqual(self.client.post('/api/creative/session/reset').status_code, 200)
        self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.get('/api/creative/works').json(), [])

    def test_work_idempotence_checks_owner_and_design(self):
        self.build()
        design = render.Design(theme=THEME, product='postcard', greeting='知音难觅')
        identifier = str(uuid4())
        first = jobs.create(identifier, 'owner-a', design)
        self.assertEqual(jobs.create(identifier, 'owner-a', design)['id'], first['id'])
        with self.assertRaises(ValueError):
            jobs.create(identifier, 'owner-b', design)
        with self.assertRaises(ValueError):
            jobs.create(identifier, 'owner-a', design.model_copy(update={'greeting': '另一句'}))
        with self.assertRaisesRegex(ValueError, '动态'):
            jobs.create(str(uuid4()), 'owner-a', design.model_copy(update={'motion': True}))
        jobs.create(str(uuid4()), 'owner-a', design)
        with self.assertRaisesRegex(ValueError, '稍候'):
            jobs.create(str(uuid4()), 'owner-a', design)
        self.assertEqual(len(store.records('works')), 2)
        jobs.recover()
        self.assertTrue(all(w['status'] == 'failed' for w in store.records('works')))

    def test_stamps_need_signed_codes_and_card_needs_all_halls(self):
        self.build()
        self.assertEqual(self.client.get('/api/creative/stamps').json()['collected'], [])
        self.assertEqual(self.client.post('/api/creative/stamps', json={'hall': 'xuting', 'code': '0' * 12}).status_code, 400)
        self.assertEqual(self.client.post('/api/creative/stamps', json={'hall': 'lobby', 'code': '0' * 12}).status_code, 422)
        first = self.client.post('/api/creative/stamps', json={'hall': 'xuting', 'code': themes.stamp_code('xuting')}).json()
        self.assertEqual((first['collected'], first['fresh']), (['xuting'], True))
        again = self.client.post('/api/creative/stamps', json={'hall': 'xuting', 'code': themes.stamp_code('xuting')}).json()
        self.assertFalse(again['fresh'])
        self.assertNotEqual(themes.stamp_code('xuting'), themes.stamp_code('chuying'))
        self.assertEqual(self.client.get('/api/creative/stamps/card').status_code, 404)
        self.assertEqual(self.other.get('/api/creative/stamps').json()['collected'], [])
        for hall in themes.HALL_IDS:
            self.client.post('/api/creative/stamps', json={'hall': hall, 'code': themes.stamp_code(hall)})
        book = self.client.get('/api/creative/stamps').json()
        self.assertTrue(book['complete'])
        card = self.client.get(book['card_url'])
        self.assertEqual(card.status_code, 200)
        self.assertEqual(card.headers['content-type'], 'image/png')
        self.assertEqual(self.api('get', '/stats')['totals']['complete'], 1)
        venue = self.api('get', '/venue')
        self.assertNotIn('stamp_secret', json.dumps(venue))
        self.assertIn(f"code={themes.stamp_code('xuting')}", venue['stamps'][0]['url'])
        self.assertNotIn('stamp_secret', self.client.get('/api/creative/venue').text)

    def test_venue_settings_and_print_queue(self):
        self.build()
        venue = self.client.get('/api/creative/venue').json()
        self.assertTrue(venue['home_qr'].startswith('data:image/png;base64,'))
        self.assertIsNone(venue['wifi_qr'])
        self.assertFalse(venue['print_enabled'])
        self.assertEqual(self.client.post('/api/creative/prints', json={'theme': THEME, 'product': 'postcard'}).status_code, 400)
        self.api('put', '/venue', 422, json={'base_url': 'javascript:alert(1)'})
        self.api('put', '/venue', json={'wifi_ssid': '传承中心', 'wifi_password': 'han;hua', 'print_enabled': True, 'base_url': 'http://192.168.9.9:8030'})
        venue = self.client.get('/api/creative/venue').json()
        self.assertEqual(venue['wifi'], 'WIFI:T:WPA;S:传承中心;P:han\\;hua;;')
        self.assertTrue(venue['wifi_qr'].startswith('data:image/png;base64,'))
        self.assertEqual(venue['base_url'], 'http://192.168.9.9:8030')
        # A new address makes every printed QR code stale, so products re-render.
        self.assertNotEqual(themes.manifest(themes.get(THEME))['key'], themes.cache_key(themes.get(THEME)))
        self.assertEqual(self.client.post('/api/creative/prints', json={'theme': THEME, 'product': 'wallpaper'}).status_code, 400)
        queued = self.client.post('/api/creative/prints', json={'theme': THEME, 'product': 'postcard'}).json()
        self.assertEqual((queued['status'], queued['number']), ('queued', 1))
        item = self.work()
        self.assertEqual(self.client.post('/api/creative/prints', json={'work_id': item['id']}).json()['number'], 2)
        self.assertEqual(self.client.post('/api/creative/prints', json={'theme': THEME, 'product': 'postcard'}).status_code, 400)
        self.assertEqual(self.other.post('/api/creative/prints', json={'work_id': item['id']}).status_code, 404)
        stickers = self.other.post('/api/creative/prints', json={'theme': THEME, 'product': 'emoji'}).json()
        self.assertEqual((stickers['number'], stickers['title']), (3, themes.get(THEME)['title'] + ' · 表情贴纸'))
        self.assertEqual(self.other.post('/api/creative/prints', json={'theme': THEME, 'product': 'avatar'}).status_code, 400)
        queue = self.api('get', '/prints')
        self.assertEqual(len(queue), 3)
        sheet = next(q for q in queue if q['id'] == stickers['id'])
        with Image.open(BytesIO(self.admin.get(sheet['image_url']).content)) as printed:
            self.assertEqual(printed.size, (render.PRODUCTS['print_stickers']['width'], render.PRODUCTS['print_stickers']['height']))
        image = self.admin.get(queue[0]['image_url'])
        with Image.open(BytesIO(image.content)) as printed:
            self.assertEqual(printed.size, (render.PRODUCTS['print_postcard']['width'], render.PRODUCTS['print_postcard']['height']))
        self.assertEqual(self.api('post', f"/prints/{queue[0]['id']}", json={'status': 'printed'})['status'], 'printed')
        # Venue screens get a start script with this venue's address written in.
        for kind, fragment in (('kiosk', 'kiosk=1'), ('screen', 'screen=1')):
            script = self.admin.get(f'/api/creative/admin/launcher/{kind}')
            self.assertEqual(script.status_code, 200)
            self.assertIn('attachment', script.headers['content-disposition'])
            text = script.content.decode('utf-8')
            self.assertIn(f'set "URL=http://192.168.9.9:8030/#section=creative&{fragment}"', text)
            self.assertEqual(text.count('\n'), text.count('\r\n'))
        self.assertIn(self.client.get('/api/creative/admin/launcher/kiosk').status_code, (401, 403))

    def test_motion_postcard_is_five_seconds(self):
        import cv2
        import imageio_ffmpeg
        self.build(publish=False)
        video = store.add_image(Image.new('RGB', (480, 320), '#dc2828'), '行旅', origin='video')
        video.update(kind='video')
        store.save('materials', video)
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'color=c=0xdc2828:s=480x320:r=24', '-t', '5', '-c:v', 'libx264', '-threads', '1',
                        str(store.folder('materials', video['id']) / 'video.mp4')],
                       check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.api('post', f'/themes/{THEME}/adopt', json={'material_id': video['id'], 'role': 'video'})
        self.api('post', f'/themes/{THEME}/approve', json={'role': 'video', 'material_id': video['id']})
        self.api('post', f'/themes/{THEME}/render')
        self.api('post', f'/themes/{THEME}/publish', json={'published': True})
        capture = cv2.VideoCapture(str(themes.product_dir(THEME) / 'postcard_video.mp4'))
        self.assertAlmostEqual(capture.get(cv2.CAP_PROP_FRAME_COUNT) / capture.get(cv2.CAP_PROP_FPS), 5, places=1)
        capture.release()
        item = self.work(motion=True)
        self.assertEqual(item['status'], 'succeeded', item.get('error'))
        self.assertEqual([f['name'] for f in jobs.public(item)['files']], ['video.mp4', 'cover.png'])

    # ------------------------------------------------------------ paid requests

    def test_seedream_key_encrypted_and_paid_request_is_one_output(self):
        response = self.admin.put('/api/creative/admin/image-settings', json={'api_key': 'test-ark-key'})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('test-ark-key', seedream.config_path().read_text('utf-8'))
        self.assertNotIn('key_ciphertext', response.text)
        output = BytesIO()
        Image.new('RGB', (512, 512), '#70b5a0').save(output, 'PNG')
        reply = Mock(status_code=200)
        reply.iter_content.return_value = [json.dumps({'data': [{'b64_json': base64.b64encode(output.getvalue()).decode()}], 'usage': {'generated_images': 1}}).encode()]
        session = Mock()
        session.post.return_value = reply
        factory = Mock()
        factory.return_value.__enter__ = Mock(return_value=session)
        factory.return_value.__exit__ = Mock(return_value=False)
        with patch.object(seedream.requests, 'Session', factory):
            image, _ = seedream.generate('测试画面', self.original_bytes, '2048x1536')
        self.assertEqual(image.size, (512, 512))
        self.assertEqual(session.post.call_count, 1)
        args, kwargs = session.post.call_args
        self.assertEqual(args[0], seedream.ENDPOINT)
        body = kwargs['json']
        self.assertEqual(body['model'], 'doubao-seedream-5-0-260128')
        self.assertEqual(body['sequential_image_generation'], 'disabled')
        self.assertEqual(body['size'], '2048x1536')
        self.assertFalse(body['watermark'])
        self.assertTrue(body['image'].startswith('data:image/jpeg;base64,'))
        self.assertFalse(kwargs['allow_redirects'])

    def test_candidate_batches_are_idempotent_and_never_repost(self):
        self.api('post', '/themes', json={'id': THEME, 'title': '宴饮奏乐', 'annotation_ids': [11]})
        self.api('post', f'/themes/{THEME}/original')
        seedream.save_settings('test-key')
        identifier = str(uuid4())
        with patch.object(themes.threading, 'Thread') as thread:
            first = themes.start_candidates(identifier, THEME, 'line', count=2)
            self.assertEqual(themes.start_candidates(identifier, THEME, 'line', count=2)['id'], first['id'])
            self.assertEqual(thread.call_count, 1)
            with self.assertRaises(ValueError):
                themes.start_candidates(identifier, THEME, 'line', count=3)
            with self.assertRaisesRegex(ValueError, '等待'):
                themes.start_candidates(str(uuid4()), THEME, 'line')
            seedream.recover()
            self.assertEqual(themes.start_candidates(identifier, THEME, 'line', count=2)['status'], 'interrupted')
            self.assertEqual(thread.call_count, 1)
        themes._threads.clear()
        with patch.object(seedream, 'generate', side_effect=seedream.SubmissionUncertain('中断')) as paid:
            job = self.api('post', f'/themes/{THEME}/candidates', 202, json={'request_id': str(uuid4()), 'role': 'line', 'count': 3})
            job = self.wait_job(job['id'])
        self.assertEqual(paid.call_count, 1)
        self.assertEqual(job['status'], 'submission_uncertain')
        for extra in ({'model': 'another'}, {'count': 5}, {'role': 'color'}, {'role': 'color', 'style': 'oil'}):
            body = {'request_id': str(uuid4()), 'role': 'line', **extra}
            self.api('post', f'/themes/{THEME}/candidates', 422, json=body)


if __name__ == '__main__':
    unittest.main()
