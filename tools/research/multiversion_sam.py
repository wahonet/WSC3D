"""Run native, close-up SAM3 inference for cross-version proposals with immutable provenance.

This tool produces proposals only. A model score or overlap with a projected
outline never substitutes for visual review of the native photograph.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from multiversion_context import ROOT, OUT, WORK, BASELINE
from multiversion_pixel_frames import validate_pixel_frame
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.config import model_path
from app.services import previews
from app.services.process_tree import line_reader, stop_worker

Image.MAX_IMAGE_PIXELS = None
cv2.setNumThreads(1)
FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 17)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    compact = os.environ.get('WSC_RESEARCH_COMPACT_JSON') == '1'
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=None if compact else 1,
                               separators=(',', ':') if compact else None), encoding='utf-8')
    for attempt in range(15):
        try:
            temp.replace(path)
            return
        except PermissionError:
            time.sleep(.1 * (attempt + 1))
    raise RuntimeError(f'Cannot save {path}')


def prepare_pilot():
    inventory = json.loads((OUT / 'inventory.json').read_text(encoding='utf-8'))
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))
    stone = next(s for s in inventory['stones'] if s['stone_id'] == '武010')
    assets = {a['id']: a for a in stone['assets']}
    jobs = []
    for target_id in (182, 183):
        target = assets[target_id]
        chain = target['extra']['align_to_master']
        assert chain['master_asset_id'] == 185
        theta = np.deg2rad(chain['theta_deg'])
        sim = np.array([[chain['s'] * np.cos(theta), -chain['s'] * np.sin(theta), chain['tx']],
                        [chain['s'] * np.sin(theta), chain['s'] * np.cos(theta), chain['ty']], [0, 0, 1]])
        inverse = np.linalg.inv(sim)
        work_path = previews.ensure_work_image(target_id, target['relpath'])
        work_sha = hashlib.file_digest(work_path.open('rb'), 'sha256').hexdigest()
        with Image.open(work_path) as image:
            W, H = image.size
            for canonical_id in (127, 139, 184):
                original = next(a for a in baseline['annotations'] if a['id'] == canonical_id)
                base = assets[original['asset_id']]
                points = np.array(json.loads(original['geometry'])['points']) * [base['width'], base['height']]
                homogeneous = np.c_[points, np.ones(len(points))] @ inverse.T
                points = homogeneous[:, :2] / homogeneous[:, 2:] / [target['width'], target['height']]
                low, high = points.min(0), points.max(0)
                margin = np.maximum((high - low) * .35, [.009, .009])
                low, high = np.maximum(0, low - margin), np.minimum(1, high + margin)
                px = [int(np.floor(low[0] * W)), int(np.floor(low[1] * H)),
                      int(np.ceil(high[0] * W)), int(np.ceil(high[1] * H))]
                actual = [px[0] / W, px[1] / H, px[2] / W, px[3] / H]
                crop = WORK / 'native-inputs' / f'{target_id}-{canonical_id}.png'
                crop.parent.mkdir(parents=True, exist_ok=True)
                if not crop.exists():
                    image.crop(tuple(px)).convert('RGB').save(crop)
                crop_sha = hashlib.file_digest(crop.open('rb'), 'sha256').hexdigest()
                jobs.append({'stone_id': stone['stone_id'], 'canonical_annotation_id': canonical_id,
                    'label': original['label'], 'canonical_asset_id': base['id'], 'target_asset_id': target_id,
                    'source_sha256': target['sha256'], 'source_filename': target['filename'],
                    'version_label': target['version_label'], 'work_image_sha256': work_sha,
                    'crop_path': str(crop), 'crop_sha256': crop_sha, 'crop_extent': actual,
                    'expected_outline': points.tolist(), 'expected_prompt': 'horse' if canonical_id == 184 else 'person',
                    'localization_method': 'existing-validated-similarity-chain; not a final segmentation',
                    'variants': ['native', 'enhance', 'rubbing']})
    write(WORK / 'native-jobs.json', jobs)
    print(f'Prepared {len(jobs)} native regions, {sum(len(j["variants"]) for j in jobs)} SAM3 requests', flush=True)


def decode(mask):
    counts = mask['counts']
    array = np.zeros(sum(counts), np.uint8)
    offset = 0
    for i, count in enumerate(counts):
        if i % 2:
            array[offset:offset + count] = 1
        offset += count
    return array.reshape(mask['size'])


def validate_native_result_frame(job, result):
    """Reject reduced model bitmaps before any localization score or rendering."""
    with Image.open(job['crop_path']) as source:
        width, height = source.size
    if result.get('size') != [width, height]:
        raise ValueError(f'Native result size {result.get("size")} differs from observed crop {[width, height]}')
    for detection in result.get('detections') or []:
        mask = detection.get('native_mask')
        if mask is None or mask.get('size') != [height, width]:
            raise ValueError(f'Native bitmap size {None if mask is None else mask.get("size")} differs from observed crop {[height, width]}; no resizing permitted')
        if decode(mask).shape != (height, width):
            raise ValueError('Native mask RLE differs from the inspected source frame')


def evaluate_detection(job, detection):
    mask = detection['native_mask']
    binary = decode(mask)
    x0, y0, x1, y1 = mask['extent']
    points = (np.array(job['expected_outline']) - [x0, y0]) / [x1 - x0, y1 - y0]
    expected = np.zeros_like(binary)
    cv2.fillPoly(expected, [np.round(points * [binary.shape[1], binary.shape[0]]).astype(np.int32)], 1)
    union = np.logical_or(expected, binary).sum()
    intersection = np.logical_and(expected, binary).sum()
    detection['localization_overlap'] = float(intersection / union) if union else 0
    detection['expected_coverage'] = float(intersection / max(1, expected.sum()))
    detection['review_status'] = 'unreviewed-proposal'


def proposal_path(job, variant):
    tag = job.get('proposal_tag', '')
    if tag and not tag.replace('-', '').isalnum():
        raise ValueError('Invalid proposal tag')
    suffix = f'-{tag}' if tag else ''
    return OUT / 'native-proposals' / f"{job['stone_id']}-{job['target_asset_id']}-{job['canonical_annotation_id']}{suffix}-{variant}.json"


def render_contact(job, runs):
    with Image.open(job['crop_path']) as source:
        source = source.convert('RGB')
    tile_width, tile_height = 450, 490
    columns = len(runs) + 1
    sheet = Image.new('RGB', (columns * tile_width, tile_height + 60), 'white')
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 6), f"{job['stone_id']} a{job['target_asset_id']} · {job['version_label']} · {job['label']} #{job['canonical_annotation_id']}", fill='#111', font=FONT)
    draw.text((8, 31), '真实照片上重新分割；模型输出和定位重合度仅为候选，尚未验收', fill='#a22', font=FONT)
    im = source.copy()
    im.thumbnail((tile_width - 10, tile_height - 60))
    sheet.paste(im, (5, 60))
    draw.text((8, tile_height + 8), '本版本原始区域', fill='#111', font=FONT)
    for i, (variant, result) in enumerate(runs.items(), 1):
        left = i * tile_width
        detections = sorted(result.get('detections') or [], key=lambda d: d['localization_overlap'], reverse=True)
        if not detections:
            draw.text((left + 8, 70), f'{variant}：无有效掩膜', fill='#a22', font=FONT)
            continue
        det = detections[0]
        mask = Image.fromarray(decode(det['native_mask']) * 255).resize(source.size, Image.Resampling.NEAREST)
        rgba = source.convert('RGBA')
        rgba.putalpha(mask)
        panel = Image.new('RGB', source.size, '#ddd')
        panel.paste(rgba, (0, 0), rgba)
        panel.thumbnail((tile_width - 10, tile_height - 60))
        sheet.paste(panel, (left + 5, 60))
        draw.text((left + 8, tile_height + 8), f"{variant} score {det['score']:.3f} · 定位IoU {det['localization_overlap']:.3f}", fill='#111', font=FONT)
    suffix = '-'+job['proposal_tag'] if job.get('proposal_tag') else ''
    path = OUT / 'native-review' / f"{job['stone_id']}-{job['target_asset_id']}-{job['canonical_annotation_id']}{suffix}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, quality=94)


def run(jobs_path=None):
    jobs_path = jobs_path or WORK / 'native-jobs.json'
    jobs = json.loads(jobs_path.read_text(encoding='utf-8'))
    engine = 'sam3'
    status = {'controller_pid': os.getpid(), 'status': 'starting', 'finished_requests': 0,
              'total_requests': sum(len(j['variants']) for j in jobs), 'jobs_file': str(jobs_path), 'started': time.time()}
    write(WORK / 'sam-process.json', status)
    # Check for a platform-owned inference worker before launching another SAM3 worker.
    sys.path.insert(0, str(ROOT / 'tmp/wsc-check-backup'))
    from api import call
    platform = call('GET', '/tools/segment/status')
    if platform['worker']['alive']:
        raise RuntimeError('A platform inference worker is already active; inspect before starting another')
    weight = model_path('sam3', 'weight')
    weight_sha = hashlib.file_digest(weight.open('rb'), 'sha256').hexdigest()
    with (WORK / 'sam-worker.log').open('a', encoding='utf-8') as stderr:
        worker = subprocess.Popen([sys.executable, '-X', 'utf8', '-u', str(ROOT / 'src/backend/app/sam_worker.py'),
            '--mobilesam', str(model_path('mobilesam', 'weight')), '--sam3', str(weight), '--sam31', ''],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding='utf-8', bufsize=1,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        lines = line_reader(worker)
        status.update(worker_pid=worker.pid, weight_sha256=weight_sha)
        write(WORK / 'sam-process.json', status)
        def ask(body):
            worker.stdin.write(json.dumps(body, ensure_ascii=False) + '\n')
            worker.stdin.flush()
            answer = lines.get(timeout=180)
            if not answer:
                raise RuntimeError(f'Worker stopped: {worker.poll()}')
            return json.loads(answer)
        try:
            boot = json.loads(lines.get(timeout=180))
            status.update(status='loading', worker_info=boot)
            write(WORK / 'sam-process.json', status)

            loaded = ask({'cmd': 'load', 'engine': engine})
            if not loaded.get('ok'):
                raise RuntimeError(f'Engine failed to load: {loaded}')
            for job in jobs:
                if job.get('pixel_frame_record'):
                    validate_pixel_frame(job)
                assert hashlib.file_digest(Path(job['crop_path']).open('rb'), 'sha256').hexdigest() == job['crop_sha256']
                x0, y0, x1, y1 = job['crop_extent']
                points = (np.array(job['expected_outline']) - [x0, y0]) / [x1 - x0, y1 - y0]
                low, high = points.min(0), points.max(0)
                boxes = [{'cx': float((low[0] + high[0]) / 2), 'cy': float((low[1] + high[1]) / 2),
                          'w': float(high[0] - low[0]), 'h': float(high[1] - low[1]), 'label': 1}]
                runs = {}
                for variant in job['variants']:
                    path = proposal_path(job, variant)
                    params = {'cmd': 'text_segment', 'engine': engine, 'image': job['crop_path'],
                        'prompt': job['expected_prompt'], 'boxes': boxes, 'threshold': .2, 'max_results': job.get('max_results', 12),
                        'preprocess': 'none' if variant == 'native' else variant, 'tiling': 'none', 'preserve_mask': True}
                    if path.exists():
                        saved = json.loads(path.read_text(encoding='utf-8'))
                        if saved['job'] != job or saved['request'] != params or saved['weight_sha256'] != weight_sha:
                            raise ValueError(f'Input fingerprint changed: {path}')
                        result = saved['result']
                        validate_native_result_frame(job, result)
                    else:
                        status.update(status='native-inference', target_asset_id=job['target_asset_id'],
                                      canonical_annotation_id=job['canonical_annotation_id'], variant=variant, updated=time.time())
                        write(WORK / 'sam-process.json', status)
                        started = time.perf_counter()
                        result = ask(params)
                        if not result.get('ok'):
                            write(path.with_name(path.stem+'-frame-rejected.json'), {'job': job, 'request': params,
                                'weight_sha256': weight_sha, 'result': result, 'visual_reviewed': False,
                                'native_frame_validation': {'valid': False, 'error': result.get('error')}})
                            raise RuntimeError(f'Inference failed: {result}')
                        try:
                            validate_native_result_frame(job, result)
                        except ValueError as error:
                            write(path.with_name(path.stem+'-frame-rejected.json'), {'job': job, 'request': params,
                                'weight_sha256': weight_sha, 'result': result, 'visual_reviewed': False,
                                'native_frame_validation': {'valid': False, 'error': str(error)},
                                'result_coordinate_frame': 'raw worker input crop; not a publishable native proposal'})
                            raise
                        for detection in result.get('detections') or []:
                            detection['polygon'] = [[x0 + x * (x1 - x0), y0 + y * (y1 - y0)] for x, y in detection['polygon']]
                            extent = detection['native_mask']['extent']
                            detection['native_mask']['extent'] = [x0 + extent[0] * (x1 - x0), y0 + extent[1] * (y1 - y0),
                                                                  x0 + extent[2] * (x1 - x0), y0 + extent[3] * (y1 - y0)]
                            evaluate_detection(job, detection)
                        write(path, {'job': job, 'request': params, 'weight_sha256': weight_sha, 'result': result,
                                     'elapsed_seconds': time.perf_counter() - started, 'visual_reviewed': False,
                                     'native_frame_validation': {'valid': True, 'resized': False}})
                    runs[variant] = result
                    status['finished_requests'] += 1
                    status['updated'] = time.time()
                    write(WORK / 'sam-process.json', status)
                    print(job['target_asset_id'], job['canonical_annotation_id'], variant,
                          'detections', len(result.get('detections') or []), flush=True)
                if os.environ.get('WSC_RESEARCH_RENDER_CONTACTS') != '0':
                    render_contact(job, runs)
            status['status'] = 'native-proposals-ready-for-review'
        except BaseException as error:
            status.update(status='error', error=repr(error))
            raise
        finally:
            stop_worker(worker)
            status['updated'] = time.time()
            write(WORK / 'sam-process.json', status)


def record_timeout(job, status):
    """Keep a failed task explicit; a timeout is never a publishable mask."""
    x0,y0,x1,y1=job['crop_extent']
    points=(np.asarray(job['expected_outline'])-[x0,y0])/[x1-x0,y1-y0]
    low,high=points.min(0),points.max(0)
    params={'cmd':'text_segment','engine':'sam3','image':job['crop_path'],
        'prompt':job['expected_prompt'],'boxes':[{'cx':float((low[0]+high[0])/2),'cy':float((low[1]+high[1])/2),
        'w':float(high[0]-low[0]),'h':float(high[1]-low[1]),'label':1}],
        'threshold':.2,'max_results':job.get('max_results',12),'preprocess':'none','tiling':'none','preserve_mask':True}
    path=proposal_path(job,'native')
    if path.exists():
        raise ValueError('Timeout cannot replace an existing native proposal')
    write(path,{'job':job,'request':params,'weight_sha256':status['weight_sha256'],
        'result':{'ok':False,'error':'Native inference exceeded the 180-second request limit','detections':[]},
        'visual_reviewed':False,'native_frame_validation':{'valid':False,'reason':'No native result returned'}})


def run_resilient(jobs_path):
    """Resume only unfinished tasks, retiring a timed-out worker before continuing."""
    jobs=json.loads(jobs_path.read_text(encoding='utf-8'))
    remaining_path=jobs_path.with_name(jobs_path.stem+'-remaining.json')
    failures=[]
    while True:
        remaining=[j for j in jobs if not all(proposal_path(j,v).is_file() for v in j['variants'])]
        if not remaining:
            write(jobs_path.with_name(jobs_path.stem+'-completion.json'),{'jobs':len(jobs),'timeout_tasks':failures,'phase':'Proposals ready for independent review'})
            return
        write(remaining_path,remaining)
        try:
            run(remaining_path)
        except queue.Empty:
            status=json.loads((WORK/'sam-process.json').read_text(encoding='utf-8'))
            job=next(j for j in remaining if j['target_asset_id']==status['target_asset_id'] and j['canonical_annotation_id']==status['canonical_annotation_id'])
            record_timeout(job,status)
            failures.append({'asset_id':job['target_asset_id'],'canonical_annotation_id':job['canonical_annotation_id']})
            print('TIMEOUT_RECORDED',job['stone_id'],job['target_asset_id'],job['canonical_annotation_id'],flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare-pilot', 'run'])
    parser.add_argument('--jobs-file', type=Path)
    options = parser.parse_args()
    prepare_pilot() if options.command == 'prepare-pilot' else run(options.jobs_file)
