"""One composition engine for theme products, visitor variants and printable cards.

The renderer is pure: creative_themes resolves a theme into a context of files
and texts, and this module turns that context into images. Nothing here calls a
model or the network, so visitor requests stay local to the venue.
"""
from __future__ import annotations
from datetime import date
from functools import lru_cache
from io import BytesIO
from pathlib import Path
import subprocess
from typing import Literal

import qrcode
from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFilter, ImageFont, ImageOps
from pydantic import BaseModel, ConfigDict, Field, model_validator
from ..config import settings

PRODUCTS = {
    'wallpaper': {'title': '手机壁纸', 'use': '锁屏、主屏', 'width': 1290, 'height': 2796},
    'postcard': {'title': '电子明信片', 'use': '写一句话寄给朋友', 'width': 1800, 'height': 1200},
    'postcard_video': {'title': '动态明信片', 'use': '五秒动态画面', 'width': 1440, 'height': 960, 'video': True},
    'card': {'title': '观展纪念卡', 'use': '今天的观展留念', 'width': 1200, 'height': 1800},
    'avatar': {'title': '头像', 'use': '微信、社交头像', 'width': 640, 'height': 640},
    'emoji': {'title': '表情包', 'use': '一组六张，聊天使用', 'width': 240, 'height': 240},
    'print_postcard': {'title': '打印明信片', 'use': '148 × 100 mm，含 3 mm 出血', 'width': 1819, 'height': 1252, 'dpi': 300},
    'print_stickers': {'title': '打印表情贴纸', 'use': '148 × 100 mm，沿虚线剪下', 'width': 1819, 'height': 1252, 'dpi': 300},
    'stamp_card': {'title': '集章纪念卡', 'use': '集齐七枚展厅印章', 'width': 1200, 'height': 1800},
}
CUSTOM = ('wallpaper', 'postcard', 'card', 'avatar')
PALETTES = {
    'cinnabar': {'title': '朱砂', 'bg': '#f7f1e3', 'ink': '#2a2d2a', 'accent': '#a8392f', 'soft': '#e7dac4'},
    'jade': {'title': '青玉', 'bg': '#e6eee6', 'ink': '#1d4541', 'accent': '#9c7437', 'soft': '#c6d9cd'},
    'midnight': {'title': '星夜', 'bg': '#132b39', 'ink': '#efe6c9', 'accent': '#d3a954', 'soft': '#27495a'},
    'white': {'title': '墨白', 'bg': '#fdfdfb', 'ink': '#243334', 'accent': '#a13d33', 'soft': '#e6e9e7'},
}
VENUE = '武氏祠汉文化保护传承中心'
FONT_DIR = settings.resources_dir / 'creative' / 'fonts'
FONTS = {'serif': ('NotoSerifSC-VF.ttf', 'C:/Windows/Fonts/simsun.ttc'), 'kai': ('LXGWWenKai-Regular.ttf', 'C:/Windows/Fonts/simkai.ttf')}


class Design(BaseModel):
    """A visitor's variant of a published theme product."""
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    theme: str = Field(pattern=r'^[a-z0-9-]{2,40}$')
    product: Literal['wallpaper', 'postcard', 'card', 'avatar'] = 'postcard'
    palette: Literal['cinnabar', 'jade', 'midnight', 'white'] = 'cinnabar'
    art: Literal['color', 'line'] = 'color'
    variant: int = Field(default=0, ge=0, le=1)
    greeting: str = Field(default='', max_length=48)
    signature: str = Field(default='', max_length=12)
    motion: bool = False

    @model_validator(mode='after')
    def plain_text(self):
        for name in ('greeting', 'signature'):
            if any(ord(c) < 32 for c in getattr(self, name)):
                raise ValueError('文字中不能包含控制字符')
        if self.motion and self.product != 'postcard':
            raise ValueError('动态效果只用于明信片')
        return self


# ------------------------------------------------------------------ text

@lru_cache(maxsize=128)
def font(kind, size, weight=None):
    bundled, system = FONTS[kind]
    for path in (FONT_DIR / bundled, Path(system)):
        if path.is_file():
            value = ImageFont.truetype(str(path), max(8, int(size)))
            if weight and path.name.endswith('-VF.ttf'):
                value.set_variation_by_axes([weight])
            return value
    raise ValueError('缺少中文字体：请恢复 resources/creative/fonts')


