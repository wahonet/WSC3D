"""Show every original source of selected stones before deciding same-face correspondence."""
from __future__ import annotations
import argparse,json
from PIL import Image,ImageDraw
from multiversion_align import OUT,image,FONT
import cv2

def main():
    parser=argparse.ArgumentParser();parser.add_argument('stones',nargs='+')
    options=parser.parse_args()
    inventory=json.loads((OUT/'inventory.json').read_text(encoding='utf-8'))
    for stone in inventory['stones']:
        if stone['stone_id'] not in options.stones:continue
        assets=stone['assets'];columns=min(3,len(assets));rows=(len(assets)+columns-1)//columns
        width,height=570,610
        sheet=Image.new('RGB',(columns*width,rows*height+35),'white');draw=ImageDraw.Draw(sheet)
        draw.text((8,5),stone['stone_id']+' '+stone['name']+' 各来源原色图；尚未认定同面可配准',font=FONT,fill='#111')
        for index,asset in enumerate(assets):
            x,y=(index%columns)*width,(index//columns)*height+35
            draw.text((x+6,y+5),f"a{asset['id']} · {asset['kind']} · {asset['width']}×{asset['height']}",font=FONT,fill='#111')
            draw.text((x+6,y+29),asset['filename'],font=FONT,fill='#111')
            panel=Image.fromarray(cv2.cvtColor(image(asset),cv2.COLOR_BGR2RGB))
            panel.thumbnail((width-12,height-70));sheet.paste(panel,(x+(width-panel.width)//2,y+60))
        dest=OUT/'source-review'/f"{stone['stone_id']}-all-sources.jpg"
        dest.parent.mkdir(exist_ok=True);sheet.save(dest,quality=96);print(dest,flush=True)

if __name__=='__main__':main()
