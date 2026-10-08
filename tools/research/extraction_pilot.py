"""Compact source overviews, object review sheets and lossless final cutouts."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.services.resources import asset_path
from multiversion_context import ROOT, OUT, WORK
from multiversion_sam import decode

Image.MAX_IMAGE_PIXELS = None
FONT = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 16)
POLICY = 'object-level-extraction-20261004'


def object_prompt(label):
    subject = label.split('（', 1)[0]
    if not any(word in subject for word in ('人', '者', '骑吏', '侍女', '伍伯')) and any(word in subject for word in ('楼房', '楼阁', '重楼', '建筑', '栏杆')):
        return 'building'
    for keys, prompt in ((('玉兔', '兔'), 'rabbit'), (('织布机',), 'loom'),
                         (('头匣',), 'box'), (('柱', '楼阙'), 'building'),
                         (('龙',), 'dragon'), (('树',), 'tree'),
                         (('车',), 'chariot'), (('马',), 'horse'),
                         (('牛',), 'cow'), (('浆瓮', '鼎'), 'vase'),
                         (('兽', '犬', '鱼', '鹤', '鸟'), 'animal')):
        if any(key in subject for key in keys):
            return prompt
    return 'person'


def stone_directory(stone):
    return OUT / ('pilot' if stone in ('武008', '武009', '武010') else 'stones') / stone / ('' if stone in ('武008', '武009', '武010') else 'object-extraction')


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def rows(stone):
    with sqlite3.connect((ROOT/'data/stonelab.db').as_uri()+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        assets = {a['id']: dict(a) for a in db.execute("SELECT * FROM assets WHERE stone_id=? AND kind NOT LIKE 'model%'", (stone,))}
        annotations = [dict(a) for a in db.execute("SELECT * FROM annotations WHERE stone_id=? AND tool!='align' ORDER BY id", (stone,))]
    for a in annotations:
        a['geometry'] = json.loads(a['geometry'] or '{}')
    return assets, annotations


def paste(panel, image, box):
    image = image.copy()
    image.thumbnail((box[2]-box[0], box[3]-box[1]))
    panel.paste(image, (box[0]+(box[2]-box[0]-image.width)//2, box[1]+(box[3]-box[1]-image.height)//2))


def overview(stone):
    assets, annotations = rows(stone)
    groups = {}
    for a in assets.values():
        groups.setdefault(a['sha256'], []).append(a)
    panel = Image.new('RGB', (1600, 540*math.ceil(len(groups)/4)), 'white')
    draw = ImageDraw.Draw(panel)
    for index, group in enumerate(groups.values()):
        a = group[0]
        x, y = (index%4)*400, (index//4)*540
        draw.text((x+8, y+5), f"{a['id']} {a['filename'][:24]}", font=FONT, fill='black')
        draw.text((x+8, y+28), f"{a['width']} × {a['height']} | aliases {[v['id'] for v in group]}", font=FONT, fill='black')
        with Image.open(asset_path(a['relpath'])) as image:
            image.seek(0)
            paste(panel, image.convert('RGB'), (x+8, y+55, x+392, y+530))
    path = stone_directory(stone)/'sources.jpg'
    path.parent.mkdir(parents=True, exist_ok=True)
    panel.save(path, quality=88)
    print(path, flush=True)


def export(stone, ids):
    assets, annotations = rows(stone)
    selected = [a for a in annotations if a['id'] in set(ids)]
    if len(selected) != len(set(ids)):
        raise ValueError('Unknown or duplicate annotation selection')
    directory = stone_directory(stone)
    manifest_path = directory/'cutouts.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {'format':'wsc-object-cutouts-1','stone_id':stone,'review_policy':POLICY,'versions':[]}
    by_id = {r['annotation_id']:r for r in manifest['versions']}
    for asset_id in sorted({a['asset_id'] for a in selected}):
        asset = assets[asset_id]
        source = asset_path(asset['relpath'])
        if sha(source) != asset['sha256']:
            raise ValueError('Original source changed')
        with Image.open(source) as original:
            original.seek(0)
            width, height = original.size
            for a in [v for v in selected if v['asset_id']==asset_id]:
                if a['id'] in by_id:
                    continue
                g = a['geometry']
                if g.get('native_mask'):
                    native = g['native_mask']
                    binary = decode(native)
                    pixels = [round(native['extent'][0]*width), round(native['extent'][1]*height), round(native['extent'][2]*width), round(native['extent'][3]*height)]
                    if binary.shape != (pixels[3]-pixels[1],pixels[2]-pixels[0]):
                        raise ValueError(f"{a['id']}: legacy reduced frame; retain existing record, do not upsample")
                elif (a['atype']=='polygon' and g.get('points')) or (a['atype']=='rect' and a['level'] in ('scene','band')):
                    if g.get('points'):
                        points = np.asarray(g['points'], dtype=float)*[width,height]
                    else:
                        x,y,w,h = [g[k] for k in ('x','y','w','h')]
                        points = np.asarray([[x,y],[x+w,y],[x+w,y+h],[x,y+h]])*[width,height]
                    pixels = [max(0,math.floor(points[:,0].min())),max(0,math.floor(points[:,1].min())),min(width,math.ceil(points[:,0].max())+1),min(height,math.ceil(points[:,1].max())+1)]
                    mask = Image.new('L',(pixels[2]-pixels[0],pixels[3]-pixels[1]))
                    ImageDraw.Draw(mask).polygon([tuple(p) for p in np.rint(points-[pixels[0],pixels[1]]).astype(int)],fill=255)
                    binary = np.asarray(mask)>0
                else:
                    raise ValueError(f"{a['id']}: no accepted polygon or native mask")
                ys,xs = np.nonzero(binary)
                if not len(xs):
                    raise ValueError('Empty mask')
                tight = [int(xs.min()),int(ys.min()),int(xs.max())+1,int(ys.max())+1]
                binary = binary[tight[1]:tight[3],tight[0]:tight[2]].astype(np.uint8)*255
                pixels = [pixels[0]+tight[0],pixels[1]+tight[1],pixels[0]+tight[2],pixels[1]+tight[3]]
                rgb = original.crop(pixels).convert('RGB')
                alpha = Image.fromarray(binary)
                rgba = rgb.convert('RGBA');rgba.putalpha(alpha)
                png = directory/'cutouts'/f"{a['id']}-a{asset_id}.png"
                mask_path = directory/'masks'/f"{a['id']}-a{asset_id}.png"
                png.parent.mkdir(parents=True,exist_ok=True);mask_path.parent.mkdir(parents=True,exist_ok=True)
                rgba.save(png);alpha.save(mask_path)
                by_id[a['id']] = {'annotation_id':a['id'],'asset_id':asset_id,'label':a['label'],'level':a['level'],'parent_id':a['parent_id'],'canonical_annotation_id':g.get('image_version',{}).get('canonical_annotation_id',a['id']),'source_sha256':asset['sha256'],'source_filename':asset['filename'],'frame_index':0,'original_size':[width,height],'crop_pixels':pixels,'png':str(png.relative_to(OUT)),'mask':str(mask_path.relative_to(OUT)),'png_sha256':sha(png),'mask_sha256':sha(mask_path),'rgb_modified':False,'geometry_reused':True}
                print('EXPORT',a['id'],asset_id,list(rgba.size),flush=True)
    manifest['versions'] = list(by_id.values());write(manifest_path,manifest)


def sheet(stone, start, limit):
    directory = stone_directory(stone)
    manifest = json.loads((directory/'cutouts.json').read_text(encoding='utf-8'))
    chosen = manifest['versions'][start:start+limit]
    if not chosen:
        return None
    panel = Image.new('RGB',(1440,330*math.ceil(len(chosen)/4)),'#eeeeee');draw=ImageDraw.Draw(panel)
    for index,row in enumerate(chosen):
        x,y=(index%4)*360,(index//4)*330
        draw.text((x+6,y+3),f"{row['annotation_id']} a{row['asset_id']} {row['level']}",font=FONT,fill='black')
        draw.text((x+6,y+27),row['label'][:19],font=FONT,fill='black')
        with Image.open(OUT/row['png']) as rgba:
            composite=Image.new('RGB',rgba.size,'#dddddd');composite.paste(rgba,mask=rgba.getchannel('A'))
            paste(panel,composite,(x+6,y+55,x+354,y+323))
    path=directory/f'objects-{start:03d}.jpg';panel.save(path,quality=90);print(path,flush=True)


def candidates(stone, paths, tag):
    """One whole-object comparison per task; selection is still a visual decision."""
    records = []
    for path in paths:
        saved = json.loads(path.read_text(encoding='utf-8'))
        job = saved['job']
        detections = saved['result'].get('detections', [])
        if not detections:
            records.append({'proposal':str(path.relative_to(OUT)), 'detection_index':None, 'canonical_annotation_id':job['canonical_annotation_id'],'asset_id':job['target_asset_id'],'state':'no_candidate'})
            continue
        index = max(range(len(detections)),key=lambda i:detections[i].get('localization_overlap',0))
        records.append({'proposal':str(path.relative_to(OUT)),'detection_index':index,'canonical_annotation_id':job['canonical_annotation_id'],'asset_id':job['target_asset_id'],'state':'candidate_requires_object_review'})
    directory = stone_directory(stone)
    for start in range(0,len(records),8):
        part = records[start:start+8]
        panel=Image.new('RGB',(1600,370*math.ceil(len(part)/4)),'white');draw=ImageDraw.Draw(panel)
        for k,row in enumerate(part):
            x,y=(k%4)*400,(k//4)*370
            saved=json.loads((OUT/row['proposal']).read_text(encoding='utf-8'));job=saved['job']
            draw.text((x+5,y+4),f"a{row['asset_id']} #{row['canonical_annotation_id']} d{row['detection_index']}",font=FONT,fill='black')
            draw.text((x+5,y+28),job['label'][:22],font=FONT,fill='black')
            with Image.open(job['crop_path']) as image:
                rgb=image.convert('RGB');paste(panel,rgb,(x+4,y+58,x+198,y+363))
                if row['detection_index'] is not None:
                    binary=decode(saved['result']['detections'][row['detection_index']]['native_mask'])
                    if binary.shape!=(rgb.height,rgb.width):raise ValueError('Reduced mask cannot be reviewed as native')
                    rgba=rgb.convert('RGBA');rgba.putalpha(Image.fromarray(binary*255));bg=Image.new('RGB',rgba.size,'#ddd');bg.paste(rgba,mask=rgba.getchannel('A'));paste(panel,bg,(x+202,y+58,x+396,y+363))
            row['review_sheet']=str((directory/f'{tag}-{start:03d}.jpg').relative_to(OUT))
        path=directory/f'{tag}-{start:03d}.jpg';panel.save(path,quality=90);print(path,flush=True)
    write(directory/f'{tag}-index.json',records)


def prepare_cross(stone, reference_id, target_ids, tag, subject_ids=None, skip_tasks=()):
    """Existing registration locates crops; every final mask uses target pixels."""
    assets, annotations = rows(stone)
    source = assets[reference_id]
    subjects = [a for a in annotations if a['asset_id']==reference_id and not a['geometry'].get('image_version') and a['level'] in ('figure','component')]
    if subject_ids is not None:
        subjects = [a for a in subjects if a['id'] in set(subject_ids)]
    skip_tasks = set(skip_tasks)
    jobs, pending = [], []
    local_path = stone_directory(stone)/'source-localization.json'
    local = json.loads(local_path.read_text(encoding='utf-8')) if local_path.exists() else {}
    for target_id in target_ids:
        target = assets[target_id]
        transform = local.get(f'{target_id}:{reference_id}') or local.get(str(target_id)) or json.loads(target['extra'] or '{}').get('align_to_master', {})
        if transform.get('master_asset_id') != reference_id and assets.get(transform.get('master_asset_id'), {}).get('sha256') != reference['sha256']:
            pending.append({'asset_id':target_id,'reason':'source localization not established'});continue
        if transform.get('homography'):
            inverse=np.linalg.inv(np.asarray(transform['homography']))
        else:
            s=transform['s'];theta=np.deg2rad(transform['theta_deg'])
            inverse=np.linalg.inv([[s*np.cos(theta),-s*np.sin(theta),transform['tx']],[s*np.sin(theta),s*np.cos(theta),transform['ty']],[0,0,1]])
        source_path=asset_path(target['relpath'])
        if sha(source_path)!=target['sha256']:raise ValueError('Original source changed')
        with Image.open(source_path) as image:
            image.seek(0);rgb=image.convert('RGB');width,height=rgb.size
            rgb_digest=hashlib.sha256(rgb.tobytes()).hexdigest()
            for a in subjects:
                if (target_id, a['id']) in skip_tasks:
                    continue
                g=a['geometry']
                if g.get('points'):points=np.asarray(g['points'],float)*[source['width'],source['height']]
                elif all(k in g for k in ('x','y','w','h')):
                    x,y,w,h=[g[k] for k in ('x','y','w','h')];points=np.asarray([[x,y],[x+w,y],[x+w,y+h],[x,y+h]])*[source['width'],source['height']]
                else:continue
                mapped=np.c_[points,np.ones(len(points))]@inverse.T;mapped=mapped[:,:2]/mapped[:,2:]
                low,high=mapped.min(0),mapped.max(0)
                if np.any(high<=0) or np.any(low>=[width,height]):
                    pending.append({'asset_id':target_id,'canonical_annotation_id':a['id'],'reason':'registration places subject outside source; applicability requires visual confirmation'});continue
                margin=np.maximum((high-low)*(.35 if transform.get('rough_locator') else .18),[12,12]);lo=np.maximum(0,np.floor(low-margin)).astype(int);hi=np.minimum([width,height],np.ceil(high+margin)).astype(int)
                pixels=[*lo.tolist(),*hi.tolist()]
                if np.prod(hi-lo)>64*1024*1024:
                    pending.append({'asset_id':target_id,'canonical_annotation_id':a['id'],'reason':'native region exceeds mask limit; keep pending without downsampling'});continue
                crop=WORK/'native-inputs'/tag/f"{target_id}-{a['id']}.png";crop.parent.mkdir(parents=True,exist_ok=True)
                if not crop.exists():rgb.crop(pixels).save(crop)
                record={'source_file':str(source_path),'source_sha256':target['sha256'],'frame_index':0,'frame_count':getattr(image,'n_frames',1),'original_mode':image.mode,'original_size':[width,height],'working_path':str(source_path),'working_size':[width,height],'working_sha256':target['sha256'],'working_rgb_sha256':rgb_digest,'working_conversion':'Decode original RGB directly; no separate full-frame copy, resize, ICC or EXIF transform','crop_path':str(crop),'crop_pixels':pixels,'crop_size':[hi[0].item()-lo[0].item(),hi[1].item()-lo[1].item()],'crop_sha256':sha(crop)}
                frame=stone_directory(stone)/'frames'/f"{target_id}-{a['id']}-{tag}.json";write(frame,record)
                label=a['label'];subject=label.split('（',1)[0]
                prompt=object_prompt(label)
                jobs.append({'stone_id':stone,'canonical_annotation_id':a['id'],'canonical_asset_id':reference_id,'target_asset_id':target_id,'label':label,'source_sha256':target['sha256'],'source_filename':target['filename'],'version_label':target['filename'],'work_image_sha256':target['sha256'],'crop_path':str(crop),'crop_sha256':record['crop_sha256'],'crop_extent':[pixels[0]/width,pixels[1]/height,pixels[2]/width,pixels[3]/height],'expected_outline':(mapped/[width,height]).tolist(),'expected_prompt':prompt,'localization_method':'existing source registration for ROI only; final native inference independently on this source','pixel_frame_record':str(frame.relative_to(ROOT)),'proposal_tag':tag,'variants':['native'],'max_results':4})
        print('PREPARED',stone,target_id,len([j for j in jobs if j['target_asset_id']==target_id]),flush=True)
    path=WORK/f'native-jobs-{stone}-{tag}.json';write(path,jobs);write(stone_directory(stone)/f'{tag}-pending.json',pending);return path


def prepare_native_regions(stone, specs, tag):
    """Use an actually observed native ROI when whole-source registration is absent."""
    from app.sam_worker import encode_native_mask
    assets, annotations = rows(stone)
    originals = {a['id']: a for a in annotations if not a['geometry'].get('image_version')}
    jobs, contexts = [], []
    for target_id in sorted({s['asset_id'] for s in specs}):
        asset = assets[target_id]; source = asset_path(asset['relpath'])
        if sha(source) != asset['sha256']:
            raise ValueError('Original source changed')
        with Image.open(source) as image:
            image.seek(0); rgb = image.convert('RGB'); width, height = rgb.size
            digest = hashlib.sha256(rgb.tobytes()).hexdigest()
            for spec in [s for s in specs if s['asset_id'] == target_id]:
                canonical = originals[spec['canonical_annotation_id']]
                extent = np.asarray(spec['observed_region'], float)
                if extent.shape != (4,) or np.any(extent < 0) or np.any(extent > 1):
                    raise ValueError('Invalid observed native ROI')
                pixels = [math.floor(extent[0]*width), math.floor(extent[1]*height),
                          math.ceil(extent[2]*width), math.ceil(extent[3]*height)]
                x0,y0,x1,y1 = pixels
                if not (0<=x0<x1<=width and 0<=y0<y1<=height) or (x1-x0)*(y1-y0)>64*1024*1024:
                    raise ValueError('Native region outside source or above bitmap limit')
                extent = [x0/width,y0/height,x1/width,y1/height]
                crop = WORK/'native-inputs'/tag/f'{target_id}-{canonical["id"]}.png'
                crop.parent.mkdir(parents=True,exist_ok=True); rgb.crop(pixels).save(crop)
                proof = stone_directory(stone)/'frames'/f'{target_id}-{canonical["id"]}-{tag}.json'
                record = {'source_file':str(source),'source_sha256':asset['sha256'],'frame_index':0,
                    'frame_count':getattr(image,'n_frames',1),'original_mode':image.mode,
                    'original_size':[width,height],'working_path':str(source),'working_size':[width,height],
                    'working_sha256':asset['sha256'],'working_rgb_sha256':digest,
                    'working_conversion':'Decode original RGB; observed native ROI only; no resize or full-frame copy',
                    'crop_path':str(crop),'crop_pixels':pixels,'crop_size':[x1-x0,y1-y0],'crop_sha256':sha(crop)}
                write(proof,record)
                a,b,c,d=extent
                outline=[[a,b],[c,b],[c,d],[a,d]]
                job={'stone_id':stone,'canonical_annotation_id':canonical['id'],
                    'canonical_asset_id':canonical['asset_id'],'target_asset_id':target_id,
                    'label':canonical['label'],'source_sha256':asset['sha256'],'source_filename':asset['filename'],
                    'version_label':asset['filename'],'work_image_sha256':asset['sha256'],
                    'crop_path':str(crop),'crop_sha256':record['crop_sha256'],'crop_extent':extent,
                    'expected_outline':outline,'expected_prompt':spec.get('prompt',object_prompt(canonical['label'])),
                    'localization_method':'Direct observed source-native ROI; identity checked from the native carving',
                    'pixel_frame_record':str(proof.relative_to(ROOT)),'proposal_tag':tag,
                    'variants':spec.get('variants',['native']),'max_results':4}
                if spec.get('context'):
                    mask={**encode_native_mask(np.ones((y1-y0,x1-x0),np.uint8)),'extent':extent}
                    path=OUT/'native-proposals'/f'{stone}-{target_id}-{canonical["id"]}-{tag}-context.json'
                    write(path,{'job':job,'weight_sha256':None,'request':{'model_used':False,
                        'method':'Observed native narrative context; whole-region review required'},
                        'result':{'detections':[{'native_mask':mask,'polygon':outline,'localization_overlap':1}]},
                        'visual_reviewed':False})
                    contexts.append(path)
                else:
                    jobs.append(job)
        print('OBSERVED_NATIVE_REGIONS',stone,target_id,flush=True)
    path=WORK/f'native-jobs-{stone}-{tag}.json';write(path,jobs)
    return path,contexts


def correct_region(proposal_path, pixels, tag):
    """One observed source-region correction, retaining the original pixel proof."""
    from app.sam_worker import encode_native_mask
    saved=json.loads(proposal_path.read_text(encoding='utf-8'));job=saved['job'].copy()
    frame=json.loads((ROOT/job['pixel_frame_record']).read_text(encoding='utf-8'))
    width,height=frame['original_size'];x0,y0,x1,y1=pixels
    if not (0<=x0<x1<=width and 0<=y0<y1<=height):raise ValueError('Correction outside native frame')
    crop=WORK/'native-inputs/story-context'/f"{job['target_asset_id']}-{job['canonical_annotation_id']}-{tag}.png"
    with Image.open(frame['source_file']) as image:
        image.seek(frame['frame_index']);image.crop(pixels).convert('RGB').save(crop)
    frame={**frame,'crop_path':str(crop),'crop_pixels':pixels,'crop_size':[x1-x0,y1-y0],'crop_sha256':sha(crop)}
    record=stone_directory(job['stone_id'])/'frames'/f"{job['target_asset_id']}-{job['canonical_annotation_id']}-{tag}.json";write(record,frame)
    extent=[x0/width,y0/height,x1/width,y1/height]
    job.update(crop_path=str(crop),crop_sha256=frame['crop_sha256'],crop_extent=extent,pixel_frame_record=str(record.relative_to(ROOT)))
    a,b,c,d=extent;mask={**encode_native_mask(np.ones((y1-y0,x1-x0),np.uint8)),'extent':extent}
    path=proposal_path.with_name(proposal_path.stem+'-'+tag+'.json')
    write(path,{'job':job,'weight_sha256':None,'request':{'method':'One native narrative-region correction after whole-scene review','model_used':False,'parent_proposal':str(proposal_path.relative_to(OUT))},'result':{'detections':[{'native_mask':mask,'polygon':[[a,b],[c,b],[c,d],[a,d]],'localization_overlap':1}]},'visual_reviewed':False})
    return path


def prepare_stories(stone, reference_id, target_ids, subject_ids=None, skip_tasks=(), tag='objectpilot-story-context', levels=('scene',)):
    """Propose source-native narrative context regions for one visual check."""
    from app.sam_worker import encode_native_mask
    assets, annotations = rows(stone)
    reference = assets[reference_id]
    subjects = [a for a in annotations if a['asset_id']==reference_id and a['level'] in levels and a['atype'] in ('rect','polygon') and not a['geometry'].get('image_version')]
    if subject_ids is not None:
        subjects = [a for a in subjects if a['id'] in set(subject_ids)]
    skip_tasks = set(skip_tasks)
    local_path=stone_directory(stone)/'source-localization.json'
    local=json.loads(local_path.read_text(encoding='utf-8')) if local_path.exists() else {}
    proposals, pending=[],[]
    for target_id in target_ids:
        target=assets[target_id]
        transform=local.get(f'{target_id}:{reference_id}') or local.get(str(target_id)) or json.loads(target['extra'] or '{}').get('align_to_master',{})
        if transform.get('master_asset_id')!=reference_id and assets.get(transform.get('master_asset_id'),{}).get('sha256')!=reference['sha256']:
            pending.append({'asset_id':target_id,'reason':'narrative localization not established'});continue
        if transform.get('homography'):
            matrix = transform['homography']
        else:
            s=transform['s'];theta=np.deg2rad(transform['theta_deg'])
            matrix=[[s*np.cos(theta),-s*np.sin(theta),transform['tx']],[s*np.sin(theta),s*np.cos(theta),transform['ty']],[0,0,1]]
        inverse=np.linalg.inv(matrix);source_path=asset_path(target['relpath'])
        if sha(source_path)!=target['sha256']:raise ValueError('Original source changed')
        with Image.open(source_path) as image:
            rgb=image.convert('RGB');width,height=rgb.size;digest=hashlib.sha256(rgb.tobytes()).hexdigest()
            for a in subjects:
                if (target_id, a['id']) in skip_tasks:
                    continue
                g=a['geometry']
                if a['atype']=='polygon':points=np.asarray(g['points'],float)*[reference['width'],reference['height']]
                else:
                    x,y,w,h=[g[k] for k in ('x','y','w','h')]
                    points=np.asarray([[x,y],[x+w,y],[x+w,y+h],[x,y+h]])*[reference['width'],reference['height']]
                mapped=np.c_[points,np.ones(len(points))]@inverse.T;mapped=mapped[:,:2]/mapped[:,2:]
                lo=np.maximum(0,np.floor(mapped.min(0))).astype(int);hi=np.minimum([width,height],np.ceil(mapped.max(0))).astype(int)
                if np.any(hi<=lo) or np.prod(hi-lo)>64*1024*1024:
                    pending.append({'asset_id':target_id,'canonical_annotation_id':a['id'],'reason':'native context outside source or above bitmap limit'});continue
                pixels=[*lo.tolist(),*hi.tolist()];extent=[pixels[0]/width,pixels[1]/height,pixels[2]/width,pixels[3]/height]
                crop=WORK/'native-inputs/story-context'/f'{target_id}-{a["id"]}-{tag}.png';crop.parent.mkdir(parents=True,exist_ok=True)
                rgb.crop(pixels).save(crop)
                frame=stone_directory(stone)/'frames'/f'{target_id}-{a["id"]}-{tag}.json'
                record={'source_file':str(source_path),'source_sha256':target['sha256'],'frame_index':0,'frame_count':getattr(image,'n_frames',1),'original_mode':image.mode,'original_size':[width,height],'working_path':str(source_path),'working_size':[width,height],'working_sha256':target['sha256'],'working_rgb_sha256':digest,'working_conversion':'Decode source RGB directly; no transform or full-frame duplicate','crop_path':str(crop),'crop_pixels':pixels,'crop_size':[hi[0].item()-lo[0].item(),hi[1].item()-lo[1].item()],'crop_sha256':sha(crop)};write(frame,record)
                binary=np.ones((hi[1]-lo[1],hi[0]-lo[0]),np.uint8);mask={**encode_native_mask(binary),'extent':extent}
                x0,y0,x1,y1=extent;polygon=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
                job={'stone_id':stone,'canonical_annotation_id':a['id'],'canonical_asset_id':reference_id,'target_asset_id':target_id,'label':a['label'],'source_sha256':target['sha256'],'source_filename':target['filename'],'version_label':target['filename'],'work_image_sha256':target['sha256'],'crop_path':str(crop),'crop_sha256':record['crop_sha256'],'crop_extent':extent,'pixel_frame_record':str(frame.relative_to(ROOT))}
                path=OUT/'native-proposals'/f'{stone}-{target_id}-{a["id"]}-{tag}.json'
                write(path,{'job':job,'weight_sha256':None,'request':{'method':'native narrative context ROI; requires independent whole-scene visual confirmation','model_used':False},'result':{'detections':[{'native_mask':mask,'polygon':polygon,'localization_overlap':1}]},'visual_reviewed':False})
                proposals.append(path)
        print('STORY REGIONS',stone,target_id,flush=True)
    write(stone_directory(stone)/f'{tag}-context-pending.json',pending)
    return proposals


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['overview','export','sheet'])
    parser.add_argument('stone')
    parser.add_argument('--ids',type=int,nargs='+')
    parser.add_argument('--start',type=int,default=0)
    parser.add_argument('--limit',type=int,default=16)
    args=parser.parse_args()
    if args.command=='overview':overview(args.stone)
    elif args.command=='export':export(args.stone,args.ids or [])
    else:sheet(args.stone,args.start,args.limit)
