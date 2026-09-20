"""Validate and package the completed Blender photography set without changing images."""
from pathlib import Path
import hashlib
import html
import json
import struct
import zipfile

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/photography'
views = json.loads((OUT/'views.json').read_text(encoding='utf-8'))
hashes = json.loads((OUT/'source-hashes.json').read_text(encoding='utf-8'))
for path, digest in hashes.items():
    assert hashlib.sha256((source_path(path)).read_bytes()).hexdigest() == digest, path
files = []
for view in views:
    name = view['id']+'_'+view['name']
    png, jpg = OUT/'renders'/(name+'.png'), OUT/'jpg'/(name+'.jpg')
    header=png.read_bytes()[:33]
    assert header[:8] == b'\x89PNG\r\n\x1a\n'
    width, height, depth = struct.unpack('>IIB',header[16:25])
    assert (width,height,depth) == (3840,2400,16), (name,width,height,depth)
    assert jpg.stat().st_size>100_000
    files.append({'name':name,'width':width,'height':height,'png_depth':depth,
                  'png_bytes':png.stat().st_size,'jpg_bytes':jpg.stat().st_size,
                  'png_sha256':hashlib.sha256(png.read_bytes()).hexdigest()})

groups=[('que','阙室','庭院、石阙与石狮，以及沿墙排列的题记。'),
        ('xcl','西长廊','灰瓦朱柱之间的光影，与沿墙铺展的汉画像。'),
        ('rear','后展厅','朱红展墙、玻璃展柜与石刻纹理。')]
sections=[]
for zone,title,intro in groups:
    figures=[]
    hero={'que':'02','xcl':'05','rear':'08'}[zone]
    for v in sorted(views,key=lambda v:(v['id']!=hero,v['id'])):
        if v['zone'] != zone:continue
        name=html.escape(v['id']+'_'+v['name'])
        figures.append(f'''<figure><a href="renders/{name}.png" target="_blank"><img src="jpg/{name}.jpg" alt="{html.escape(v['name'])}" loading="lazy" width="3840" height="2400"></a><figcaption><span>{v['id']} · {html.escape(v['name'].split('_',1)[1])}</span><span class="downloads"><a href="jpg/{name}.jpg" download>JPG</a><a href="renders/{name}.png" download>原图 PNG</a></span></figcaption></figure>''')
    sections.append(f'<section id="{zone}"><header><h2>{title}</h2><p>{intro}</p></header><div class="grid">'+''.join(figures)+'</div></section>')
page='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>武氏祠 · 三馆影像</title><style>
*{box-sizing:border-box}body{margin:0;background:#f2f0eb;color:#2a302d;font-family:"Microsoft YaHei",sans-serif}main{max-width:1320px;margin:auto;padding:60px 32px 40px}.masthead{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid #c7c6bd;padding-bottom:30px;margin-bottom:45px}.kicker{font-size:12px;letter-spacing:4px;color:#757c70}h1{font-family:"SimSun",serif;font-size:42px;letter-spacing:5px;font-weight:500;margin:16px 0}p{font-size:14px;line-height:1.8;color:#687065}nav{display:flex;gap:22px;flex-wrap:wrap}a{color:inherit;text-decoration:none}nav a{font-size:14px;border-bottom:1px solid #a9b09e;padding:5px 0}section{margin:54px 0 74px}section header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h2{font-family:"SimSun",serif;font-size:28px;font-weight:500;letter-spacing:6px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:26px}figure{margin:0;min-width:0}figure:first-child{grid-column:1/-1}img{display:block;width:100%;height:auto;background:#262b29}figcaption{display:flex;justify-content:space-between;align-items:center;padding:15px 1px;font-size:13px}.downloads{display:flex;gap:16px;color:#687065;font-size:12px}.downloads a:hover{color:#9b613b}footer{border-top:1px solid #c7c6bd;padding-top:25px;color:#73786f;font-size:12px;line-height:1.9}.info{font-size:13px;color:#767c73;white-space:nowrap}@media(max-width:700px){main{padding:30px 18px}h1{font-size:29px;letter-spacing:2px}.masthead,section header{display:block}.grid{grid-template-columns:1fr;gap:16px}figure:first-child{grid-column:auto}.info{margin-top:20px}section{margin:35px 0 45px}}
</style><main><header class="masthead"><div><div class="kicker">嘉祥 · 武氏墓群石刻</div><h1>三馆影像</h1><nav><a href="#que">阙室</a><a href="#xcl">西长廊</a><a href="#rear">后展厅</a></nav></div><div class="info">9 幅 · 3840 × 2400<br><p>Blender Cycles · 2026.09.11</p></div></header>'''+''.join(sections)+'''<footer>依据当前三维场景和现场照片纹理制作的数字渲染，非现场实拍。文物的布局、尺寸和编号沿用主平台。<br>点击图像查看 16 位无损 PNG；JPG 适合分享。可编辑的 Blender 场景单独提供。</footer></main></html>'''
(OUT/'三馆影像.html').write_text(page,encoding='utf-8')
assert (OUT/'三馆影像_总览.png').is_file(),'Render the final contact sheet first'
notes='''# 武氏祠三馆精细渲染

9 张图，每处 3 张。依据 2026-09-11 主平台最新布局，以 Blender 5.2 Cycles 渲染。

- 分辨率：3840 × 2400。
- PNG：16 位无损原图，位于 renders。
- JPG：质量 96，位于 jpg，便于分享和插入文档。
- 精度：最多 512 采样，自适应噪声阈值 0.006，12 次光线反弹，OpenImageDenoise 降噪。
- 场景：blender/武氏祠_三馆精细摄影.blend，已打包贴图并保存 9 个相机。
- 机位：Blender 时间轴第 1—9 帧对应 9 个相机；各相机自定义属性 exposure 记录本套图的曝光值。
- 浏览：打开“三馆影像.html”，点击图像可查看 PNG 原图。
- 总览：“三馆影像_总览.png”将九个视角排在同一页，便于比较取景。

这是原有建模与照片纹理的可视化渲染，不是现场实拍。精细化包括灯光、玻璃反射、地砖和碎石展床；部分文物仍沿用照片贴图与简化实体，细节以已有资料为限。主平台的布局、模型、门状态及透明度设置未改写。

阙室含两阙两狮、八石题记的最新摆放；后展厅含红色展墙及两块小龛的真实扫描模型。西长廊和后展厅均采用摆放工具当前保存的数据。

图片压缩包包含图集、总览和 9 张 PNG / 9 张 JPG；Blender 场景文件较大，单独提供，不放入图片压缩包。
'''
(OUT/'使用说明.md').write_text(notes,encoding='utf-8')
(OUT/'delivery-verification.json').write_text(json.dumps({'count':len(files),'images':files,'source_files_unchanged':True},ensure_ascii=False,indent=2),encoding='utf-8')
with zipfile.ZipFile(OUT/'武氏祠_三馆4K影像.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=3) as archive:
    for rel in ['三馆影像.html','使用说明.md','三馆影像_总览.png']:
        archive.write(OUT/rel,rel)
    for view in views:
        stem=view['id']+'_'+view['name']
        for folder,ext in [('renders','.png'),('jpg','.jpg')]:
            path=OUT/folder/(stem+ext);archive.write(path,path.relative_to(OUT).as_posix())
with zipfile.ZipFile(OUT/'武氏祠_三馆4K影像.zip','r') as archive:
    assert len(archive.namelist())==21
    assert archive.testzip() is None
print('Verified and packaged 9 4K renders; all live source files unchanged.')
