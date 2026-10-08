"""Inspect every native SAM detection instead of only the locator-overlap winner."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import cv2
import numpy as np
from PIL import Image,ImageDraw
from multiversion_sam import OUT,decode,FONT


def render(path):
    saved=json.loads(path.read_text(encoding='utf-8'))
    job=saved['job']
    original=Image.open(job['crop_path']).convert('RGB')
    tiles=[('本源原色局部',original)]
    for index,detection in enumerate(saved['result']['detections']):
        mask=Image.fromarray(decode(detection['native_mask'])*255).resize(original.size,Image.Resampling.NEAREST)
        binary=np.asarray(mask)>0
        source=np.asarray(original).copy()
        source[~binary]=[230,230,230]
        edges=cv2.dilate(binary.astype(np.uint8),np.ones((3,3),np.uint8))-cv2.erode(binary.astype(np.uint8),np.ones((3,3),np.uint8))
        source[edges>0]=[255,70,30]
        tiles.append((f'detection {index} · score {detection["score"]:.3f}',Image.fromarray(source)))
    width,height,columns=430,450,3
    sheet=Image.new('RGB',(width*columns,math.ceil(len(tiles)/columns)*height+65),'white')
    draw=ImageDraw.Draw(sheet)
    draw.text((8,6),path.stem,font=FONT,fill='black')
    draw.text((8,32),'全部候选逐项检查 · 原生边界另以像素细图验收',font=FONT,fill='#9b271b')
    for i,(label,img) in enumerate(tiles):
        img.thumbnail((width-16,height-45))
        x=(i%columns)*width;y=(i//columns)*height+65
        draw.text((x+8,y),label,font=FONT,fill='black')
        sheet.paste(img,(x+(width-img.width)//2,y+33))
    out=OUT/'native-review'/f'{path.stem}-all-candidates.jpg'
    sheet.save(out,quality=95)
    print(out,flush=True)


if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('proposals',type=Path,nargs='+')
    for path in ap.parse_args().proposals:render(path)
