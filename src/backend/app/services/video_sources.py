"""Export annotation geometry and its saved research context without model calls."""
from __future__ import annotations
import hashlib
from html import unescape
from html.parser import HTMLParser
from io import BytesIO
import json
import math
import re
import threading
from typing import Annotated, Literal

from PIL import Image, ImageDraw, ImageOps
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import String, cast, func, or_
from sqlalchemy.orm import Session
from ..config import settings
from ..models import Annotation, AnnotationConcept, Asset, Concept, Stone
from . import minimax, references, resources
from .previews import _to_srgb

_lock = threading.Lock()
SHAPES = ('rect', 'polygon', 'ellipse')
STYLES = {
    'paper': '汉画像石启发的二维剪纸动画，平面侧视，简洁有力的轮廓，朱砂、赭黄、墨黑和青绿有限色块，纸张纹理；避免真人写实、皮肤毛孔、三维游戏质感和现代物品。',
    'flat': '二维平面插画动画，清晰概括的造型，克制的色彩和纸面质感，动作简洁流畅；不使用真人写实、皮肤纹理或三维渲染。',
    'ink': '中国水墨动画，墨色晕染与少量淡彩，保留笔触、留白和宣纸纹理，动作自然含蓄；不使用真人写实或三维渲染。',
    'custom': '',
}


class PrepareRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    annotation_ids: list[Annotated[int, Field(strict=True, gt=0)]] = Field(min_length=1, max_length=20)
    mode: Literal['multimodal', 'fast'] = 'fast'
    duration: Annotated[int, Field(strict=True, ge=4, le=5)] = 5
    style: Literal['paper', 'flat', 'ink', 'custom'] = 'paper'

    @field_validator('annotation_ids')
    @classmethod
    def unique(cls, value):
        return sorted(set(value))

    @model_validator(mode='after')
    def valid_duration(self):
        if self.duration not in minimax.VIDEO_MODES[self.mode]['durations']:
            raise ValueError('极速生成最短为 5 秒')
        return self


def eligible(node):
    return node.tool in ('annotate', 'segment') and node.atype in SHAPES and node.review_status != 'rejected' and bool(node.geometry)


def display_label(node):
    return f'区域 {node.id}' if not node.label or node.label == '未命名' or re.match(r'^sam\d?(?:\.\d+)?:', node.label, re.I) else node.label


def catalogue(db: Session):
    rows = (db.query(Annotation, Asset, Stone).join(Asset, Annotation.asset_id == Asset.id)
            .join(Stone, Annotation.stone_id == Stone.id).filter(
                Annotation.tool.in_(('annotate', 'segment')), Annotation.atype.in_(SHAPES),
                Annotation.review_status != 'rejected', Asset.missing == False)
            .order_by(Stone.id, Asset.id, Annotation.id).all())
    stones = {}
    for node, asset, stone in rows:
        if asset.is_model or not eligible(node):
            continue
        item = stones.setdefault(stone.id, {'id': stone.id, 'name': stone.name, 'assets': {}})
        group = item['assets'].setdefault(asset.id, {'id': asset.id, 'filename': asset.filename, 'annotations': []})
        group['annotations'].append({'id': node.id, 'label': display_label(node), 'parent_id': node.parent_id,
                                     'atype': node.atype, 'review_status': node.review_status})
    return [{**stone, 'assets': list(stone['assets'].values())} for stone in stones.values()]


def selectable(db):
    # Select columns explicitly below: browsing must not load polygon arrays or book excerpts.
    return db.query(Annotation.id).join(Asset, Annotation.asset_id == Asset.id).join(
        Stone, Annotation.stone_id == Stone.id).filter(
        Annotation.tool.in_(('annotate', 'segment')), Annotation.atype.in_(SHAPES),
        Annotation.review_status != 'rejected', Asset.missing == False,
        ~Asset.kind.startswith('model'), Asset.stone_id == Stone.id,
        cast(Annotation.geometry, String).notin_(('null', '{}', '[]', '')))


def source_groups(db):
    rows = selectable(db).with_entities(Stone.id, Stone.name, Asset.id, Asset.filename, func.count(Annotation.id)).group_by(
        Stone.id, Stone.name, Asset.id, Asset.filename).order_by(Stone.id, Asset.id).all()
    result = {}
    for stone_id, name, asset_id, filename, count in rows:
        stone = result.setdefault(stone_id, {'id': stone_id, 'name': name, 'assets': []})
        stone['assets'].append({'id': asset_id, 'filename': filename, 'count': count})
    return list(result.values())


