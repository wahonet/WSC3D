"""Inspect an original colour work image in its documented native pixel frame."""
from __future__ import annotations
import argparse
import json
from PIL import Image, ImageDraw
from multiversion_sam import OUT, FONT
from app.services import previews


def render(asset, edge=1800, step=250):
    path = previews.ensure_work_image(asset['id'], asset['relpath'])
    with Image.open(path) as source:
        image = source.convert('RGB')
    width, height = image.size
    scale = min(1, edge / max(width, height))
    image = image.resize((round(width*scale), round(height*scale)), Image.Resampling.LANCZOS)
    panel = Image.new('RGB', (image.width+62, image.height+100), 'white')
    panel.paste(image, (62, 100))
    draw = ImageDraw.Draw(panel)
    draw.text((8, 5), f"a{asset['id']} {asset['version_label']} · work {width}×{height} · coordinates in original work pixels", font=FONT, fill='#111')
    draw.text((8, 31), asset['filename'], font=FONT, fill='#111')
    for x in range(0, width, step):
        xp=62+round(x*scale)
        draw.text((xp, 75), str(x), font=FONT, fill='#111')
        draw.line((xp,100,xp,panel.height), fill='#ffd598', width=1)
    for y in range(0, height, step):
        yp=100+round(y*scale)
        draw.text((3,yp), str(y), font=FONT, fill='#111')
        draw.line((62,yp,panel.width,yp), fill='#ffd598', width=1)
    dest=OUT/'source-review'/f"asset-{asset['id']}-native-grid.png"
    dest.parent.mkdir(exist_ok=True)
    panel.save(dest)
    print(dest, flush=True)


if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('assets',type=int,nargs='+')
    ap.add_argument('--edge',type=int,default=1800)
    ap.add_argument('--step',type=int,default=250)
    options=ap.parse_args()
    inventory=json.loads((OUT/'inventory.json').read_text(encoding='utf-8'))
    assets={a['id']:a for s in inventory['stones'] for a in s['assets']}
    for ident in options.assets:
        render(assets[ident],options.edge,options.step)
