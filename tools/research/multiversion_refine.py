"""Refine a proposal against its native photograph with recorded foreground/background points.

Produces review artifacts only; scores and prompt satisfaction are not approval.
"""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
from PIL import Image

from multiversion_sam import ROOT, OUT, WORK, write, decode, evaluate_detection, render_contact
from multiversion_pixel_frames import validate_pixel_frame
from app.config import model_path
from app.services.process_tree import line_reader, stop_worker
from app.services import previews


def process_alive(pid):
    if not pid or pid == os.getpid():
        return False
    if os.name == 'nt':
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                     wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, int(pid))
        if not handle:
            error = ctypes.get_last_error()
            if error == 87:
                return False
            raise OSError(error, 'Cannot verify preceding research process')
        try:
            code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
                raise ctypes.WinError(ctypes.get_last_error())
            if code.value == 259:
                # Windows reuses exited PIDs. A live browser at an old worker's
                # PID is not a Python research process and must not block a new
                # finite batch. Access/inspection failures remain hard errors.
                name = ctypes.create_unicode_buffer(32768)
                length = wintypes.DWORD(len(name))
                if not kernel.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(length)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if Path(name.value).name.lower() not in ('python.exe', 'pythonw.exe'):
                    return False
            return code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False


def assert_research_gpu_idle():
    for filename in ('sam-process.json', 'refine-process.json'):
        path = WORK / filename
        if not path.exists():
            continue
        previous = json.loads(path.read_text(encoding='utf-8'))
        for key in ('controller_pid', 'worker_pid'):
            pid = previous.get(key)
            if process_alive(pid):
                raise RuntimeError(f'A research GPU process is still active: {filename} {key}={pid}')


def prepare_prompt(prompt, inventory):
    if prompt.get('proposal'):
        proposal_path = (OUT / prompt['proposal']).resolve()
        assert proposal_path.is_relative_to((OUT / 'native-proposals').resolve()), 'Proposal must be a recorded native artifact'
        job = json.loads(proposal_path.read_text(encoding='utf-8'))['job']
    else:
        jobs = json.loads((WORK / 'native-jobs.json').read_text(encoding='utf-8'))
        job = next(j for j in jobs if j['target_asset_id'] == prompt['target_asset_id'] and
                   j['canonical_annotation_id'] == prompt['canonical_annotation_id'])
    assert job['target_asset_id'] == prompt['target_asset_id']
    assert job['canonical_annotation_id'] == prompt['canonical_annotation_id']
    asset = next(a for stone in inventory['stones'] for a in stone['assets'] if a['id'] == job['target_asset_id'])
    assert asset['sha256'] == job['source_sha256'], 'Native source provenance changed'
    if job.get('pixel_frame_record'):
        validate_pixel_frame(job)
    else:
        work_path = previews.ensure_work_image(asset['id'], asset['relpath'])
        with work_path.open('rb') as work_stream:
            assert hashlib.file_digest(work_stream, 'sha256').hexdigest() == job['work_image_sha256']
    path = Path(job['crop_path'])
    assert path.resolve().is_relative_to((WORK / 'native-inputs').resolve())
    assert hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == job['crop_sha256']
    with Image.open(path) as source:
        width, height = source.size
    assert [width, height] == prompt['image_size'], 'Review points must refer to the observed image'
    coords = np.asarray(prompt['points_px'], dtype=float)
    labels = np.asarray(prompt['labels'])
    assert coords.ndim == 2 and coords.shape[1] == 2 and len(coords) > 0
    assert np.isfinite(coords).all() and (coords >= 0).all() and (coords < [width, height]).all()
    assert labels.shape == (len(coords),) and np.isin(labels, [0, 1]).all()
    assert re.fullmatch(r'[A-Za-z0-9-]+', str(prompt['round']))
    assert prompt['preprocess'] and len(set(prompt['preprocess'])) == len(prompt['preprocess'])
    assert set(prompt['preprocess']) <= {'none', 'enhance', 'rubbing'}
    if prompt.get('box_px'):
        box = np.asarray(prompt['box_px'], dtype=float)
        assert box.shape == (4,) and np.isfinite(box).all() and (box >= 0).all()
        assert (box <= [width, height, width, height]).all() and box[0] < box[2] and box[1] < box[3]
    for mode in prompt['preprocess']:
        result_path = OUT / 'native-proposals' / f"{job['stone_id']}-{job['target_asset_id']}-{job['canonical_annotation_id']}-refine-{prompt['round']}-{mode}.json"
        assert not result_path.exists(), 'Refinement artifacts are immutable; use a new round identifier'
    return job