def browse(db, q='', stone_id='', asset_id=None, offset=0, limit=24, ids=None):
    query = selectable(db)
    if ids is not None:
        query = query.filter(Annotation.id.in_(ids))
    if stone_id:
        query = query.filter(Stone.id == stone_id)
    if asset_id:
        query = query.filter(Asset.id == asset_id)
    for term in q.strip().split():
        concepts = Annotation.concept_links.any(AnnotationConcept.concept.has(Concept.name.contains(term, autoescape=True)))
        query = query.filter(or_(Annotation.label.contains(term, autoescape=True),
                                Stone.name.contains(term, autoescape=True), Stone.id.contains(term, autoescape=True),
                                Asset.filename.contains(term, autoescape=True), concepts,
                                Annotation.id == int(term.lstrip('#')) if term.lstrip('#').isdigit() else False))
    total = query.count()
    rows = query.with_entities(Annotation.id, Annotation.label, Annotation.atype, Annotation.review_status,
                              Annotation.parent_id, Annotation.updated_at, Stone.id.label('stone_id'),
                              Stone.name.label('stone_name'), Asset.id.label('asset_id'), Asset.filename).order_by(
        Annotation.updated_at.desc(), Annotation.id.desc()).offset(offset).limit(limit).all()
    items = [{**row._asdict(), 'label': display_label(row)} for row in rows]
    return {'items': items, 'total': total, 'offset': offset, 'limit': limit}


def bounds(node):
    g = node.geometry or {}
    try:
        if node.atype == 'rect':
            x, y, w, h = (float(g[k]) for k in ('x', 'y', 'w', 'h'))
            if min(w, h) <= 0:
                raise ValueError()
            box = x, y, x+w, y+h
        elif node.atype == 'ellipse':
            x, y, rx, ry = (float(g[k]) for k in ('cx', 'cy', 'rx', 'ry'))
            if min(rx, ry) <= 0:
                raise ValueError()
            box = x-rx, y-ry, x+rx, y+ry
        else:
            points = g['points']
            if not 3 <= len(points) <= 20000:
                raise ValueError()
            if any(len(p) != 2 or any(not math.isfinite(float(v)) for v in p) for p in points):
                raise ValueError()
            xs, ys = zip(*points)
            box = min(xs), min(ys), max(xs), max(ys)
        if not all(math.isfinite(v) for v in box) or min(box) < -1e-6 or max(box) > 1.000001 or box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError()
        return tuple(max(0, min(1, v)) for v in box)
    except (KeyError, TypeError, ValueError, OverflowError):
        raise ValueError(f'标注 #{node.id} 的范围无效，请重新保存标注') from None


def export_region(asset: Asset, nodes: list[Annotation], path, edge=1920):
    """Shared, coordinate-faithful RGBA crop for videos and creative products."""
    boxes = [bounds(node) for node in nodes]
    with Image.open(path) as original:
        if original.size != (asset.width, asset.height):
            raise ValueError('底图尺寸已变化，请先核对标注底图')
        pixel_box = (math.floor(min(b[0] for b in boxes)*original.width), math.floor(min(b[1] for b in boxes)*original.height),
                     math.ceil(max(b[2] for b in boxes)*original.width), math.ceil(max(b[3] for b in boxes)*original.height))
        frame = _to_srgb(original.crop(pixel_box)).convert('RGB')
        frame.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    mask = Image.new('L', frame.size, 0)
    draw = ImageDraw.Draw(mask)
    sx, sy = frame.width/(pixel_box[2]-pixel_box[0]), frame.height/(pixel_box[3]-pixel_box[1])
    def point(p):
        return (p[0]*asset.width-pixel_box[0])*sx, (p[1]*asset.height-pixel_box[1])*sy
    for node, box in zip(nodes, boxes):
        if node.atype == 'polygon':
            draw.polygon([point(p) for p in node.geometry['points']], fill=255)
        elif node.atype == 'ellipse':
            draw.ellipse((*point(box[:2]), *point(box[2:])), fill=255)
        else:
            draw.rectangle((*point(box[:2]), *point(box[2:])), fill=255)
    if mask.getbbox() is None:
        raise ValueError('所选标注没有可导出的图案')
    frame.putalpha(mask)
    return frame, list(pixel_box)