def fitted(draw, text, kind, size, width, weight=None, minimum=14):
    size = int(size)
    while size > minimum and draw.textlength(text, font=font(kind, size, weight)) > width:
        size -= 2
    return font(kind, size, weight)


NO_START = set('，。、；：！？）」』”’》〉…·')


def wrap(draw, text, face, width, lines=3):
    rows, current = [], ''
    for char in text:
        if draw.textlength(current + char, font=face) <= width or not current or char in NO_START:
            current += char
        else:
            rows.append(current)
            current = char
    if current:
        rows.append(current)
    if len(rows) > lines:
        rows = rows[:lines]
        rows[-1] = rows[-1][:-1] + '…'
    return rows


def paragraph(draw, xy, text, face, fill, width, spacing=1.55, lines=3, anchor='la'):
    x, y = xy
    step = round(face.size * spacing)
    for row in wrap(draw, text, face, width, lines):
        draw.text((x, y), row, font=face, fill=fill, anchor=anchor)
        y += step
    return y


# ------------------------------------------------------------------ images

def rgba(color, alpha=255):
    color = color.lstrip('#')
    return tuple(int(color[i:i+2], 16) for i in (0, 2, 4)) + (alpha,)


def deepen(color, amount):
    """Mix a colour toward black so it still reads at chat-sticker size."""
    return '#' + ''.join(f'{round(v * (1 - amount)):02x}' for v in rgba(color)[:3])


def contain(image, width, height, scale=1.0):
    factor = min(width / image.width, height / image.height) * scale
    return image.resize((max(1, round(image.width*factor)), max(1, round(image.height*factor))), Image.Resampling.LANCZOS)


def load(path):
    with Image.open(path) as image:
        return image.convert('RGBA')


def trim(image, pad=0.02):
    box = image.getchannel('A').getbbox()
    if not box:
        return image
    margin = round(max(image.size) * pad)
    return image.crop((max(0, box[0]-margin), max(0, box[1]-margin), min(image.width, box[2]+margin), min(image.height, box[3]+margin)))


def tint(ink_image, color, alpha=1.0):
    mask = ink_image.getchannel('A')
    if alpha < 1:
        mask = mask.point(lambda v: round(v * alpha))
    layer = Image.new('RGBA', ink_image.size, rgba(color))
    layer.putalpha(mask)
    return layer


def art(ctx, choice, palette, variant=0):
    """The artwork and its provenance label; line art takes the palette's ink."""
    colors = ctx.get('colors') or []
    if choice == 'color' and colors:
        return load(colors[min(variant, len(colors)-1)]), 'color'
    if ctx.get('line'):
        return tint(trim(load(ctx['line'])), PALETTES[palette]['ink']), ctx.get('line_kind', 'line')
    if colors:
        return load(colors[0]), 'color'
    raise ValueError('主题尚未准备图案')


def framed(image, kind, palette, width, height):
    """Place the art inside a box; colour renditions get a thin museum frame."""
    fit = contain(image, width, height)
    if kind != 'color':
        return fit
    p = PALETTES[palette]
    out = Image.new('RGBA', (fit.width + 16, fit.height + 16), (0, 0, 0, 0))
    shadow = Image.new('RGBA', out.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle((8, 12, out.width-6, out.height-2), fill=(0, 0, 0, 46))
    out.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))
    out.alpha_composite(fit, (8, 8))
    ImageDraw.Draw(out).rectangle((8, 8, 8+fit.width-1, 8+fit.height-1), outline=rgba(p['ink'], 70), width=2)
    return contain(out, width, height)


def split_column(image, kind):
    """The emptiest column near the middle, so a frieze is cut between two figures."""
    if kind == 'color':
        profile = ImageOps.grayscale(image.convert('RGB')).filter(ImageFilter.FIND_EDGES)
    else:
        profile = image.getchannel('A')
    values = list(profile.resize((image.width, 1), Image.Resampling.BOX).getdata())
    start, end = round(image.width * .35), round(image.width * .65)
    return min(range(start, end), key=lambda x: (values[x], abs(x - image.width/2)))


