"""Map the five omitted hall stones from supplied photographs; originals stay intact.

Roof-shaped faces use five measured image landmarks, including the actual carved
edge below the stone's top surface. Piecewise affine projection fits the existing
schematic perimeter without painting the display-room background onto the slopes.
"""
from pathlib import Path
import hashlib
import json
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/hall-textures'
DEST = ROOT / 'resources/scenes/textures/stones'
# Polygon order: bottom left, bottom right, right shoulder, apex, left shoulder.
# Source coordinates are fractions of the supplied photograph; no invented pixels.
SPECS = [
    dict(id='42 耳杯盛鱼', face='top', key='dc2fbac25c39a6cca2f0', size=(4096,1520),
         quad=[(.047,.024),(.990,.026),(.958,.973),(.023,.954)],
         normal=[0,1,0], up=[0,0,-1], rotate=180, label='供案顶面：耳杯、鱼与圆孔', primary=True),
    dict(id='38 东北墓间', face='front', key='fc9f3a9d5c6b208e8a71', size=(3050,3200),
         quad=[(.045,.066),(.890,.081),(.875,.973),(.028,.966)],
         normal=[0,0,1], up=[0,1,0], label='东北墓间画像雕刻正面', primary=True),
    dict(id='26 左石室隔梁东面', face='east', key='104d38fbb413882bc053', size=(4096,1097),
         polygon=[(.043,.974),(.956,.968),(.988,.529),(.554,.022),(.018,.594)],
         shoulders=(.28/.64,.28/.64), normal=[0,0,1], up=[0,1,0], label='三角隔梁东面', primary=True),
    dict(id='26 左石室隔梁东面', face='west', key='e6bd16152064a30dc432', size=(4096,1097),
         polygon=[(.047,.953),(.959,.954),(.985,.518),(.436,.031),(.023,.510)],
         shoulders=(.28/.64,.28/.64), normal=[0,0,-1], up=[0,1,0], label='三角隔梁西面', primary=False),
    dict(id='43 舞蹈画像石', face='front', key='b7b353e17be1ca903fc0', size=(4096,1024),
         quad=[(.033,.031),(.980,.027),(.987,.953),(.011,.974)],
         normal=[0,0,1], up=[0,1,0], label='舞蹈画像完整雕刻面', primary=True, focusLift=1.2),
    dict(id='41 蔡题三石', face='front', key='38df7af5319c04da2423', size=(4096,1096),
         polygon=[(.104,.830),(.895,.788),(.965,.568),(.520,.249),(.026,.648)],
         shoulders=(.19/.57,.25/.57), normal=[0,0,1], up=[0,1,0], label='蔡题三石正面', primary=True, focusLift=.9),
    dict(id='41 蔡题三石', face='back', key='3c191e22102b982fb596', size=(4096,1096),
         polygon=[(.017,.949),(.989,.948),(.981,.551),(.507,.041),(.020,.642)],
         shoulders=(.25/.57,.19/.57), normal=[0,0,-1], up=[0,1,0], label='蔡题三石背面', primary=False),
]


def rectify(im, spec):
    size = spec['size']
    if 'quad' in spec:
        q = spec['quad']
        coords = tuple(v for i in (0,3,2,1) for v in (q[i][0]*im.width, q[i][1]*im.height))
        result = im.transform(size, Image.Transform.QUAD, coords, Image.Resampling.BICUBIC)
        if spec.get('rotate') == 180:
            result = result.transpose(Image.Transpose.ROTATE_180)
        return result, [(0,0),(1,0),(1,1),(0,1)]
    hl, hr = spec['shoulders']
    perimeter = [(0,1),(1,1),(1,1-hr),(.5,0),(0,1-hl)]
    target = np.asarray(perimeter) * size
    source = np.asarray(spec['polygon']) * im.size
    result = Image.new('RGB', size, '#7e7b71')
    for indices in ((0,1,3),(1,2,3),(0,3,4)):
        tri = target[list(indices)]
        matrix = np.column_stack([tri, np.ones(3)])
        sx, sy = np.linalg.solve(matrix, source[list(indices)]).T
        transformed = im.transform(size, Image.Transform.AFFINE, (*sx,*sy), Image.Resampling.BICUBIC)
        mask = Image.new('L', size)
        ImageDraw.Draw(mask).polygon([tuple(p) for p in tri], fill=255)
        result.paste(transformed, mask=mask)
    return result, perimeter


