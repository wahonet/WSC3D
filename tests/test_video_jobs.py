"""Exercise paid-task boundaries with temporary files and a fake MiniMax transport."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services import video_jobs as jobs
from app.routers import videos, workspace
from app.db import get_db
from video_fixtures import SourceFixture, sources
import base64
import json


def reply(data, status=200):
    return Mock(status_code=status, json=Mock(return_value=data))


class VideoJobsTests(SourceFixture, unittest.TestCase):
    def setUp(self):
        config = self.setup_sources()
        self.enterContext(patch.object(jobs, 'settings', config))
        self.session = Mock()
        self.enterContext(patch.object(jobs.minimax, 'client', return_value=(self.session, jobs.minimax.BASES[0])))
        self.starter = self.enterContext(patch.object(jobs, 'start'))
        self.enterContext(patch.object(workspace, '_sessions', {}))
        jobs._stop.clear()
        app = FastAPI()
        app.include_router(workspace.router, prefix='/api')
        app.include_router(videos.router, prefix='/api')
        app.dependency_overrides[get_db] = lambda: self.db
        self.api = self.enterContext(TestClient(app))
        self.prepared = self.prepare()
        self.body = dict(request_id=str(uuid4()), source_id=self.prepared['id'])

    def login(self):
        return self.api.post('/api/workspace/login', json={'username': 'admin', 'password': '123456'})

    def create(self):
        return jobs.create(jobs.VideoRequest(**self.body))

    def succeeded_response(self):
        self.session.get.return_value = reply({'task': {'status': 'succeeded', 'content': {'url': 'https://media.example/video.mp4'}, 'usage': {'duration': 5}}})

    def test_login_cookie_and_all_video_routes_require_session(self):
        for path in ('settings', 'jobs', 'sources', f"sources/{self.prepared['id']}/image", f"jobs/{self.body['request_id']}/file", f"jobs/{self.body['request_id']}/cover"):
            self.assertEqual(self.api.get('/api/videos/' + path).status_code, 401)
        self.assertEqual(self.api.post('/api/videos/jobs', json=self.body).status_code, 401)
        self.assertEqual(self.api.post('/api/videos/prepare', json={'annotation_ids': [11]}).status_code, 401)
        self.assertEqual(self.api.post('/api/workspace/login', json={'username': 'admin', 'password': 'wrong'}).status_code, 401)
        result = self.login()
        self.assertEqual(result.status_code, 200)
        cookie = result.headers['set-cookie'].lower()
        self.assertIn('httponly', cookie)
        self.assertIn('samesite=strict', cookie)
        self.assertTrue(self.api.get('/api/workspace/session').json()['authenticated'])
        self.assertEqual(self.api.get('/api/videos/settings').status_code, 200)
        self.assertEqual(self.api.post('/api/videos/jobs', json=self.body, headers={'Origin': 'https://other.example'}).status_code, 403)
        self.api.post('/api/workspace/logout')
        self.assertEqual(self.api.get('/api/videos/jobs').status_code, 401)
        self.session.post.assert_not_called()

    def test_server_rejects_cost_and_input_overrides_before_submission(self):
        self.login()
        for delta in ({'duration': 6}, {'duration': 15}, {'duration': True}, {'duration': '5'}, {'duration': 3}, {'prompt': '  '}, {'prompt': 'x' * 7001}, {'ratio': 'adaptive'}, {'resolution': '2K'}, {'model': 'MiniMax-H3-Max'}, {'outputs': 4}, {'style': 'unknown'}):
            with self.subTest(delta=str(delta)[:50]):
                self.assertEqual(self.api.post('/api/videos/jobs', json={**self.body, **delta}).status_code, 422)
        self.starter.assert_not_called()
        self.session.post.assert_not_called()

    def test_preparing_preview_never_submits_and_enforces_both_modes(self):
        self.login()
        for delta in ({'duration': 4}, {'duration': 6}, {'duration': '5'}, {'duration': True}, {'mode': 'other'}, {'annotation_ids': []}, {'resolution': '2K'}):
            self.assertEqual(self.api.post('/api/videos/prepare', json={'annotation_ids': [11], **delta}).status_code, 422)
        for mode, duration in (('fast', 5), ('multimodal', 4), ('multimodal', 5)):
            result = self.api.post('/api/videos/prepare', json={'annotation_ids': [11, 13], 'mode': mode, 'duration': duration})
            self.assertEqual(result.status_code, 200, result.text)
            data = result.json()
            self.assertNotIn('source_file', data['source'])
            self.assertEqual(self.api.get(data['image_url']).status_code, 200)
        self.assertEqual(jobs.records(), [])
        self.starter.assert_not_called()
        self.session.post.assert_not_called()

    def test_policy_has_requested_model_resolution_and_prices(self):
        policy = jobs.policy()
        modes = {value['id']: value for value in policy['modes']}
        self.assertEqual((modes['fast']['label'], modes['fast']['model'], modes['fast']['resolution'], modes['fast']['price_per_second']), ('极速生成', 'MiniMax-H3-Max', '480P', .33))
        self.assertEqual((modes['multimodal']['label'], modes['multimodal']['model'], modes['multimodal']['resolution'], modes['multimodal']['price_per_second']), ('多模态生成', 'MiniMax-H3', '768P', .5))

    def test_same_request_is_idempotent_and_changed_request_is_rejected(self):
        self.login()
        first = self.api.post('/api/videos/jobs', json=self.body)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(self.api.post('/api/videos/jobs', json=self.body).json()['id'], first.json()['id'])
        self.assertEqual(self.api.post('/api/videos/jobs', json={**self.body, 'prompt': '另一画面'}).status_code, 409)
        self.assertEqual(self.api.post('/api/videos/jobs', json={**self.body, 'request_id': str(uuid4())}).status_code, 409)
        self.assertEqual(len(jobs.records()), 1)
        self.starter.assert_called_once()

    def test_simultaneous_submits_claim_only_one_job(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.create(), range(12)))
        self.assertEqual(len({r['id'] for r in results}), 1)
        self.starter.assert_called_once()

    def test_first_frame_payload_and_download_failure_resume_without_new_charge(self):
        record = self.create()
        self.session.post.return_value = reply({'task_id': 'test-task'})
        self.succeeded_response()
        with patch.object(jobs, '_download', side_effect=OSError('disk busy')):
            jobs._worker(record['id'])
        self.assertEqual(jobs.get(record['id'])['status'], 'download_failed')
        payload = self.session.post.call_args.kwargs['json']
        self.assertEqual((payload['model'], payload['duration'], payload['resolution'], payload['ratio']), ('MiniMax-H3-Max', 5, '480P', 'adaptive'))
        self.assertEqual([part['type'] for part in payload['content']], ['text', 'image_url'])
        self.assertEqual(payload['content'][0]['text'], self.prepared['prompt'])
        self.assertEqual(payload['content'][1]['role'], 'first_frame')
        self.assertEqual(base64.b64decode(payload['content'][1]['image_url']['url'].split(',')[1]), (jobs.output_root(record['id']) / 'base.jpg').read_bytes())
        self.assertIn('二维剪纸', payload['content'][0]['text'])
        with patch.object(jobs, '_download', return_value={'actual_duration': 5.16, 'width': 1792, 'height': 768}):
            jobs._worker(record['id'])
        self.assertEqual(jobs.get(record['id'])['status'], 'succeeded')
        self.assertEqual(self.session.post.call_count, 1)
        self.assertNotIn('base', jobs.public(jobs.get(record['id'])))
        self.assertNotIn('task_id', jobs.public(jobs.get(record['id'])))

    def test_multimodal_uses_reference_image_and_frozen_annotation_evidence(self):
        self.body['source_id'] = self.prepare([12], mode='multimodal', duration=4)['id']
        record = self.create()
        self.scene.label = '后来改名'
        self.db.commit()
        self.session.post.return_value = reply({'task_id': 'test-reference'})
        self.session.get.return_value = reply({'task': {'status': 'failed'}})
        jobs._worker(record['id'])
        payload = self.session.post.call_args.kwargs['json']
        self.assertEqual((payload['model'], payload['resolution'], payload['duration']), ('MiniMax-H3', '768P', 4))
        self.assertEqual(payload['content'][1]['role'], 'reference_image')
        self.assertIn('宴饮全景', payload['content'][0]['text'])
        self.assertNotIn('后来改名', payload['content'][0]['text'])
        evidence = json.loads((jobs.output_root(record['id']) / 'source.json').read_text('utf-8'))
        self.assertEqual(evidence['source']['annotation_ids'], [12])
        self.assertEqual(jobs.public(record)['estimated_cny'], 2.0)

    def test_replay_survives_preview_cache_loss_and_corrupt_frozen_image_cannot_submit(self):
        record = self.create()
        (sources.source_dir(self.prepared['id']) / 'source.json').unlink()
        self.assertEqual(self.create()['id'], record['id'])
        (jobs.output_root(record['id']) / 'base.jpg').write_bytes(b'corrupt')
        jobs._worker(record['id'])
        self.assertEqual(jobs.get(record['id'])['status'], 'failed')
        self.session.post.assert_not_called()

    def test_optional_prompt_override_retains_selected_base_image(self):
        self.body['prompt'] = '手部轻动，二维剪纸。'
        record = self.create()
        self.assertEqual(record['prompt'], self.body['prompt'])
        self.assertEqual(record['source']['annotation_ids'], [11])
        self.assertTrue((jobs.output_root(record['id']) / 'base.jpg').is_file())

    def test_old_text_only_completed_record_still_has_correct_metadata(self):
        record = dict(id=str(uuid4()), title='旧片', prompt='旧提示词', duration=5, style='paper', ratio='21:9', status='succeeded', created_at=jobs._now())
        result = jobs.public(record)
        self.assertEqual((result['model'], result['resolution'], result['estimated_cny']), ('MiniMax-H3', '768P', 2.5))
        self.assertIsNone(result['source'])
        self.assertTrue(result['video_url'])

    def test_network_timeout_does_not_resubmit_on_refresh_recovery_or_replay(self):
        record = self.create()
        self.session.post.side_effect = TimeoutError('lost response')
        jobs._worker(record['id'])
        self.assertEqual(jobs.get(record['id'])['status'], 'submission_uncertain')
        self.starter.reset_mock()
        jobs.refresh(record['id'])
        jobs.recover()
        self.create()
        self.starter.assert_not_called()
        self.assertEqual(self.session.post.call_count, 1)

    def test_interrupted_submit_is_uncertain_and_known_task_is_only_queried(self):
        record = self.create()
        jobs._update(record['id'], status='submitting')
        self.starter.reset_mock()
        jobs.recover()
        self.assertEqual(jobs.get(record['id'])['status'], 'submission_uncertain')
        self.starter.assert_not_called()
        jobs._update(record['id'], status='queued', task_id='known-task', base=jobs.minimax.BASES[0], compiled_prompt='prompt')
        self.session.get.return_value = reply({'task': {'status': 'failed'}})
        jobs._worker(record['id'])
        self.session.post.assert_not_called()
        self.assertEqual(jobs.get(record['id'])['status'], 'failed')

    def test_api_rejection_is_visible_and_redacts_credential(self):
        record = self.create()
        self.session.post.return_value = reply({'error': {'message': 'invalid key sk-test-secret'}}, status=401)
        jobs._worker(record['id'])
        result = jobs.public(jobs.get(record['id']))
        self.assertEqual(result['status'], 'failed')
        self.assertIn('HTTP 401', result['error'])
        self.assertNotIn('sk-test-secret', result['error'])

    def test_file_download_requires_completion_and_supports_range(self):
        record = self.create()
        self.login()
        path = jobs.output_root(record['id']) / 'video.mp4'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'0123456789abcdefghij')
        url = f"/api/videos/jobs/{record['id']}/file"
        self.assertEqual(self.api.get(url).status_code, 404)
        jobs._update(record['id'], status='succeeded')
        response = self.api.get(url, headers={'Range': 'bytes=4-7'})
        self.assertEqual((response.status_code, response.content), (206, b'4567'))
        self.assertEqual(self.api.get('/api/videos/jobs/invalid-id/file').status_code, 422)

    def test_media_saved_locally_and_duration_over_six_is_not_published(self):
        import cv2
        import numpy as np
        record = self.create()
        record.update(task_id='fixture', compiled_prompt='fixture')
        for duration in (5, 7):
            path = self.root / f'fixture-{duration}.mp4'
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'mp4v'), 10, (64, 64))
            self.assertTrue(writer.isOpened())
            for _ in range(duration * 10):
                writer.write(np.zeros((64, 64, 3), dtype=np.uint8))
            writer.release()
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.iter_content.return_value = [path.read_bytes()]
            with patch.object(jobs.requests, 'get', return_value=response) as download:
                if duration == 5:
                    result = jobs._download(record, 'https://cdn.example/media.mp4')
                    self.assertEqual(result['actual_duration'], 5)
                    self.assertTrue((jobs.output_root(record['id']) / 'cover.jpg').is_file())
                    evidence = json.loads((jobs.output_root(record['id']) / 'source.json').read_text('utf-8'))
                    self.assertEqual(evidence['source']['references'][0]['page_no'], 7)
                else:
                    with self.assertRaisesRegex(ValueError, '6 秒'):
                        jobs._download(record, 'https://cdn.example/media.mp4')
                self.assertNotIn('headers', download.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
