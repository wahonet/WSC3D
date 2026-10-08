"""Author an independent scene region observed on its own unaltered native image.

These are manual proposals, with no model score, checkpoint or automatic approval.
Scene regions preserve the composition and background within observed panel edges.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from multiversion_sam import ROOT, OUT, WORK, write
from multiversion_context import BASELINE
from app.sam_worker import encode_native_mask
from app.services import previews


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('spec',type=Path)
    options=parser.parse_args()
    spec=json.loads(options.spec.read_text(encoding='utf-8'))
    inventory=json.loads((OUT/'inventory.json').read_text(encoding='utf-8'))
    baseline=json.loads(BASELINE.read_text(encoding='utf-8'))
    stone=next(s for s in inventory['stones'] if s['stone_id']==spec['stone_id'])
    asset=next(a for a in stone['assets'] if a['id']==spec['target_asset_id'])
    source=next(a for a in baseline['annotations'] if a['id']==spec['canonical_annotation_id'])
    assert asset['sha256']==spec['source_sha256'] and source['stone_id']==stone['stone_id']
    assert source['level'] in ('whole','layer','scene'), 'Manual scene proposals cannot relabel an individual figure'
    work_path=previews.ensure_work_image(asset['id'],asset['relpath'])
    work_sha=hashlib.file_digest(work_path.open('rb'),'sha256').hexdigest()
    with Image.open(work_path) as image:
        width,height=image.size
        assert [width,height]==spec['work_image_size']
        x0,y0,x1,y1=spec['crop_pixels']
        assert 0<=x0<x1<=width and 0<=y0<y1<=height
        crop=image.crop((x0,y0,x1,y1)).convert('RGB')
    tag=spec['tag']
    if not tag.replace('-','').isalnum():raise ValueError('Invalid manual proposal tag')
    crop_path=WORK/'native-inputs'/'manual-scenes'/f"{asset['id']}-{source['id']}-{tag}.png"
    encoded=io.BytesIO();crop.save(encoded,format='PNG')
    crop_sha=hashlib.sha256(encoded.getvalue()).hexdigest()
    crop_path.parent.mkdir(parents=True,exist_ok=True)
    if crop_path.exists():
        assert hashlib.file_digest(crop_path.open('rb'),'sha256').hexdigest()==crop_sha
    else:crop_path.write_bytes(encoded.getvalue())
    binary=np.zeros((crop.height,crop.width),np.uint8)
    for region in spec['regions']:
        points=np.asarray(region['points_px'],float)
        assert points.ndim==2 and points.shape[1]==2 and len(points)>=3 and np.isfinite(points).all()
        assert (points>=0).all() and (points<=[crop.width-1,crop.height-1]).all()
        assert region['operation'] in ('include','exclude')
        cv2.fillPoly(binary,[np.rint(points).astype(np.int32)],int(region['operation']=='include'))
    assert int(binary.sum())>0
    extent=[x0/width,y0/height,x1/width,y1/height]
    mask=encode_native_mask(binary);mask['extent']=extent
    contours,_=cv2.findContours(binary,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    contour=max(contours,key=cv2.contourArea)[:,0]
    points=[[extent[0]+int(x)/crop.width*(extent[2]-extent[0]),
             extent[1]+int(y)/crop.height*(extent[3]-extent[1])] for x,y in contour]
    job={'stone_id':stone['stone_id'],'canonical_annotation_id':source['id'],
         'canonical_asset_id':source['asset_id'],'label':source['label'],'target_asset_id':asset['id'],
         'source_sha256':asset['sha256'],'source_filename':asset['filename'],'version_label':asset['version_label'],
         'work_image_sha256':work_sha,'crop_path':str(crop_path),'crop_sha256':crop_sha,
         'crop_extent':extent,'expected_outline':points,'expected_prompt':'scene','variants':[],
         'localization_method':'manual observation of this native source; no projected final boundary'}
    request={'cmd':'manual_native_scene_boundary','source_spec':str(options.spec.resolve().relative_to(ROOT)),
             'point_frame':'unaltered-native-source-crop-pixels','regions':spec['regions'],
             'scope_note':spec['scope_note']}
    value={'job':job,'request':request,'result':{'ok':True,'detections':[{'native_mask':mask,'polygon':points,'score':None}]},
           'weight_sha256':None,'visual_reviewed':False}
    dest=OUT/'native-proposals'/f"{stone['stone_id']}-{asset['id']}-{source['id']}-manual-scene-{tag}.json"
    if dest.exists():assert json.loads(dest.read_text(encoding='utf-8'))==value,'Manual proposals are immutable'
    else:write(dest,value)
    print(dest,flush=True)


if __name__=='__main__':main()
