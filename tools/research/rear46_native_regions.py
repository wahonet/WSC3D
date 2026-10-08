"""Prepare a directly observed native region for an unmarked source occurrence.

The region and expected rectangle are localization only, never a final outline.
This reads sources and writes immutable inputs; it does not modify the database.
"""
from __future__ import annotations
import argparse,json,sqlite3
from pathlib import Path
import numpy as np
from PIL import Image
from app.services.resources import asset_path
from app.native_masks import MAX_NATIVE_MASK_PIXELS
from multiversion_context import ROOT,OUT,WORK
from multiversion_sam import write
from multiversion_pixel_frames import validate_pixel_frame
from rear46_native_inputs import sha

Image.MAX_IMAGE_PIXELS=None

def prepare(canonical_id,asset_id,pixels,evidence,tag,prompt):
    evidence=Path(evidence).resolve()
    assert evidence.is_relative_to(OUT.resolve()) and evidence.is_file()
    with sqlite3.connect((ROOT/'data/stonelab.db').as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        canonical=dict(db.execute('SELECT * FROM annotations WHERE id=?',(canonical_id,)).fetchone())
        asset=dict(db.execute('SELECT * FROM assets WHERE id=?',(asset_id,)).fetchone())
    stone=canonical['stone_id']
    assert stone in [f'武{i:03d}' for i in range(8,54)] and asset['stone_id']==stone
    assert canonical['level'] in ('figure','component','scene','layer','band')
    source=asset_path(asset['relpath']);assert sha(source)==asset['sha256']
    assert len(pixels)==4 and all(type(n) is int for n in pixels)
    x0,y0,x1,y1=pixels
    assert 0<=x0<x1<=asset['width'] and 0<=y0<y1<=asset['height']
    assert (x1-x0)*(y1-y0)<=MAX_NATIVE_MASK_PIXELS,'Keep all subject pixels; larger native masks require explicit platform support'
    frame=WORK/'native-frames'/f'{asset_id}-frame0.png'
    crop=WORK/'native-inputs'/f'{asset_id}-{canonical_id}-{tag}.png'
    crop.parent.mkdir(parents=True,exist_ok=True);frame.parent.mkdir(parents=True,exist_ok=True)
    with Image.open(source) as original:
        original.seek(0);rgb=original.convert('RGB');assert original.size==(asset['width'],asset['height'])
        if frame.exists():
            with Image.open(frame) as saved:assert np.array_equal(np.asarray(saved),np.asarray(rgb))
        else:rgb.save(frame)
        local=rgb.crop(pixels)
        if crop.exists():
            with Image.open(crop) as saved:assert np.array_equal(np.asarray(saved),np.asarray(local))
        else:local.save(crop)
        record={'source_file':str(source),'source_sha256':asset['sha256'],'frame_index':0,
          'frame_count':getattr(original,'n_frames',1),'original_mode':original.mode,
          'original_size':list(original.size),'working_size':list(original.size),
          'working_conversion':'Pillow RGB decode; no resize, enhancement or EXIF transform',
          'icc_profile_sha256':__import__('hashlib').sha256(original.info['icc_profile']).hexdigest() if original.info.get('icc_profile') else None,
          'working_path':str(frame),'working_sha256':sha(frame),'crop_pixels':pixels,'crop_size':list(local.size),
          'crop_path':str(crop),'crop_sha256':sha(crop),'observed_crop_evidence':{'path':str(evidence),'sha256':sha(evidence)}}
    record_path=OUT/'stones'/stone/'pixel-frames'/f'{asset_id}-{canonical_id}-{tag}.json'
    if record_path.exists():assert json.loads(record_path.read_text(encoding='utf-8'))==record
    else:write(record_path,record)
    extent=[x0/asset['width'],y0/asset['height'],x1/asset['width'],y1/asset['height']]
    job={'stone_id':stone,'canonical_annotation_id':canonical_id,'canonical_asset_id':canonical['asset_id'],
      'target_asset_id':asset_id,'label':canonical['label'],'source_sha256':asset['sha256'],
      'source_filename':asset['filename'],'version_label':'来源批次未注明 · '+asset['filename'],
      'localization_annotation_id':None,'work_image_sha256':record['working_sha256'],'crop_path':str(crop),
      'crop_sha256':record['crop_sha256'],'crop_extent':extent,'expected_outline':[[extent[0],extent[1]],[extent[2],extent[1]],[extent[2],extent[3]],[extent[0],extent[3]]],
      'expected_prompt':prompt,'localization_method':'Direct observed source region only; no cross-source projection or final polygon acceptance',
      'localization_evidence':str(evidence.relative_to(OUT)),'pixel_frame_record':str(record_path.relative_to(ROOT)),
      'proposal_tag':tag,'variants':['native','rubbing']}
    validate_pixel_frame(job)
    path=WORK/f'native-jobs-{stone}-{asset_id}-{canonical_id}-{tag}.json'
    if path.exists():assert json.loads(path.read_text(encoding='utf-8'))==[job]
    else:write(path,[job])
    return path

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--canonical-id',required=True,type=int);p.add_argument('--asset-id',required=True,type=int)
    p.add_argument('--crop-pixels',nargs=4,type=int,required=True);p.add_argument('--evidence',required=True,type=Path)
    p.add_argument('--tag',required=True);p.add_argument('--prompt',required=True)
    a=p.parse_args();print(prepare(a.canonical_id,a.asset_id,a.crop_pixels,a.evidence,a.tag,a.prompt))