def main():
    manifest = ROOT / 'src/frontend/src/archive/three/stoneTextureManifest.json'
    data = json.loads(manifest.read_text(encoding='utf-8'))
    affected = {s['id'] for s in SPECS}
    data['entries'] = [e for e in data['entries'] if e['id'] not in affected]
    data['excluded'] = [e for e in data.get('excluded',[]) if e['id'] not in affected]
    records = []
    sheet = Image.new('RGB', (1500, 1350), '#252b31')
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',22)
    for index, spec in enumerate(SPECS):
        folder = stone_dir(spec['id'])
        meta = json.loads((folder/'metadata/catalogue.json').read_text(encoding='utf-8'))
        media = json.loads((folder/'metadata/media.json').read_text(encoding='utf-8'))
        item = next(p for p in media['items'] if p['id'] == spec['key'])
        path = stone_file(spec['id'], item['file'])
        im = Image.open(path).convert('RGB')
        rect, perimeter = rectify(im,spec)
        file = f"hall-{meta['catalogue_no'][1:]}-{spec['face']}-20260910.webp"
        rect.save(DEST/file, quality=95, method=6)
        entry = dict(id=spec['id'], faceKey=spec['face'], faceLabel=spec['label'],
            file=file, imageSize=list(rect.size), crop=[0,0,*rect.size], fit='face',
            normal=spec['normal'], up=spec['up'], primaryFace=spec['primary'], focusLift=spec.get('focusLift',.25),
            sourceKind='supplied-photograph', sourcePath=path.relative_to(ROOT).as_posix(),
            sourceSha256=hashlib.sha256(path.read_bytes()).hexdigest(), sourceVersion=item['version'],
            sourceOriginal=item['original'], sourceLandmarks=spec.get('quad',spec.get('polygon')),
            targetPerimeter=perimeter, imageRotationDeg=spec.get('rotate',0),
            mappingEvidence='按整理目录及不同年份纹饰逐面核对；耳杯盛鱼按2025年实照及原扫描确认平放顶面；蔡题三石正面取2010年完整照片，2025年照片两端未完整入镜。',
            imageTreatment='Geometric rectification of supplied photos only; no generated archaeological imagery')
        records.append(entry)
        col,row=index%2,index//2
        x,y=col*750,row*325
        draw.text((x+15,y+10),meta['catalogue_no']+' '+spec['label']+' / '+item['version'],font=font,fill='white')
        preview=rect.copy()
        preview.thumbnail((715,263))
        sheet.paste(preview,(x+(750-preview.width)//2,y+50+(263-preview.height)//2))
    data['entries'] += records
    data['description'] = '按文物和石面登记照片贴图；含转角、双面三角隔梁、蔡题三石及耳杯盛鱼顶面'
    manifest.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    (OUT/'mapped-faces.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    sheet.save(OUT/'rectified-faces.jpg',quality=94)
    # Correct only the public label; retain both source filename and copied original.
    media_path=stone_file('41 蔡题三石', 'media.json')
    media=json.loads(media_path.read_text(encoding='utf-8'))
    front=next(p for p in media['items'] if p['id']=='3deb4f05b958f541b090')
    front['label']='蔡题三石（正面）-A-03（2025年任超）'
    front['depicted_face']='正面'
    front['label_correction_note']='原文件位于“正面”目录，文件名误写“背面”；与2010年正面照片纹饰及断裂轮廓核对后修正展示名称，原文件名保留。'
    media_path.write_text(json.dumps(media,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'stones':len(affected),'faces':len(records),'photos_copied_originals_unchanged':True},ensure_ascii=False))


if __name__ == '__main__':
    main()