def export_image(asset: Asset, nodes: list[Annotation], path):
    region, pixel_box = export_region(asset, nodes, path)
    frame = Image.new('RGB', region.size, 'white')
    frame.paste(region, mask=region.getchannel('A'))
    width = max(frame.width, math.ceil(frame.height / 2.4))
    height = max(frame.height, math.ceil(frame.width / 2.4))
    frame = ImageOps.expand(frame, ((width-frame.width)//2, (height-frame.height)//2,
                                    width-frame.width-(width-frame.width)//2, height-frame.height-(height-frame.height)//2), fill='white')
    if min(frame.size) < 256:
        scale = 256 / min(frame.size)
        frame = frame.resize((math.ceil(frame.width*scale), math.ceil(frame.height*scale)), Image.Resampling.LANCZOS)
    output = BytesIO()
    frame.save(output, format='JPEG', quality=94)
    return output.getvalue(), {'width': frame.width, 'height': frame.height, 'pixel_box': list(pixel_box)}


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag in ('br', 'p', 'td', 'th', 'tr'):
            self.parts.append(' ')
    def handle_data(self, data):
        self.parts.append(data)


def plain(value):
    parser = PlainText()
    parser.feed(value or '')
    return re.sub(r'\s+', ' ', unescape(''.join(parser.parts))).strip()


def context_nodes(db, selected):
    all_nodes = {n.id: n for n in db.query(Annotation.id, Annotation.parent_id, Annotation.review_status).filter(
        Annotation.stone_id == selected[0].stone_id).all()}
    ids = {n.id for n in selected}
    selected_ids = set(ids)
    for node in selected:
        parent = node.parent_id
        seen = {node.id}
        while parent in all_nodes and parent not in seen:
            seen.add(parent)
            ancestor = all_nodes[parent]
            if ancestor.review_status != 'rejected':
                ids.add(parent)
            parent = ancestor.parent_id
    # Saved children describe the figures inside a selected story's region.
    for node in all_nodes.values():
        if node.review_status not in ('reviewed', 'approved'):
            continue
        parent, seen = node.parent_id, {node.id}
        while parent in all_nodes and parent not in seen:
            if parent in selected_ids:
                ids.add(node.id)
                break
            seen.add(parent)
            parent = all_nodes[parent].parent_id
    nodes = db.query(Annotation).filter(Annotation.id.in_(ids)).all()
    return sorted(nodes, key=lambda n: (n.id not in selected_ids, n.id))


def snapshot(db, asset, stone, selected):
    nodes = context_nodes(db, selected)
    refs = references.references_out(db, [ref for node in nodes for ref in node.references])
    snapshots = []
    selected_ids = {n.id for n in selected}
    for node in nodes:
        snapshots.append({'id': node.id, 'label': node.label, 'display_label': display_label(node), 'asset_id': node.asset_id, 'parent_id': node.parent_id,
                          'selected': node.id in selected_ids, 'review_status': node.review_status, 'atype': node.atype,
                          'geometry': node.geometry, 'semantics': node.semantics or {}, 'desc_text': node.desc_text or '',
                          'concepts': sorted(link.concept.name for link in node.concept_links),
                          'updated_at': node.updated_at.isoformat() if node.updated_at else None})
    return {'stone_id': stone.id, 'stone_name': stone.name, 'asset_id': asset.id, 'filename': asset.filename,
            'asset_sha256': asset.sha256, 'annotation_ids': sorted(selected_ids),
            'annotations': snapshots, 'references': [ref.model_dump() for ref in refs]}


def describe_source(source):
    nodes = source['annotations']
    by_id = {node['id']: node for node in nodes}
    parts = []
    for node in nodes:
        lines = []
        semantics = node['semantics']
        if node['concepts']:
            lines.append('概念：' + '、'.join(node['concepts']))
        for field, label in (('pre_iconographic', '直观描述'), ('iconographic', '故事描述')):
            if plain(semantics.get(field)):
                lines.append(label + '：' + plain(semantics[field]))
        if plain(node['desc_text']):
            lines.append('关联释文：' + plain(node['desc_text']))
        parts.append(('所选标注' if node['selected'] else '所属故事与相关标注') + '「' + node['display_label'] + '」\n' + '\n'.join(lines))
    seen = set()
    for ref in source['references']:
        if ref['source_missing']:
            continue
        node = by_id[ref['annotation_id']]
        excerpts = [x['text'] for x in ref.get('excerpts', []) if x.get('text') and x['text'] in node['semantics'].get(x.get('field'), '')]
        value = '\n'.join(excerpts) if excerpts else ref['text']
        if '<table' in value.lower():
            terms = [n['label'] for n in nodes if len(n['label']) >= 2]
            value = '\n'.join(plain(row) for row in re.findall(r'<tr\b[^>]*>.*?</tr>', value, flags=re.S | re.I) if any(term in plain(row) for term in terms))
        value = plain(value)
        if not value or value in seen:
            continue
        seen.add(value)
        source_label = ref.get('document_title') or '关联释文'
        page = f"，第 {ref['page_no']} 页" if ref.get('page_no') else ''
        parts.append(f"文献材料（{source_label}{page}）：{value}")
    return '\n\n'.join(part for part in parts if part)


def compile_prompt(source, options):
    names = [node['display_label'] for node in source['annotations'] if node['selected']]
    parts = [f"将标注图案制作为 {options.duration} 秒动画。所选内容：{'、'.join(names)}。",
             '以随附的标注底图为造型和构图依据，保留轮廓、朝向及相对位置；白色留白区域不补画人物或器物。文献故事只提供动作背景，不增加未选中的角色或切换场景。',
             describe_source(source), STYLES[options.style],
             '在标注描述支持的范围内做小幅、连续的动作。固定镜头，无字幕、无对白、无配乐，保持所选图案数量和身份稳定。']
    prompt = '\n\n'.join(part for part in parts if part)
    if len(prompt) > 7000:
        raise ValueError('所选标注与引文超过 7000 字，请减少本次选择的标注')
    return prompt


def source_dir(source_id):
    if not re.fullmatch('[a-f0-9]{64}', source_id):
        raise ValueError('标注底图编号无效')
    return settings.cache_dir / 'video_sources' / source_id


def selection(db: Session, ids):
    selected = db.query(Annotation).filter(Annotation.id.in_(ids)).order_by(Annotation.id).all()
    if not selected or len(selected) != len(set(ids)) or any(not eligible(node) for node in selected):
        raise ValueError('请选择已有的矩形、椭圆或分割标注')
    if len({n.asset_id for n in selected}) != 1 or len({n.stone_id for n in selected}) != 1:
        raise ValueError('请在同一张底图中选择标注')
    asset, stone = db.get(Asset, selected[0].asset_id), db.get(Stone, selected[0].stone_id)
    if asset is None or stone is None or asset.is_model or asset.missing or asset.stone_id != stone.id:
        raise ValueError('所选标注的底图不可用')
    path = resources.asset_path(asset.relpath)
    source = snapshot(db, asset, stone, selected)
    source['source_file'] = str(path.relative_to(settings.assets_root)).replace('\\', '/')
    source['source_stat'] = [path.stat().st_size, path.stat().st_mtime_ns]
    return asset, selected, path, source


def prepare(db: Session, options: PrepareRequest):
    asset, selected, path, source = selection(db, options.annotation_ids)
    prompt = compile_prompt(source, options)
    data = {'version': 1, 'source': source, 'options': options.model_dump(), 'prompt': prompt}
    source_id = hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    with _lock:
        folder = source_dir(source_id)
        if (folder / 'source.json').is_file():
            return load(source_id)
        content, size = export_image(asset, selected, path)
        title = '、'.join(display_label(node) for node in selected)
        result = {**data, **size, 'id': source_id, 'title': title[:80], 'image_sha256': hashlib.sha256(content).hexdigest(),
                  'image_url': f'/api/videos/sources/{source_id}/image'}
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'base.jpg').write_bytes(content)
        (folder / 'source.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        return result


def load(source_id):
    folder = source_dir(source_id)
    try:
        data = json.loads((folder / 'source.json').read_text(encoding='utf-8'))
        payload = {key: data[key] for key in ('version', 'source', 'options', 'prompt')}
        digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if digest != source_id or data['id'] != source_id or hashlib.sha256((folder / 'base.jpg').read_bytes()).hexdigest() != data['image_sha256']:
            raise ValueError()
        PrepareRequest.model_validate(data['options'])
        return data
    except (OSError, KeyError, ValueError):
        raise ValueError('标注底图已失效，请重新选择标注') from None


def public(data):
    value = {key: data[key] for key in ('id', 'title', 'prompt', 'options', 'image_url', 'width', 'height')}
    value['source'] = {key: data['source'][key] for key in ('stone_id', 'stone_name', 'asset_id', 'filename', 'annotation_ids', 'annotations', 'references')}
    return value
