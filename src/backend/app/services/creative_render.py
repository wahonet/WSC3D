"""One composition engine for browser previews, PNGs, and five-second video cards."""
from __future__ import annotations
from functools import lru_cache
from io import BytesIO
from pathlib import Path
import subprocess
from typing import Literal
from uuid import UUID

from PIL import Image, ImageDraw, ImageFont, ImageOps
from pydantic import BaseModel, ConfigDict, Field, model_validator
from . import creative_store as store

TEMPLATES = {
    'postcard': {'id': 'postcard', 'title': '寄一片汉风', 'category': '动态明信片', 'width': 1440, 'height': 1000, 'video': True},
    'wallpaper': {'id': 'wallpaper', 'title': '把汉画装进口袋', 'category': '手机壁纸', 'width': 1080, 'height': 1920, 'video': False},
    'card': {'id': 'card', 'title': '我的汉画收藏', 'category': '艺术纪念卡', 'width': 1200, 'height': 1500, 'video': False},
    'sticker': {'id': 'sticker', 'title': '一枚汉画', 'category': '透明贴纸', 'width': 1200, 'height': 1200, 'video': False},
}
PALETTES = {
    'cinnabar': {'title': '朱砂', 'bg': '#f9f5eb', 'ink': '#292e2b', 'accent': '#ad4038', 'soft': '#eaddca'},
    'jade': {'title': '青玉', 'bg': '#e9f0e8', 'ink': '#1d4845', 'accent': '#a37b3d', 'soft': '#c9ded3'},
    'midnight': {'title': '星夜', 'bg': '#142f3e', 'ink': '#eee5c8', 'accent': '#d2a957', 'soft': '#285063'},
    'white': {'title': '墨白', 'bg': '#ffffff', 'ink': '#253637', 'accent': '#a34137', 'soft': '#e8ebea'},
}