def run(prompt_path):
    prompts = json.loads(prompt_path.read_text(encoding='utf-8'))
    assert_research_gpu_idle()
    sys.path.insert(0, str(ROOT / 'tmp/wsc-check-backup'))
    from api import call
    if call('GET', '/tools/segment/status')['worker']['alive']:
        raise RuntimeError('A platform-owned worker is active')
    inventory = json.loads((OUT / 'inventory.json').read_text(encoding='utf-8'))
    jobs = [prepare_prompt(prompt, inventory) for prompt in prompts]
    destinations = [(j['target_asset_id'], j['canonical_annotation_id'], p['round'], mode)
                    for j, p in zip(jobs, prompts) for mode in p['preprocess']]
    assert len(destinations) == len(set(destinations)), 'Duplicate refinement destinations'
    weight = model_path('sam3', 'weight')
    weight_sha = hashlib.file_digest(weight.open('rb'), 'sha256').hexdigest()
    state = {'controller_pid': os.getpid(), 'started': time.time(), 'status': 'starting', 'finished': 0}
    write(WORK / 'refine-process.json', state)
    with (WORK / 'sam-refine-worker.log').open('a', encoding='utf-8') as stderr:
        worker = subprocess.Popen([sys.executable, '-X', 'utf8', '-u', str(ROOT / 'src/backend/app/sam_worker.py'),
            '--sam3', str(weight), '--sam3-interactive'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=stderr, text=True, encoding='utf-8', bufsize=1, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        lines = line_reader(worker)
        state['worker_pid'] = worker.pid
        write(WORK / 'refine-process.json', state)
        def ask(body):
            worker.stdin.write(json.dumps(body, ensure_ascii=False) + '\n')
            worker.stdin.flush()
            line = lines.get(timeout=240)
            if not line:
                raise RuntimeError(f'Worker stopped {worker.poll()}')
            result = json.loads(line)
            if not result.get('ok'):
                raise RuntimeError(result)
            return result
        try:
            state['boot'] = json.loads(lines.get(timeout=240))
            ask({'cmd': 'load', 'engine': 'sam3'})
            for prompt, job in zip(prompts, jobs):
                path = Path(job['crop_path'])
                assert hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == job['crop_sha256']
                with Image.open(path) as source:
                    width, height = source.size
                assert [width, height] == prompt['image_size'], 'Review points must refer to the observed image'
                coords = np.asarray(prompt['points_px'], dtype=float) / [width, height]
                x0, y0, x1, y1 = job['crop_extent']
                runs = {}
                for mode in prompt['preprocess']:
                    request = {'cmd': 'instance_segment', 'image': str(path), 'points': coords.tolist(),
                               'labels': prompt['labels'], 'preprocess': mode, 'multimask': False}
                    if prompt.get('box_px'):
                        request['box'] = (np.asarray(prompt['box_px'], dtype=float) / [width, height, width, height]).tolist()
                    state.update(status='native-refinement', asset=job['target_asset_id'], annotation=job['canonical_annotation_id'],
                                 mode=mode, updated=time.time())
                    write(WORK / 'refine-process.json', state)
                    result = ask(request)
                    for det in result.get('detections') or []:
                        local = decode(det['native_mask'])
                        assert local.shape == (height, width), 'SAM3 output must preserve the observed native point frame'
                        hits = [bool(local[min(height-1, round(y)), min(width-1, round(x))]) for x, y in prompt['points_px']]
                        det['prompt_satisfied'] = [hit == bool(label) for hit, label in zip(hits, prompt['labels'])]
                        det['polygon'] = [[x0 + x * (x1-x0), y0 + y * (y1-y0)] for x, y in det['polygon']]
                        det['native_mask']['extent'] = job['crop_extent']
                        evaluate_detection(job, det)
                    result_path = OUT / 'native-proposals' / f"{job['stone_id']}-{job['target_asset_id']}-{job['canonical_annotation_id']}-refine-{prompt['round']}-{mode}.json"
                    assert not result_path.exists(), 'Refinement artifacts are immutable'
                    write(result_path, {'job': job, 'review_points': prompt, 'request': request, 'result': result,
                        'weight_sha256': weight_sha, 'visual_reviewed': False, 'point_source': 'native-image-visual-inspection'})
                    runs[f"refine{prompt['round']}-{mode}"] = result
                    state['finished'] += 1
                    print(job['target_asset_id'], job['canonical_annotation_id'], mode,
                          [(round(d['score'], 3), sum(d['prompt_satisfied']), len(d['prompt_satisfied'])) for d in result['detections']], flush=True)
                # Distinct name preserves the earlier concept-segmentation review artifact.
                copy = {**job, 'canonical_annotation_id': f"{job['canonical_annotation_id']}-refine-{prompt['round']}"}
                render_contact(copy, runs)
            state['status'] = 'refinement-ready-for-review'
        except BaseException as error:
            state.update(status='error', error=repr(error))
            raise
        finally:
            stop_worker(worker)
            state['updated'] = time.time()
            write(WORK / 'refine-process.json', state)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('prompt_file', type=Path)
    options = ap.parse_args()
    run(options.prompt_file)
