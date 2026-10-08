"""Recompute proposals from explicitly observed face regions, excluding scene backgrounds.

An ROI only identifies the plane on which to match features. It never supplies a
segmentation outline and never automatically approves a registration.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
from multiversion_align import ROOT,OUT,WORK,PARAMS,image,match_pair,write,similarity
from multiversion_review_alignments import render
from app.services import transforms as tf

FACE_PARAMS={'edge':2200,'features':10000,'contrast_threshold':.012,'exclude_background':True}


def face_features(asset,polygon):
    points=np.asarray(polygon,dtype=float)
    if points.ndim!=2 or points.shape[1]!=2 or len(points)<3 or not np.isfinite(points).all() or np.any(points<0) or np.any(points>1):
        raise ValueError('The face ROI must use normalized original-image coordinates')
    source=image(asset)
    height,width=source.shape[:2]
    px=np.rint(points*[width,height]).astype(np.int32)
    low=np.maximum(0,px.min(0)); high=np.minimum([width,height],px.max(0)+1)
    if min(high-low)<20: raise ValueError('The observed face ROI is too small')
    crop=source[low[1]:high[1],low[0]:high[0]]
    roi=np.zeros(crop.shape[:2],np.uint8)
    cv2.fillPoly(roi,[px-low],255)
    stamp=hashlib.sha256(json.dumps([FACE_PARAMS,asset['sha256'],asset['width'],asset['height'],polygon],sort_keys=True).encode()).hexdigest()[:20]
    path=WORK/'foreground-features'/f"{asset['id']}-{stamp}.npz"
    scale=min(1,FACE_PARAMS['edge']/max(crop.shape[:2]))
    size=(round(crop.shape[1]*scale),round(crop.shape[0]*scale))
    to_original=np.array([[asset['width']/width,0,low[0]*asset['width']/width],
                          [0,asset['height']/height,low[1]*asset['height']/height],[0,0,1.]])
    if path.exists():
        with np.load(path) as data:features={k:data[k] for k in data.files}
    else:
        crop=cv2.resize(crop,size,interpolation=cv2.INTER_AREA)
        roi=cv2.resize(roi,size,interpolation=cv2.INTER_NEAREST)
        gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
        sift=cv2.SIFT_create(nfeatures=FACE_PARAMS['features'],contrastThreshold=FACE_PARAMS['contrast_threshold'],edgeThreshold=12)
        features={'size':np.array(size)}
        for name in PARAMS['variants']:
            target=cv2.GaussianBlur(gray,(9,9) if name=='blur9' else (3,3),0)
            target=cv2.createCLAHE(clipLimit=2.5,tileGridSize=(10,10)).apply(target)
            if name.startswith('inverse'):target=255-target
            keypoints,desc=sift.detectAndCompute(target,roi)
            observed=np.array([k.pt for k in keypoints],np.float32).reshape(-1,2)
            if len(observed) and not np.all(roi[np.rint(observed[:,1]).astype(int).clip(0,size[1]-1),np.rint(observed[:,0]).astype(int).clip(0,size[0]-1)]>0):
                raise ValueError('A feature anchor escaped its observed face ROI')
            features[name+'_points']=observed
            features[name+'_descriptors']=desc if desc is not None else np.empty((0,128),np.float32)
        path.parent.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(path,**features)
    # match_pair maps normalized feature coordinates into these unscaled crop pixels.
    temporary={**asset,'width':int(high[0]-low[0]),'height':int(high[1]-low[1])}
    return temporary,features,to_original


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('spec',type=Path)
    options=ap.parse_args()
    options.spec=options.spec.resolve()
    spec=json.loads(options.spec.read_text(encoding='utf-8'))
    inventory=json.loads((OUT/'inventory.json').read_text(encoding='utf-8'))
    for request in spec['pairs']:
        stone=next(s for s in inventory['stones'] if s['stone_id']==request['stone_id'])
        assets={a['id']:a for a in stone['assets']}
        left,right=assets[request['left_asset_id']],assets[request['right_asset_id']]
        tag=request['tag']
        if not tag.replace('-','').isalnum():raise ValueError('Invalid immutable proposal tag')
        key=f"{stone['stone_id']}-{left['id']}-{right['id']}-{tag}"
        path=OUT/'foreground-proposals'/f'{key}.json'
        if path.exists():
            saved=json.loads(path.read_text(encoding='utf-8'))
            if saved['request']!=request or saved['params']!=FACE_PARAMS:raise ValueError('Existing foreground proposal inputs changed')
            print(key,saved['proposal']['status'],'cached',flush=True)
            continue
        la,lf,lt=face_features(left,request['left_roi'])
        ra,rf,rt=face_features(right,request['right_roi'])
        p=match_pair(la,ra,{left['id']:lf,right['id']:rf})
        p.update(review_key=key,face_regions={'left':request['left_roi'],'right':request['right_roi']},
                 roi_source_spec=str(options.spec.relative_to(ROOT)),face_match_params=FACE_PARAMS,
                 localization_only_for_segmentation=True)
        if p['status']!='no-reliable-match':
            h=lt@np.asarray(p['homography'])@np.linalg.inv(rt)
            p['homography']=(h/h[2,2]).tolist()
            for pair in p['pairs']:
                for side,source,crop,t in (('a',left,la,lt),('b',right,ra,rt)):
                    xy=np.asarray(pair[side])*[crop['width'],crop['height']]
                    mapped=t@[*xy,1]
                    pair[side]=(mapped[:2]/[source['width'],source['height']]).tolist()
            controls=p['pairs']
            sim=similarity(np.asarray([v['b'] for v in controls])*[right['width'],right['height']],
                           np.asarray([v['a'] for v in controls])*[left['width'],left['height']])
            p['sim_matrix']=sim.tolist()
            p['similarity_p95_fraction']=1. # Foreground re-fit is reviewed as a projective model.
            scale=max(lt[0,0],lt[1,1])
            p['projective_holdout_rmse_px']*=scale
            p['rmse_original_px']*=scale
            p['projective_holdout_p95_fraction']*=scale*max(la['width'],la['height'])/max(left['width'],left['height'])
            p['method']='face-ROI-SIFT-distributed-controls-independent-holdout'
            try:
                transform=tf.homography(p['homography'])
                tf.validate_domain(transform,right['width'],right['height'])
                tf.validate_domain(tf.invert(transform),left['width'],left['height'])
                p['whole_source_domain_valid']=True
            except ValueError as e:
                p['whole_source_domain_valid']=False
                p['domain_limitation']=str(e)
            render({**stone,'stone_id':stone['stone_id']+'-'+tag},[p])
        write(path,{'request':request,'params':FACE_PARAMS,'proposal':p,'visual_reviewed':False})
        print(key,p['status'],p.get('inlier_count'),p.get('holdout_count'),flush=True)


if __name__=='__main__':main()