class Layer(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    material_id: UUID
    x: float = Field(default=50, ge=0, le=100)
    y: float = Field(default=50, ge=0, le=100)
    scale: float = Field(default=1, ge=.15, le=1.5)
    tint: bool = False


class Design(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    template: Literal['postcard', 'wallpaper', 'card', 'sticker'] = 'postcard'
    palette: Literal['cinnabar', 'jade', 'midnight', 'white'] = 'cinnabar'
    title: str = Field(default='风起汉时', max_length=18)
    greeting: str = Field(default='把这一刻，寄给远方的你', max_length=48)
    signature: str = Field(default='', max_length=12)
    stamp: str = Field(default='汉风', max_length=4)
    layers: list[Layer] = Field(min_length=1, max_length=3)

    @model_validator(mode='after')
    def plain_text(self):
        for name in ('title', 'greeting', 'signature', 'stamp'):
            value = getattr(self, name)
            if any(ord(c) < 32 for c in value):
                raise ValueError('文字中不能包含控制字符')
        return self


def templates(internal=False):
    result = []
    for key, value in TEMPLATES.items():
        try:
            entry = store.get('templates', key)
        except FileNotFoundError:
            entry = {'published': False}
        if internal or entry['published']:
            available = bool(entry.get('design'))
            if available and not internal:
                try:
                    available = all(store.get('materials', layer['material_id'])['published'] for layer in entry['design']['layers'])
                except FileNotFoundError:
                    available = False
            visible = entry if internal or available else {k: v for k, v in entry.items() if k != 'design'}
            result.append({**value, **visible, 'cover_url': f'/api/creative/templates/{key}/cover' if available else None})
    return result


def materials(design, internal=False):
    if not internal and design.template not in {t['id'] for t in templates()}:
        raise ValueError('该版式暂未开放')
    values = [store.get('materials', layer.material_id) for layer in design.layers]
    if not internal and any(not v['published'] for v in values):
        raise ValueError('所选素材已下架，请重新选择')
    if sum(v['kind'] == 'video' for v in values) > 1:
        raise ValueError('每张作品可使用一个视频')
    if any(v['kind'] == 'video' for v in values[1:]):
        raise ValueError('请先选择视频，再添加图案')
    if design.template != 'postcard' and any(v['kind'] == 'video' for v in values):
        raise ValueError('视频请使用动态明信片版式')
    if design.template == 'sticker' and any(not (store.folder('materials', v['id'])/'ink.png').is_file() for v in values):
        raise ValueError('透明贴纸请选择标注图案')
    return values


@lru_cache(maxsize=96)
def font(size, serif=False):
    paths = ([Path('C:/Windows/Fonts/simsun.ttc')] if serif else [Path('C:/Windows/Fonts/msyh.ttc')])
    paths += [Path('C:/Windows/Fonts/simhei.ttf')]
    for p in paths:
        if p.is_file():
            return ImageFont.truetype(str(p), int(size))
    raise ValueError('缺少中文字体：请安装宋体或微软雅黑')


def media_box(template):
    return {'postcard': (90, 265, 1260, 555), 'wallpaper': (80, 510, 920, 1000),
            'card': (80, 320, 1040, 890), 'sticker': (90, 80, 1020, 925)}[template]


def _text(draw, xy, text, size, color, maxwidth, serif=False, anchor='lt'):
    size = int(size)
    while size > 16 and draw.textlength(text, font=font(size, serif)) > maxwidth:
        size -= 2
    draw.text(xy, text, fill=color, font=font(size, serif), anchor=anchor)


def _frame(design):
    t, palette = TEMPLATES[design.template], PALETTES[design.palette]
    w, h = t['width'], t['height']
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0) if design.template == 'sticker' else palette['bg'])
    draw = ImageDraw.Draw(canvas)
    ink, accent, soft = palette['ink'], palette['accent'], palette['soft']
    if design.template == 'sticker':
        return canvas
    if design.template == 'postcard':
        draw.line((90, 220, w-90, 220), fill=ink, width=2)
        _text(draw, (90, 64), design.title, 94, ink, w-270, serif=True)
        _text(draw, (94, 181), '济宁 · 嘉祥  /  武氏墓群石刻', 21, accent, w-280)
        _text(draw, (90, h-131), design.greeting, 31, ink, w-310)
        draw.line((90, h-68, w-90, h-68), fill=soft, width=2)
        _text(draw, (90, h-42), '一石一画 · 一见如故', 17, accent, 500)
        _text(draw, (w-90, h-121), design.signature, 25, accent, 230, anchor='rt')
    elif design.template == 'wallpaper':
        # Concentric arcs recall the border rhythms of Han stone rubbings.
        for offset in (0, 24, 50):
            draw.arc((-430-offset, 700-offset, 1420+offset, 2550+offset), 210, 356, fill=soft, width=3)
        _text(draw, (85, 118), '济 宁  ·  嘉 祥', 23, accent, w-220)
        _text(draw, (80, 218), design.title, 120, ink, w-160, serif=True)
        draw.line((85, 428, 252, 428), fill=accent, width=5)
        _text(draw, (85, 1606), design.greeting, 31, ink, w-170)
        _text(draw, (85, 1750), design.signature or '汉画随身', 28, accent, w-250)
        _text(draw, (85, 1824), '武氏墓群石刻', 20, ink, w-220)
    else:
        draw.rectangle((37, 37, w-38, h-38), outline=accent, width=2)
        _text(draw, (80, 85), '武氏墓群石刻  /  汉画收藏', 21, accent, w-230)
        _text(draw, (80, 157), design.title, 100, ink, w-220, serif=True)
        draw.line((80, 1275, w-80, 1275), fill=accent, width=2)
        _text(draw, (80, 1320), design.greeting, 30, ink, w-160)
        _text(draw, (80, 1400), '济宁 · 嘉祥', 20, accent, 400)
        _text(draw, (w-80, 1400), design.signature, 23, ink, 370, anchor='rt')
    if design.stamp:
        x, y = (w-177, 94) if design.template == 'postcard' else (w-168, h-214)
        draw.rounded_rectangle((x, y, x+84, y+84), radius=4, outline=accent, width=3)
        chars = design.stamp
        if len(chars) <= 2:
            for i, char in enumerate(chars):
                _text(draw, (x+42, y+8+i*35), char, 29, accent, 72, serif=True, anchor='mt')
        else:
            for i, char in enumerate(chars):
                _text(draw, (x+23+(i%2)*36, y+9+(i//2)*35), char, 27, accent, 34, serif=True, anchor='mt')
    return canvas


def composition(design, items=None, preview=False, omit_video=False):
    items = items if items is not None else materials(design)
    canvas = _frame(design)
    bx, by, bw, bh = media_box(design.template)
    video = None
    # Clip all movable images to the artwork area so lettering remains legible.
    artwork = Image.new('RGBA', (bw, bh), (0, 0, 0, 0))
    for layer, item in zip(design.layers, items):
        use_ink = (layer.tint or design.template == 'sticker') and (store.folder('materials', item['id']) / 'ink.png').is_file()
        with Image.open(store.material_file(item, 'ink' if use_ink else 'image')) as source:
            image = source.convert('RGBA')
        if use_ink:
            tinted = Image.new('RGBA', image.size, PALETTES[design.palette]['ink'])
            tinted.putalpha(image.getchannel('A'))
            image = tinted
        factor = min(bw / image.width, bh / image.height) * layer.scale
        iw, ih = max(1, round(image.width*factor)), max(1, round(image.height*factor))
        x, y = round(bw*layer.x/100-iw/2), round(bh*layer.y/100-ih/2)
        if item['kind'] == 'video':
            if layer.scale > 1 or x < 0 or y < 0 or x+iw > bw or y+ih > bh:
                raise ValueError('请将视频完整放在画面内')
            video = {'material_id': item['id'], 'x': bx+x, 'y': by+y, 'width': iw//2*2, 'height': ih//2*2}
            if omit_video:
                continue
        image = image.resize((iw, ih), Image.Resampling.LANCZOS)
        artwork.alpha_composite(image, (x, y))
    if omit_video and video:
        ImageDraw.Draw(canvas).rectangle((video['x'], video['y'], video['x']+video['width']-1, video['y']+video['height']-1), fill=(0, 0, 0, 0))
    canvas.alpha_composite(artwork, (bx, by))
    if design.template == 'sticker':
        draw = ImageDraw.Draw(canvas)
        _text(draw, (canvas.width/2, 1050), design.title, 70, PALETTES[design.palette]['ink'], 1080, serif=True, anchor='mt')
    if preview:
        canvas.thumbnail((840, 840), Image.Resampling.LANCZOS)
    return canvas, video


def png(image):
    out = BytesIO()
    image.save(out, 'PNG', optimize=True)
    return out.getvalue()


def export(design, dest, items):
    canvas, video = composition(design, items)
    dest.mkdir(parents=True, exist_ok=True)
    canvas.save(dest / 'image.png', optimize=True)
    thumb = canvas.copy()
    thumb.thumbnail((640, 640), Image.Resampling.LANCZOS)
    thumb.save(dest / 'cover.png')
    if video:
        import imageio_ffmpeg
        # Reuse the already generated clip; no external video API is involved.
        base, _ = composition(design, items, omit_video=True)
        base_path = dest / 'frame.png'
        base.save(base_path)
        src = store.material_file(next(m for m in items if m['id'] == video['material_id']), 'video')
        w, h = video['width'], video['height']
        filter_graph = (f'[1:v]scale={w}:{h}:force_original_aspect_ratio=decrease,'
                        f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={PALETTES[design.palette]["bg"]},setsar=1[v];'
                        f'color=c={PALETTES[design.palette]["bg"]}:s={canvas.width}x{canvas.height}:r=24[bg];'
                        f'[bg][v]overlay={video["x"]}:{video["y"]}:shortest=1[mid];'
                        '[mid][0:v]overlay=0:0:shortest=1,format=yuv420p[out]')
        try:
            result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y',
                '-loop', '1', '-i', str(base_path), '-i', str(src), '-filter_complex', filter_graph,
                '-map', '[out]', '-t', '5', '-r', '24', '-an', '-c:v', 'libx264', '-preset', 'fast',
                '-crf', '20', '-threads', '2', '-filter_complex_threads', '1', '-movflags', '+faststart', str(dest/'video.mp4')],
                capture_output=True, timeout=100, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        finally:
            base_path.unlink(missing_ok=True)
        if result.returncode:
            raise ValueError('动态卡片合成失败')
    return {'width': canvas.width, 'height': canvas.height, 'video': bool(video), 'duration': 5 if video else None}
