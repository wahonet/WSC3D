"""Native-pixel inspection grid. Source pixels and stored proposals remain unchanged."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw
from multiversion_sam import OUT, FONT


def render(proposal, scale, region=None):
    saved = json.loads(proposal.read_text(encoding='utf-8'))
    source = Image.open(saved['job']['crop_path']).convert('RGB')
    offset_x, offset_y = 0, 0
    if region:
        x0,y0,x1,y1=region
        if not 0 <= x0 < x1 <= source.width or not 0 <= y0 < y1 <= source.height:
            raise ValueError('Inspection region leaves the native source')
        source=source.crop(region)
        offset_x,offset_y=x0,y0
    image = source.resize((source.width*scale, source.height*scale), Image.Resampling.NEAREST)
    panel = Image.new('RGB', (image.width+50, image.height+50), 'white')
    panel.paste(image, (50, 50))
    draw = ImageDraw.Draw(panel)
    for x in range(0, source.width, 25):
        xp = 50+x*scale
        draw.text((xp, 25), str(x+offset_x), font=FONT, fill='#111')
        draw.line((xp, 50, xp, panel.height), fill='#ffcc88', width=1)
    for y in range(0, source.height, 25):
        yp = 50+y*scale
        draw.text((3, yp), str(y+offset_y), font=FONT, fill='#111')
        draw.line((50, yp, panel.width, yp), fill='#ffcc88', width=1)
    suffix='-region-'+'-'.join(map(str,region)) if region else ''
    path = OUT/'native-details'/f'{proposal.stem}-native-grid{suffix}-{scale}x.png'
    path.parent.mkdir(exist_ok=True)
    panel.save(path)
    print(path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('proposal', type=Path)
    parser.add_argument('--scale', type=int, choices=(1, 2, 3), default=2)
    parser.add_argument('--region', type=int, nargs=4)
    options = parser.parse_args()
    render(options.proposal, options.scale, options.region)
