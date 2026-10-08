"""Show original pixels beside candidate masks for manual triage, never acceptance."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw
from multiversion_sam import OUT, WORK, FONT, decode, proposal_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stones', nargs='+', required=True)
    parser.add_argument('--targets', nargs='*', type=int)
    parser.add_argument('--limit', type=int, default=16)
    options = parser.parse_args()
    grouped = {}
    for path in sorted(WORK.glob('native-jobs*.json')):
        for job in json.loads(path.read_text(encoding='utf-8')):
            if job['stone_id'] not in options.stones or job.get('proposal_tag'):
                continue
            if options.targets and job['target_asset_id'] not in options.targets:
                continue
            choices = []
            for variant in job['variants']:
                artifact = proposal_path(job, variant)
                if not artifact.exists():
                    continue
                result = json.loads(artifact.read_text(encoding='utf-8'))['result']
                for index, detection in enumerate(result.get('detections') or []):
                    choices.append((detection.get('localization_overlap', 0), variant,
                                    index, detection, artifact))
            if choices:
                best = max(choices, key=lambda c: c[0])
                grouped.setdefault((job['stone_id'], job['target_asset_id']), []).append((job, best))
    for (stone, target), items in grouped.items():
        items.sort(key=lambda pair: pair[1][0], reverse=True)
        items = items[:options.limit]
        tile_w, tile_h = 600, 350
        columns = min(3, len(items))
        rows = (len(items)+columns-1)//columns
        sheet = Image.new('RGB', (columns*tile_w, rows*tile_h+55), 'white')
        draw = ImageDraw.Draw(sheet)
        draw.text((8, 5), f'{stone} a{target} 本源原图 / 掩膜候选；缩略图仅作筛查，尚未验收', font=FONT, fill='#a22')
        selected = []
        for number, (job, best) in enumerate(items):
            overlap, variant, index, det, artifact = best
            x, y = (number % columns)*tile_w, (number//columns)*tile_h+55
            draw.text((x+6, y+4), f"#{job['canonical_annotation_id']} {job['label']}", font=FONT, fill='#111')
            draw.text((x+6, y+29), f'{variant} detection {index} 定位IoU {overlap:.3f}', font=FONT, fill='#111')
            with Image.open(job['crop_path']) as image:
                source = image.convert('RGB')
            mask = Image.fromarray(decode(det['native_mask'])*255).resize(source.size, Image.Resampling.NEAREST)
            binary = np.asarray(mask)>0
            edge = cv2.dilate(binary.astype(np.uint8), np.ones((3,3), np.uint8))-cv2.erode(binary.astype(np.uint8), np.ones((3,3), np.uint8))
            pixels = np.asarray(source).copy()
            pixels[~binary] = [228,228,228]
            pixels[edge>0] = [240,40,30]
            for column, panel in enumerate([source, Image.fromarray(pixels)]):
                panel.thumbnail((290, 288))
                sheet.paste(panel, (x+5+column*300, y+56))
            selected.append({'canonical_id':job['canonical_annotation_id'], 'proposal':str(artifact.relative_to(OUT)),
                             'detection_index':index, 'review_status':'triage-only-unreviewed'})
        dest = OUT/'native-triage'/f'{stone}-{target}.jpg'
        dest.parent.mkdir(exist_ok=True)
        sheet.save(dest, quality=95)
        dest.with_suffix('.json').write_text(json.dumps(selected, ensure_ascii=False, indent=1), encoding='utf-8')
        print(dest, flush=True)


if __name__ == '__main__':
    main()