def placed(image, kind, palette, width, height):
    """Art fitted to a box; a very wide frieze becomes two registers in reading order."""
    if image.width < image.height * 2.6 or width > height * 1.5:
        return framed(image, kind, palette, width, height)
    x = split_column(image, kind)
    halves = [image.crop((0, 0, x, image.height)), image.crop((x, 0, image.width, image.height))]
    if kind != 'color':
        halves = [trim(h) for h in halves]
    gap = round(height * .05)
    parts = [framed(h, kind, palette, width, (height - gap) // 2) for h in halves]
    out = Image.new('RGBA', (max(p.width for p in parts), parts[0].height + gap + parts[1].height), (0, 0, 0, 0))
    out.alpha_composite(parts[0], ((out.width - parts[0].width) // 2, 0))
    out.alpha_composite(parts[1], ((out.width - parts[1].width) // 2, parts[0].height + gap))
    return out


def paste_center(canvas, image, box):
    x0, y0, x1, y1 = box
    canvas.alpha_composite(image, (round(x0 + (x1-x0-image.width)/2), round(y0 + (y1-y0-image.height)/2)))
    return round(x0 + (x1-x0-image.width)/2), round(y0 + (y1-y0-image.height)/2), image.width, image.height


def qr_tile(url, size, palette):
    """Dark modules on a light tile, so every phone camera can read it on any palette."""
    code = qrcode.QRCode(border=0, error_correction=qrcode.constants.ERROR_CORRECT_M)
    code.add_data(url)
    code.make(fit=True)
    matrix = code.get_matrix()
    p = PALETTES[palette]
    dark = palette == 'midnight'
    light, modules = (rgba(p['ink']), rgba(p['bg'])) if dark else (rgba('#ffffff'), rgba(p['ink']))
    quiet = 4
    cells = len(matrix) + quiet*2
    unit = max(1, size // cells)
    tile = Image.new('RGBA', (unit*cells, unit*cells), light)
    draw = ImageDraw.Draw(tile)
    for y, row in enumerate(matrix):
        for x, value in enumerate(row):
            if value:
                draw.rectangle(((x+quiet)*unit, (y+quiet)*unit, (x+quiet+1)*unit-1, (y+quiet+1)*unit-1), fill=modules)
    # Integer module sizes avoid uneven one-pixel cells in small sticker QR codes.
    out = Image.new('RGBA', (size, size), light)
    out.alpha_composite(tile, ((size-tile.width)//2, (size-tile.height)//2))
    return out


def seal(text, size, color, rough=True):
    """A square seal; used for product stamps and the hall stamp collection."""
    scale = 4
    s = size * scale
    mask = Image.new('L', (s, s), 0)
    draw = ImageDraw.Draw(mask)
    edge = round(s * .055)
    draw.rounded_rectangle((edge//2, edge//2, s-edge//2, s-edge//2), radius=round(s*.08), outline=255, width=edge)
    chars = list(text[:4])
    if len(chars) <= 2:
        face = font('serif', s * .36, 800)
        for i, char in enumerate(chars):
            draw.text((s/2, s*(.3 if len(chars) == 2 else .5) + i*s*.4), char, font=face, fill=255, anchor='mm')
    else:
        face = font('serif', s * .3, 800)
        order = [(1, 0), (1, 1), (0, 0), (0, 1)] if len(chars) == 4 else [(1, 0), (0, 0), (0, 1)]
        for char, (col, row) in zip(chars, order):
            draw.text((s*(.29 + col*.42), s*(.3 + row*.4)), char, font=face, fill=255, anchor='mm')
    if rough:
        # Irregular ink coverage, deterministic per text, keeps the seal from looking typeset.
        noise = Image.effect_noise((s//8, s//8), 64).resize((s, s), Image.Resampling.BICUBIC)
        grain = noise.point(lambda v: 0 if v < 70 else 255).filter(ImageFilter.GaussianBlur(scale))
        mask = ImageChops.multiply(mask, grain.point(lambda v: 255 if v > 90 else round(v*2.2)))
    layer = Image.new('RGBA', (s, s), rgba(color))
    layer.putalpha(mask)
    return layer.resize((size, size), Image.Resampling.LANCZOS)


def provenance(ctx, kind):
    label = {'color': '艺术演绎', 'line': '艺术演绎（据拓片线描）',
             'rubbing': '艺术演绎（拓片衍生）'}.get(kind, '据原石')
    return f"武氏墓群石刻 · {ctx['stone_id']} {ctx['stone_name']} · {label}"


def footer(canvas, ctx, kind, palette, box, qr_size, text_size, align='left'):
    """The fixed provenance line and QR back to the archive page; never optional."""
    x0, y0, x1, y1 = box
    draw = ImageDraw.Draw(canvas)
    p = PALETTES[palette]
    tile = qr_tile(ctx['archive_url'], qr_size, palette)
    if align == 'left':
        canvas.alpha_composite(tile, (x1-qr_size, y1-qr_size))
        face = fitted(draw, provenance(ctx, kind), 'serif', text_size, x1-x0-qr_size-30)
        draw.text((x0, y1-qr_size/2-text_size*.75), provenance(ctx, kind), font=face, fill=p['ink'], anchor='lm')
        draw.text((x0, y1-qr_size/2+text_size*.85), '扫码查看这块原石', font=font('serif', text_size*.82), fill=p['accent'], anchor='lm')
    else:
        canvas.alpha_composite(tile, (round((x0+x1-qr_size)/2), y0))
        face = fitted(draw, provenance(ctx, kind), 'serif', text_size, x1-x0)
        draw.text(((x0+x1)/2, y0+qr_size+text_size*1.1), provenance(ctx, kind), font=face, fill=p['ink'], anchor='mm')


def compact_provenance(canvas, ctx, box, qr_size, text_size):
    """A light archive label for small products; QR modules stay at native size."""
    x0, y0, x1, y1 = box
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(box, radius=4, fill='#ffffff')
    xqr, yqr = x1-qr_size-4, round((y0+y1-qr_size)/2)
    canvas.alpha_composite(qr_tile(ctx['archive_url'], qr_size, 'white'), (xqr, yqr))
    width = xqr-x0-10
    for i, text in enumerate((f"武氏墓群 · {ctx['stone_id']}", '艺术演绎', '扫码查原石')):
        draw.text((x0+5, round(y0+(y1-y0)*(i+1)/4)), text,
                  font=fitted(draw, text, 'serif', text_size, width, minimum=8), fill='#243334', anchor='lm')
    return canvas


# ------------------------------------------------------------------ products

def texts(ctx, design):
    greeting = (design or {}).get('greeting') or (ctx.get('greetings') or [''])[0]
    return ctx['title'], ctx.get('hook', ''), greeting, (design or {}).get('signature', '')


def watermark(canvas, image, palette, box, alpha=.07):
    if image is None:
        return
    mark = contain(tint(image, PALETTES[palette]['soft'] if palette != 'white' else '#dfe3e1'), box[2]-box[0], box[3]-box[1])
    mark.putalpha(mark.getchannel('A').point(lambda v: round(v * min(1, alpha*10))))
    paste_center(canvas, mark, box)


def line_image(ctx):
    return trim(load(ctx['line'])) if ctx.get('line') else None


def wallpaper(ctx, palette, choice, variant, design=None):
    w, h = PRODUCTS['wallpaper']['width'], PRODUCTS['wallpaper']['height']
    p = PALETTES[palette]
    canvas = Image.new('RGBA', (w, h), p['bg'])
    draw = ImageDraw.Draw(canvas)
    # Top 22 % is left to the lock-screen clock, bottom 14 % to system gestures.
    watermark(canvas, line_image(ctx), palette, (-180, 40, w+180, 820), .06)
    image, kind = art(ctx, choice, palette, variant)
    paste_center(canvas, placed(image, kind, palette, w-170, 1180), (85, 660, w-85, 1860))
    title, hook, greeting, signature = texts(ctx, design)
    draw.text((w/2, 1985), title, font=fitted(draw, title, 'serif', 112, w-200, 700), fill=p['ink'], anchor='mm')
    draw.line((w/2-70, 2078, w/2+70, 2078), fill=p['accent'], width=4)
    line = greeting if design else hook
    if line:
        draw.text((w/2, 2150), line, font=fitted(draw, line, 'kai', 46, w-220), fill=p['ink'], anchor='mm')
    if signature:
        draw.text((w/2, 2222), signature, font=fitted(draw, signature, 'kai', 38, w-300), fill=p['accent'], anchor='mm')
    footer(canvas, ctx, kind, palette, (85, 2250, w-85, 2400), 140, 27)
    return canvas


def postcard(ctx, palette, choice, variant, design=None, omit_art=False):
    w, h = PRODUCTS['postcard']['width'], PRODUCTS['postcard']['height']
    p = PALETTES[palette]
    canvas = Image.new('RGBA', (w, h), p['bg'])
    draw = ImageDraw.Draw(canvas)
    art_box = (70, 70, 1130, 1130)
    image, kind = art(ctx, choice, palette, variant)
    video_box = None
    if omit_art:
        fit = contain(image, art_box[2]-art_box[0], art_box[3]-art_box[1])
        x, y, iw, ih = paste_center(Image.new('RGBA', (w, h)), fit, art_box)
        video_box = (x, y, iw, ih)
    else:
        paste_center(canvas, placed(image, kind, palette, art_box[2]-art_box[0], art_box[3]-art_box[1]), art_box)
    draw.line((1190, 70, 1190, 1130), fill=p['soft'], width=2)
    right = (1250, w-80)
    title, hook, greeting, signature = texts(ctx, design)
    canvas.alpha_composite(seal('汉画', 118, p['accent']), (right[1]-118, 78))
    draw.text((right[0], 90), '济宁 · 嘉祥', font=font('serif', 26), fill=p['accent'])
    draw.text((right[0], 140), title, font=fitted(draw, title, 'serif', 84, right[1]-right[0]-130, 700), fill=p['ink'])
    y = 290
    if hook:
        y = paragraph(draw, (right[0], y), hook, font('kai', 34), p['ink'], right[1]-right[0], 1.5, 2) + 30
    draw.line((right[0], y, right[0]+90, y), fill=p['accent'], width=3)
    y += 50
    if greeting:
        y = paragraph(draw, (right[0], y), greeting, font('kai', 44), p['ink'], right[1]-right[0], 1.55, 4) + 12
    if signature:
        draw.text((right[1], y+20), signature, font=fitted(draw, signature, 'kai', 40, 360), fill=p['accent'], anchor='ra')
    footer(canvas, ctx, kind, palette, (right[0], 970, right[1], 1130), 150, 22)
    return canvas, video_box


def card(ctx, palette, choice, variant, design=None, today=None, stamps=None):
    w, h = PRODUCTS['card']['width'], PRODUCTS['card']['height']
    p = PALETTES[palette]
    canvas = Image.new('RGBA', (w, h), p['bg'])
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((36, 36, w-37, h-37), outline=p['accent'], width=2)
    draw.rectangle((48, 48, w-49, h-49), outline=rgba(p['accent'], 90), width=1)
    title, hook, greeting, signature = texts(ctx, design)
    draw.text((w/2, 128), '观 展 纪 念', font=font('serif', 30, 600), fill=p['accent'], anchor='mm')
    draw.text((w/2, 238), title, font=fitted(draw, title, 'serif', 104, w-240, 700), fill=p['ink'], anchor='mm')
    if hook:
        draw.text((w/2, 334), hook, font=fitted(draw, hook, 'kai', 38, w-240), fill=p['ink'], anchor='mm')
    image, kind = art(ctx, choice, palette, variant)
    paste_center(canvas, placed(image, kind, palette, w-220, 780), (110, 400, w-110, 1180))
    # Seven stamp cells; the collection card fills them from the visitor's record.
    halls = ctx.get('halls') or []
    cell, gap = 112, 22
    x = (w - len(halls)*cell - (len(halls)-1)*gap) / 2
    for i, hall in enumerate(halls):
        box = (round(x + i*(cell+gap)), 1240, round(x + i*(cell+gap)) + cell, 1240 + cell)
        if stamps and hall['id'] in stamps:
            canvas.alpha_composite(seal(hall['seal'], cell, p['accent']), box[:2])
        else:
            draw.rounded_rectangle(box, radius=8, outline=rgba(p['ink'], 70), width=2)
            draw.text(((box[0]+box[2])/2, (box[1]+box[3])/2), hall['seal'][:2], font=font('serif', 26), fill=rgba(p['ink'], 80), anchor='mm')
    draw.text((w/2, 1392), '集齐七个展厅的印章，可在文创展区领取集章纪念卡', font=font('serif', 22), fill=rgba(p['ink'], 150), anchor='mm')
    today = today or date.today()
    draw.text((110, 1470), f'{today.year} 年 {today.month} 月 {today.day} 日', font=font('serif', 30), fill=p['ink'])
    draw.text((110, 1520), f'于{VENUE}', font=font('serif', 24), fill=rgba(p['ink'], 190))
    if greeting and design:
        draw.text((w-110, 1470), greeting, font=fitted(draw, greeting, 'kai', 32, 560), fill=p['ink'], anchor='ra')
    if signature:
        draw.text((w-110, 1522), f'观展人 {signature}', font=fitted(draw, signature, 'kai', 30, 480), fill=p['accent'], anchor='ra')
    footer(canvas, ctx, kind, palette, (110, 1590, w-110, 1720), 130, 22)
    return canvas


def avatar(ctx, palette, choice='line', variant=0, design=None):
    size = PRODUCTS['avatar']['width']
    p = PALETTES[palette]
    s = size * 2
    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    disc = Image.new('L', (s, s), 0)
    ImageDraw.Draw(disc).ellipse((0, 0, s-1, s-1), fill=255)
    ground = Image.new('RGBA', (s, s), p['bg'])
    image, kind = art(ctx, choice, palette, variant)
    crop = ctx.get('avatar_crop')
    if crop and kind != 'color':
        image = trim(image.crop((round(crop[0]*image.width), round(crop[1]*image.height), round(crop[2]*image.width), round(crop[3]*image.height))))
    if kind == 'color':
        fit = contain(image, s, s, 1.0)
        fit = fit.resize((max(fit.width, s), max(fit.height, s)))
        ground.alpha_composite(fit, ((s-fit.width)//2, (s-fit.height)//2))
    else:
        paste_center(ground, contain(image, s*.74, s*.74), (0, 0, s, s))
    canvas.paste(ground, mask=disc)
    ImageDraw.Draw(canvas).ellipse((10, 10, s-11, s-11), outline=p['accent'], width=10)
    canvas = canvas.resize((size, size), Image.Resampling.LANCZOS)
    # This label fits inside the avatar's circular crop rather than its square corners.
    return compact_provenance(canvas, ctx, (166, 448, 474, 584), 112, 20)


def emoji(ctx, spec, size=240):
    """Transparent sticker (240 px for chat): tinted figure and a short phrase with an outline."""
    s = 720
    palette = spec.get('palette', 'cinnabar')
    p = PALETTES[palette]
    source = trim(load(spec['line']))
    box = spec.get('crop') or [0, 0, 1, 1]
    source = trim(source.crop((round(box[0]*source.width), round(box[1]*source.height),
                               round(box[2]*source.width), round(box[3]*source.height))))
    dark = p['ink'] if palette != 'midnight' else '#1d4541'  # stickers sit on light chat bubbles
    accent = deepen(p['accent'], .22)
    color = spec.get('color') or (accent if spec.get('accent') else dark)
    # Scale first, then thicken: fine engraving lines would vanish at chat size.
    alpha = contain(source, s-40, 305).getchannel('A')
    if ctx.get('line_kind') == 'rubbing':
        # Expanding rubbing grain closes its white incisions at chat size.
        # Keep that texture and suppress only the faint paper background.
        alpha = alpha.point(lambda v: min(255, max(0, round((v-20)*2.4))))
    else:
        alpha = alpha.point(lambda v: min(255, v * 3)).filter(ImageFilter.MaxFilter(5))
    fit = Image.new('RGBA', alpha.size, rgba(color))
    fit.putalpha(alpha)
    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    x, y = (s-fit.width)//2, 22 + (305-fit.height)//2
    glow = Image.new('RGBA', fit.size, (255, 255, 255, 255))
    glow.putalpha(alpha.filter(ImageFilter.MaxFilter(17)).filter(ImageFilter.GaussianBlur(2)))
    canvas.alpha_composite(glow, (x, y))
    canvas.alpha_composite(fit, (x, y))
    draw = ImageDraw.Draw(canvas)
    phrase = spec.get('phrase', '')
    if phrase:
        text_size = 102
        face = fitted(draw, phrase, 'serif', text_size, s-40, 900, 40)
        bounds = draw.textbbox((0, 0), phrase, font=face, anchor='mm', stroke_width=14)
        # This row ends before the provenance panel at 426 source pixels.
        while bounds[3]-bounds[1] > 96 and text_size > 40:
            text_size -= 2
            face = fitted(draw, phrase, 'serif', text_size, s-40, 900, 40)
            bounds = draw.textbbox((0, 0), phrase, font=face, anchor='mm', stroke_width=14)
        y_text = (327+423-bounds[1]-bounds[3])/2
        draw.text((s/2, y_text), phrase, font=face, fill=dark if spec.get('accent') else accent, anchor='mm', stroke_width=14, stroke_fill='#ffffff')
    canvas = canvas.resize((size, size), Image.Resampling.LANCZOS)
    # Keep transparency around the sticker while reserving readable provenance below it.
    return compact_provenance(canvas, ctx, (4, size-98, size-4, size-2), 92, 11)


def dashed(draw, box, color, dash=18, gap=12, width=3):
    x0, y0, x1, y1 = box
    for a, b, fixed, across in ((x0, x1, y0, True), (x0, x1, y1, True), (y0, y1, x0, False), (y0, y1, x1, False)):
        t = a
        while t < b:
            end = min(t + dash, b)
            draw.line((t, fixed, end, fixed) if across else (fixed, t, fixed, end), fill=color, width=width)
            t = end + gap


def sticker_sheet(ctx, stickers):
    """Print sheet of the theme's stickers at about 37 mm each, with cut guides and the provenance line."""
    spec = PRODUCTS['print_stickers']
    w, h = spec['width'], spec['height']
    palette = ctx.get('palette') or 'cinnabar'
    canvas = Image.new('RGBA', (w, h), '#ffffff')
    draw = ImageDraw.Draw(canvas)
    cell, size, gap, margin = 460, 440, 24, 70
    stickers = stickers[:6]
    rows = -(-len(stickers) // 3)
    top = margin + (2 - rows) * (cell + gap) // 2
    for i, item in enumerate(stickers):
        row, col = divmod(i, 3)
        count = min(3, len(stickers) - row*3)
        x = (w - count*cell - (count-1)*gap)//2 + col*(cell+gap)
        y = top + row*(cell+gap)
        dashed(draw, (x, y, x+cell, y+cell), '#c9c4ba')
        canvas.alpha_composite(emoji(ctx, item, size), (x+(cell-size)//2, y+(cell-size)//2))
    left = (w - 3*cell - 2*gap)//2
    kind = 'rubbing' if ctx.get('line_kind') == 'rubbing' else 'line'
    # The sheet is always white paper: a dark theme's light ink would print the provenance nearly invisible.
    paper = palette if sum(ImageColor.getrgb(PALETTES[palette]['ink'])) < 384 else 'white'
    footer(canvas, ctx, kind, paper, (left, h-margin-120, w-left, h-margin), 120, 28)
    return canvas


def stamp_card(ctx, stamps, halls, palette='cinnabar', today=None):
    w, h = PRODUCTS['stamp_card']['width'], PRODUCTS['stamp_card']['height']
    p = PALETTES[palette]
    canvas = Image.new('RGBA', (w, h), p['bg'])
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((36, 36, w-37, h-37), outline=p['accent'], width=3)
    watermark(canvas, line_image(ctx) if ctx else None, palette, (80, 980, w-80, 1560), .08)
    draw.text((w/2, 150), '汉 画 寻 踪', font=font('serif', 40, 600), fill=p['accent'], anchor='mm')
    draw.text((w/2, 270), '集章纪念卡', font=font('serif', 100, 700), fill=p['ink'], anchor='mm')
    draw.text((w/2, 370), f'走过{VENUE}七个展厅', font=font('kai', 38), fill=p['ink'], anchor='mm')
    cell, cols = 250, 3
    for i, hall in enumerate(halls):
        row, col = divmod(i, cols)
        count = min(cols, len(halls) - row*cols)
        x = (w - count*cell - (count-1)*60)/2 + col*(cell+60)
        y = 470 + row*330
        if hall['id'] in stamps:
            canvas.alpha_composite(seal(hall['seal'], cell, p['accent']), (round(x), y))
        else:
            draw.rounded_rectangle((x, y, x+cell, y+cell), radius=16, outline=rgba(p['ink'], 80), width=3)
        draw.text((x+cell/2, y+cell+32), hall['name'], font=fitted(draw, hall['name'], 'serif', 28, cell+40), fill=p['ink'], anchor='mm')
    today = today or date.today()
    draw.text((w/2, 1560), f'{today.year} 年 {today.month} 月 {today.day} 日', font=font('serif', 34), fill=p['ink'], anchor='mm')
    draw.text((w/2, 1620), '武氏墓群石刻 · 济宁嘉祥', font=font('serif', 26), fill=p['accent'], anchor='mm')
    return canvas


def hall_stamp(hall, size=360, color=None):
    return seal(hall['seal'], size, color or PALETTES['cinnabar']['accent'])


def render(ctx, product, design=None, today=None, stamps=None):
    """PNG-ready image for one product; `design` holds a visitor's variant."""
    d = design or {}
    palette = d.get('palette') or ctx.get('palette') or 'cinnabar'
    choice, variant = d.get('art') or ('color' if ctx.get('colors') else 'line'), d.get('variant', 0)
    if product == 'wallpaper':
        return wallpaper(ctx, palette, choice, variant, design)
    if product == 'postcard':
        return postcard(ctx, palette, choice, variant, design)[0]
    if product == 'card':
        return card(ctx, palette, choice, variant, design, today, stamps)
    if product == 'avatar':
        return avatar(ctx, palette, d.get('art') or 'line', variant, design)
    if product == 'print_postcard':
        spec = PRODUCTS['print_postcard']
        image = postcard(ctx, palette, choice, variant, design)[0]
        trimmed = image.resize((1748, 1181), Image.Resampling.LANCZOS)
        out = Image.new('RGBA', (spec['width'], spec['height']), PALETTES[palette]['bg'])
        ox, oy = (spec['width']-1748)//2, (spec['height']-1181)//2
        out.alpha_composite(trimmed, (ox, oy))
        # Printing resizes the layout; redraw the archive QR as integer modules
        # at its final size rather than leaving a resampled barcode.
        sx, sy = 1748/PRODUCTS['postcard']['width'], 1181/PRODUCTS['postcard']['height']
        x0, y0 = ox+round(1570*sx), oy+round(980*sy)
        x1, y1 = ox+round(1720*sx), oy+round(1130*sy)
        ImageDraw.Draw(out).rectangle((x0, y0, x1, y1), fill='#ffffff')
        qr_size = min(x1-x0, y1-y0)
        out.alpha_composite(qr_tile(ctx['archive_url'], qr_size, palette), (x0, y0))
        return out
    raise ValueError('未知成品')


def png(image, dpi=None):
    out = BytesIO()
    image.save(out, 'PNG', optimize=True, **({'dpi': (dpi, dpi)} if dpi else {}))
    return out.getvalue()


def save(image, path, dpi=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_bytes(png(image, dpi))
    temp.replace(path)
    return path


def video(ctx, dest, design=None, scale=.8):
    """Five-second card: the theme's clip framed by the postcard layout."""
    import imageio_ffmpeg
    d = design or {}
    palette = d.get('palette') or ctx.get('palette') or 'cinnabar'
    base, (x, y, iw, ih) = postcard(ctx, palette, 'color', d.get('variant', 0), design, omit_art=True)
    # The clip replaces the artwork, so its frame is not drawn under it.
    frame = base.resize((round(base.width*scale)//2*2, round(base.height*scale)//2*2), Image.Resampling.LANCZOS)
    x, y, iw, ih = (round(v*scale) for v in (x, y, iw, ih))
    iw, ih = iw//2*2, ih//2*2
    dest.mkdir(parents=True, exist_ok=True)
    base_path = dest / 'frame.png'
    frame.save(base_path)
    bg = PALETTES[palette]['bg']
    graph = (f'[1:v]scale={iw}:{ih}:force_original_aspect_ratio=decrease,pad={iw}:{ih}:(ow-iw)/2:(oh-ih)/2:color={bg},setsar=1[v];'
             f'[0:v][v]overlay={x}:{y}:shortest=1,format=yuv420p[out]')
    try:
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y',
            '-loop', '1', '-i', str(base_path), '-i', str(ctx['video']), '-filter_complex', graph,
            '-map', '[out]', '-t', '5', '-r', '24', '-an', '-c:v', 'libx264', '-preset', 'fast',
            '-crf', '21', '-threads', '2', '-filter_complex_threads', '1', '-movflags', '+faststart', str(dest / 'video.mp4')],
            capture_output=True, timeout=120, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    finally:
        base_path.unlink(missing_ok=True)
    if result.returncode:
        raise ValueError('动态明信片合成失败')
    cover = frame.copy()
    with Image.open(ctx['cover'] if ctx.get('cover') else ctx['colors'][0]) as still:
        cover.alpha_composite(contain(still.convert('RGBA'), iw, ih), (x + (iw - contain(still, iw, ih).width)//2, y + (ih - contain(still, iw, ih).height)//2))
    return cover
