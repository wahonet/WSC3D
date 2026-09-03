# -*- coding: utf-8 -*-
"""图像结构树：父子关系、几何包含推断、机器候选并入、概念挂接、从释文生成骨架。

约定：
- 结构节点 = tool in (annotate, segment) 且 atype != align 的标注；测量与对齐记录不进树；
- 几何比较一律换算到主图像素坐标（各资产经 align_to_master 坐标链），未入链的资产无法参与包含推断；
- 父子关系只校验"同一石头、不成环"，层级嵌套（PARENT_LEVELS）只用于建议与默认值，不做硬约束；
- 骨架节点 atype='none'、geometry={}，之后在图上绘制或从候选并入几何。
"""
from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..constants import CHILD_LEVEL, LEVELS, PALETTE, PARENT_LEVELS, TWO_D_KINDS
from ..models import Annotation, AnnotationConcept, Asset, Concept, Stone
from ..schemas import (
    AutoParentIn, AutoParentOut, ParentSuggestion, SkeletonCreateOut, SkeletonItem, SkeletonPreview,
)
from . import textlinks
from . import transforms as tf
from .serialize import annotations_out

BBox = tuple[float, float, float, float]


# ================================================================ 基础查询
def structural_rows(db: Session, stone_id: int) -> list[Annotation]:
    return [x for x in db.query(Annotation).filter(Annotation.stone_id == stone_id)
            .order_by(Annotation.id).all() if x.is_structural]


def assets_by_id(db: Session, stone_id: int) -> dict[int, Asset]:
    return {a.id: a for a in db.query(Asset).filter(Asset.stone_id == stone_id).all()}


def descendants(rows: Iterable[Annotation], root_id: int) -> set[int]:
    kids: dict[int, list[int]] = {}
    for x in rows:
        if x.parent_id is not None:
            kids.setdefault(x.parent_id, []).append(x.id)
    out: set[int] = set()
    stack = [root_id]
    while stack:
        cur = stack.pop()
        for k in kids.get(cur, []):
            if k not in out:
                out.add(k)
                stack.append(k)
    return out


def default_asset(db: Session, stone_id: int) -> Asset | None:
    """骨架节点默认挂在主图上；没有主图就取第一张 2D 图。"""
    two_d = [a for a in db.query(Asset).filter(Asset.stone_id == stone_id).all() if a.kind in TWO_D_KINDS]
    return next((a for a in two_d if a.is_master), two_d[0] if two_d else None)


# ================================================================ 几何：换算到主图像素
def norm_points(atype: str, g: dict) -> list[tuple[float, float]]:
    try:
        if atype == "rect":
            x, y, w, h = g["x"], g["y"], g["w"], g["h"]
            return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        if atype == "ellipse":
            return [(p[0], p[1]) for p in tf.ellipse_points(g)]
        if atype == "polygon":
            return [(p[0], p[1]) for p in g["points"]]
        if atype == "point":
            return [(g["p"][0], g["p"][1])]
        if atype == "line":
            return [(g["p1"][0], g["p1"][1]), (g["p2"][0], g["p2"][1])]
    except (KeyError, TypeError, IndexError):
        return []
    return []


def master_bbox(x: Annotation, assets: dict[int, Asset]) -> BBox | None:
    a = assets.get(x.asset_id)
    if a is None or a.is_model or a.chain is None or not x.has_geometry:
        return None
    pts = norm_points(x.atype, x.geometry or {})
    if not pts:
        return None
    m = [tf.apply(a.chain, px * a.width, py * a.height) for px, py in pts]
    xs = [p[0] for p in m]
    ys = [p[1] for p in m]
    return (min(xs), min(ys), max(xs), max(ys))


def _area(b: BBox) -> float:
    return max(b[2] - b[0], 1e-6) * max(b[3] - b[1], 1e-6)


def _inter(a: BBox, b: BBox) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def infer_child_level(parent_level: str, area_ratio: float) -> str:
    """按父级层级与面积占比推断子节点层级（area_ratio = 子 / 父）。"""
    if parent_level == "whole":
        return "layer" if area_ratio >= 0.08 else "scene"
    if parent_level == "layer":
        return "scene" if area_ratio >= 0.12 else "figure"
    return CHILD_LEVEL.get(parent_level, "figure")


# ================================================================ 父级建议 / 自动归类
def suggest_parents(db: Session, stone_id: int, x: Annotation, limit: int = 5) -> list[ParentSuggestion]:
    assets = assets_by_id(db, stone_id)
    me = master_bbox(x, assets)
    if me is None:
        return []
    rows = structural_rows(db, stone_id)
    banned = descendants(rows, x.id) | {x.id}
    allowed = PARENT_LEVELS.get(x.level or "", PARENT_LEVELS[""])
    my_area = _area(me)
    out: list[tuple[float, float, Annotation]] = []
    for r in rows:
        if r.id in banned or r.review_status in ("candidate", "rejected"):
            continue
        if r.level == "" and x.level != "":
            continue
        if r.level != "" and r.level not in allowed:
            continue
        b = master_bbox(r, assets)
        if b is None:
            continue
        area = _area(b)
        if area <= my_area * 1.05:            # 父级必须明显更大
            continue
        ratio = _inter(me, b) / my_area
        if ratio < 0.5:
            continue
        out.append((ratio, area / my_area, r))
    # 包含比例优先，其次取最小（最贴合）的容器
    out.sort(key=lambda t: (-round(t[0], 2), t[1]))
    return [ParentSuggestion(id=r.id, label=r.label, level=r.level or "", ratio=round(ratio, 3),
                             area_ratio=round(ar, 2)) for ratio, ar, r in out[:limit]]


def validate_parent(db: Session, x: Annotation, parent_id: int | None) -> Annotation | None:
    if parent_id is None:
        return None
    if parent_id == x.id:
        raise HTTPException(422, "节点不能作为自己的父级")
    p = db.get(Annotation, parent_id)
    if not p or p.stone_id != x.stone_id:
        raise HTTPException(404, "父级节点不存在或不属于同一石头")
    if not p.is_structural:
        raise HTTPException(422, "测量 / 对齐记录不能作为父级")
    if parent_id in descendants(structural_rows(db, x.stone_id), x.id):
        raise HTTPException(422, "不能把节点挂到自己的子孙节点下（会成环）")
    return p


def auto_parent(db: Session, stone_id: int, body: AutoParentIn) -> AutoParentOut:
    rows = structural_rows(db, stone_id)
    wanted = set(body.ids) if body.ids is not None else None
    assigned = skipped = 0
    details: list[str] = []
    for r in rows:
        if wanted is not None and r.id not in wanted:
            continue
        if r.level == "whole" or r.review_status == "rejected":
            continue
        if not body.include_candidates and r.review_status == "candidate":
            continue
        if body.only_orphans and r.parent_id is not None:
            continue
        sug = suggest_parents(db, stone_id, r, limit=1)
        if not sug or sug[0].ratio < body.min_ratio:
            skipped += 1
            continue
        s = sug[0]
        r.parent_id = s.id
        if not r.level:
            r.level = infer_child_level(s.level, 1.0 / max(s.area_ratio, 1e-6))
        assigned += 1
        details.append(f"「{r.label}」-> 「{s.label}」({s.ratio:.0%})")
    db.commit()
    return AutoParentOut(assigned=assigned, skipped=skipped, details=details[:200])


def apply_auto_parent_on_create(db: Session, x: Annotation) -> None:
    sug = suggest_parents(db, x.stone_id, x, limit=1)
    if sug and sug[0].ratio >= 0.7:
        x.parent_id = sug[0].id
        if not x.level:
            x.level = infer_child_level(sug[0].level, 1.0 / max(sug[0].area_ratio, 1e-6))


def rehang_children(db: Session, x: Annotation) -> int:
    """删除节点前把它的子节点挂到它的父级（不级联删除）。"""
    kids = db.query(Annotation).filter(Annotation.parent_id == x.id).all()
    for k in kids:
        k.parent_id = x.parent_id
    return len(kids)


# ================================================================ 概念挂接
def set_concepts(db: Session, x: Annotation, concept_ids: list[int]) -> None:
    ids = sorted(set(concept_ids))
    if ids:
        found = {c.id for c in db.query(Concept.id).filter(Concept.id.in_(ids)).all()}
        missing = [i for i in ids if i not in found]
        if missing:
            raise HTTPException(404, f"概念不存在：{missing[:5]}")
    db.query(AnnotationConcept).filter(AnnotationConcept.annotation_id == x.id).delete()
    for cid in ids:
        db.add(AnnotationConcept(annotation_id=x.id, concept_id=cid))


def match_concepts(concepts: list[Concept], names: Iterable[str]) -> list[int]:
    """按名称 / 别名精确匹配；其次取名称中包含的最长概念词（长度 >= 2）。"""
    by_name: dict[str, Concept] = {}
    for c in concepts:
        by_name.setdefault(c.name, c)
        for a in c.aliases or []:
            by_name.setdefault(a, c)
    out: list[int] = []
    for n in names:
        n = (n or "").strip()
        if not n:
            continue
        hit = by_name.get(n)
        if hit is None and len(n) >= 2:
            cands = [(len(k), c) for k, c in by_name.items() if len(k) >= 2 and (k in n or n in k)
                     and abs(len(k) - len(n)) <= 4]
            if cands:
                cands.sort(key=lambda t: -t[0])
                hit = cands[0][1]
        if hit and hit.id not in out:
            out.append(hit.id)
    return out


# ================================================================ 候选并入
def adopt_geometry(db: Session, target: Annotation, source: Annotation) -> Annotation:
    if source.id == target.id:
        raise HTTPException(422, "不能并入自身")
    if source.stone_id != target.stone_id:
        raise HTTPException(422, "两条标注不属于同一石头")
    if not source.is_structural or not source.has_geometry:
        raise HTTPException(422, "来源没有可并入的几何")
    target.asset_id, target.atype, target.geometry = source.asset_id, source.atype, source.geometry
    if not target.level and source.level:
        target.level = source.level
    if not target.category and source.category:
        target.category = source.category
    if target.review_status == "candidate":
        target.review_status = "reviewed"
    if not target.note and source.note:
        target.note = source.note
    # 来源的子节点与概念并入
    for k in db.query(Annotation).filter(Annotation.parent_id == source.id).all():
        k.parent_id = target.id
    have = {l.concept_id for l in target.concept_links}
    for l in list(source.concept_links):
        if l.concept_id not in have:
            db.add(AnnotationConcept(annotation_id=target.id, concept_id=l.concept_id))
    # 来源若有释文关联而目标没有，则转移
    if source.is_linked and not target.is_linked:
        src, st, en, txt = source.desc_source, source.desc_start, source.desc_end, source.desc_text
        textlinks.clear_link(source)
        db.flush()
        textlinks.set_link(db, target, src, st, en, txt)
    db.delete(source)
    return target


# ================================================================ 从释文生成骨架
_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
_NUMS = "".join(_NUM)
_RE_SCENE = re.compile(rf"([{_NUMS}])则，")
_RE_SCENE_NAME = re.compile(r"此则画像(?:当是|当为|应是|应为|即为|即是|应即|当即|是|为)(.+?)(?:的)?故事")
_RE_FIGURE = re.compile(r"首刻|次一人|又一人|次刻")
_RE_FIGURE_NAME = re.compile(r"画像(?:应是|应为|应即|当即|当为|当是|即为|即是|即|是|为)([^。（）]{1,12}?)(?:。|$)")
_RE_INSCR = re.compile(r"(?:榜题|横题|榜)[^“”。]{0,14}?“([^”]+)”")
_RE_QUOTE = re.compile(r"“[^”]*”")
_RE_PAREN = re.compile(r"（[^）]*）")
_RE_BAND = re.compile(r"(第[一二三四五六七八九十、]+层间|画面最下边|画面上边|画面下边|画面左边|画面右边)饰([^，。；]+?)(?:的)?(?:组合)?花纹带")
_RE_ITEM = re.compile(rf"([{_NUMS}])([^{_NUMS}，。；：、＿]{{1,12}})")
_CLAUSE_SKIP = ("其中", "皆", "均", "亦", "各", "上述", "此则", "此层", "画像", "榜题", "横题", "曰")
_LEAD_STRIP = ("左边", "右边", "中部", "中间", "中央", "左起", "右起", "左上", "右上", "左下", "右下",
               "其前", "其后", "其上", "其下", "其右", "其左", "上", "下", "前", "后", "左", "右", "中")
_STOP = ("左向", "右向", "拱手", "而跪", "跪", "坐于", "坐", "立", "卧", "执", "持", "手持", "驾", "作",
         "伏", "蹲踞", "荷", "冠服", "戴", "发绾", "面向", "侍奉", "侍立", "停立", "开盖", "双手", "回首",
         "怒发", "惊恐", "捧", "两", "如", "和", "与", "残", "头残", "上插", "内盛", "无题", "俯", "回身",
         "在", "于", "向", "抱", "拽", "挽", "捣", "坠", "蹲", "踞", "举", "伸")
_NAME_SKIP_PREFIX = ("字", "行", "则", "层", "方", "侧", "列", "环", "边", "足", "手", "翅", "辈", "种", "组",
                     "横栏", "幅", "亲", "年")
_GENERIC = {"人", "妇", "妇人", "翁", "女", "老人", "童子", "小儿", "者"}
_DEITY = ("西王母", "东王公", "伏羲", "女娲")
_POSITIONAL = ("左", "右", "上", "下", "前", "后", "身", "之", "两")

_LAYER_CATEGORY = [
    ("孝子", "figure-filial-son"), ("刺客", "figure-loyal-assassin"), ("劫盟", "figure-loyal-assassin"),
    ("帝王", "figure-mythic-ruler"), ("列女", "figure-virtuous-woman"), ("烈女", "figure-virtuous-woman"),
    ("车骑", "chariot-procession"), ("出行", "chariot-procession"), ("仙", "figure-immortal"),
    ("西王母", "figure-deity"), ("乐舞", "figure-music-dance"), ("祥瑞", "mythic-creature"),
]
_LABEL_CATEGORY = [
    ("西王母", "figure-deity"), ("东王公", "figure-deity"), ("伏羲", "figure-deity"), ("女娲", "figure-deity"),
    ("羽人", "figure-immortal"), ("仙女", "figure-immortal"), ("侍女", "figure-immortal"), ("人首鸟身", "figure-immortal"),
    ("龙", "mythic-creature"), ("玉兔", "mythic-creature"), ("蟾蜍", "mythic-creature"), ("鸟", "mythic-creature"),
    ("凤", "mythic-creature"), ("九尾狐", "mythic-creature"),
    ("车", "chariot-procession"), ("骑", "chariot-procession"), ("马", "chariot-procession"), ("步卒", "chariot-procession"),
    ("榜", "inscription"),
]


def _category_for(label: str, layer_name: str) -> str:
    for k, c in _LABEL_CATEGORY:
        if k in label:
            return c
    for k, c in _LAYER_CATEGORY:
        if k in layer_name:
            return c
    return ""


def _norm_label(s: str) -> str:
    return re.sub(r"[、·\s（）()]", "", s or "")


def _trim_name(raw: str) -> str:
    name = raw
    if "的" in name:                                   # "执长刀和便面的步卒" -> 步卒
        name = name.rsplit("的", 1)[1]
    cut = len(name)
    for s in _STOP:
        i = name.find(s)
        if 0 < i < cut:
            cut = i
    name = name[:cut].strip("，。；：、 ")
    if len(name) > 2:
        name = re.sub(r"(者|也)$", "", name)
    return name


def _strip_lead(clause: str) -> str:
    c = clause
    changed = True
    while changed and c:
        changed = False
        for lead in _LEAD_STRIP:
            if c.startswith(lead) and len(c) > len(lead) and c[len(lead)] in _NUMS:
                c = c[len(lead):]
                changed = True
                break
    return c


def _enumerate_items(text: str) -> list[tuple[str, int, str]]:
    """在一段释文里找"数词 + 名词"的枚举项。返回 (名称, 数量, 子句)。引号内榜题文字不参与。"""
    plain = _RE_QUOTE.sub(lambda m: "＿" * len(m.group(0)), text)
    out: list[tuple[str, int, str]] = []
    for m in re.finditer(r"[^，。；：]+", plain):
        clause = m.group(0).strip("＿ ")
        if not clause or any(clause.startswith(s) for s in _CLAUSE_SKIP):
            continue
        body = _strip_lead(clause)
        deity = None
        for d in _DEITY:
            i = body.find(d)
            if 0 <= i <= 3:
                rest = body[i + len(d):]
                if not rest or rest[0] not in _POSITIONAL:
                    deity = d
                break
        if deity:
            out.append((deity, 1, clause))
            continue
        last_end = 0
        for im in _RE_ITEM.finditer(body):
            n = _NUM[im.group(1)]
            raw = im.group(2)
            prefix, last_end = body[last_end:im.start()], im.end()
            if n >= 5 or raw.startswith(_NAME_SKIP_PREFIX) or "榜" in raw:
                continue
            name = _trim_name(raw)
            if not name or len(name) > 8:
                continue
            if name in _GENERIC:
                desc = re.sub(r"^[和与及]", "", raw[len(name):].strip("，。；：、 "))[:8]
                if len(desc) < 2:                       # 没有后置描述就用前置方位："桓公身后一人"
                    desc = re.sub(r"^[和与及]", "", prefix.strip("，。；：、 "))[-6:]
                label = f"{name}（{desc}）" if len(desc) >= 2 else name
            else:
                label = name
            out.append((label, n, clause))
    return out


def _expand_labels(found: list[tuple[str, int, str]]) -> list[tuple[str, str, str]]:
    """把 (名称, 数量, 子句) 展开成逐个节点；同一容器内重名的编号：骑从·1 … 骑从·4。返回 (标签, 名称, 子句)。"""
    total = Counter()
    for name, n, _ in found:
        total[name] += n
    seen = Counter()
    out: list[tuple[str, str, str]] = []
    for name, n, clause in found:
        for _ in range(n):
            seen[name] += 1
            label = f"{name}·{seen[name]}" if total[name] > 1 else name
            out.append((label, name, clause))
    return out


def _cut_trailing_note(text: str) -> int:
    """释文末尾"（此层画像榜题见图版…）"不计入正文区间。"""
    i = text.rfind("（此层")
    return i if i > 0 else len(text)


def _clean_transcription(s: str) -> str:
    return _RE_PAREN.sub("", s).strip()


def skeleton_preview(db: Session, stone: Stone) -> SkeletonPreview:
    have = {_norm_label(r.label) for r in structural_rows(db, stone.id)}
    items: list[SkeletonItem] = []
    counter = [0]
    seq_by_parent: dict[str, int] = {}

    def key(prefix: str) -> str:
        counter[0] += 1
        return f"{prefix}{counter[0]}"

    def add(parent: SkeletonItem | None = None, **kw) -> SkeletonItem:
        if parent is not None:
            kw.setdefault("parent_key", parent.key)
            kw.setdefault("parent_label", parent.label)
            if kw.get("seq") is None:
                seq_by_parent[parent.key] = seq_by_parent.get(parent.key, 0) + 1
                kw["seq"] = seq_by_parent[parent.key]
        it = SkeletonItem(**kw)
        it.exists = _norm_label(it.label) in have
        items.append(it)
        return it

    def add_figures(holder: SkeletonItem, seg: str, lname: str) -> None:
        for label, name, clause in _expand_labels(_enumerate_items(seg)):
            add(holder, key=key("F"), level="figure", label=label,
                category=_category_for(name, lname), concept_names=[name], excerpt=clause[:60])

    whole = add(key="W", level="whole", label=stone.name, excerpt=(stone.description or "")[:40])
    # 花纹带排在各层之后（seq 从 100 起），避免与层号交错
    for bi, m in enumerate(_RE_BAND.finditer(stone.description or ""), 1):
        pats = [p for p in re.split(r"[、和]", m.group(2)) if p]
        add(whole, key=key("B"), level="band", seq=100 + bi, label=f"花纹带·{m.group(1)}",
            category="pattern-border", concept_names=pats, excerpt=m.group(0))

    for lay in stone.layers:
        text = lay.summary or ""
        end = _cut_trailing_note(text)
        body = text[:end]
        src = f"layer:{lay.seq}"
        lname = lay.name or f"第{lay.seq}层"
        lnode = add(whole, key=f"L{lay.seq}", level="layer", seq=lay.seq, label=lname,
                    category=_category_for("", lname), concept_names=[lname], excerpt=body[:40])

        scene_marks = list(_RE_SCENE.finditer(body))
        fig_marks = list(_RE_FIGURE.finditer(body))
        if scene_marks:
            spans = [(m.start(), scene_marks[i + 1].start() if i + 1 < len(scene_marks) else end, "scene")
                     for i, m in enumerate(scene_marks)]
        elif fig_marks:
            spans = [(m.start(), fig_marks[i + 1].start() if i + 1 < len(fig_marks) else end, "figure")
                     for i, m in enumerate(fig_marks)]
        else:
            spans = [(0, end, "enum")]

        for si, (s0, s1, mode) in enumerate(spans, 1):
            seg = body[s0:s1].rstrip("，。； ")
            seg_end = s0 + len(seg)
            holder = lnode
            if mode == "scene":
                nm = _RE_SCENE_NAME.search(seg)
                label = nm.group(1).strip() if nm else f"{lname}·第{si}则"
                holder = add(lnode, key=key("S"), level="scene", seq=si, label=label,
                             category=_category_for("", lname), desc_source=src,
                             desc_start=s0, desc_end=seg_end, concept_names=[label], excerpt=seg[:60])
                add_figures(holder, seg, lname)
            elif mode == "figure":
                nm = _RE_FIGURE_NAME.search(seg)
                label = nm.group(1).strip() if nm else f"{lname}·第{si}人"
                holder = add(lnode, key=key("F"), level="figure", seq=si, label=label,
                             category=_category_for(label, lname), desc_source=src,
                             desc_start=s0, desc_end=seg_end,
                             concept_names=[p for p in re.split(r"[、]", label) if p], excerpt=seg[:60])
            else:
                add_figures(lnode, seg, lname)
            for im in _RE_INSCR.finditer(seg):
                tr = _clean_transcription(im.group(1))
                if not tr:
                    continue
                short = tr if len(tr) <= 8 else tr[:8] + "…"
                add(holder, key=key("I"), level="inscription", label=f"榜题「{short}」", category="inscription",
                    transcription=tr, concept_names=["人物榜题" if len(tr) <= 5 else "故事榜题"],
                    excerpt=im.group(0)[:60])
            if mode == "enum" and "一榜无题" in seg:
                add(holder, key=key("I"), level="inscription", label="榜题（无字）", category="inscription",
                    concept_names=["无字榜"], excerpt="一榜无题")

    asset = default_asset(db, stone.id)
    return SkeletonPreview(items=items, asset_id=asset.id if asset else None)


def skeleton_create(db: Session, stone: Stone, items: list[SkeletonItem],
                    asset_id: int | None) -> SkeletonCreateOut:
    asset = db.get(Asset, asset_id) if asset_id else default_asset(db, stone.id)
    if asset is None or asset.stone_id != stone.id or asset.is_model:
        raise HTTPException(422, "缺少可挂载骨架节点的 2D 资产")
    concepts = db.query(Concept).all()
    existing = structural_rows(db, stone.id)
    by_label = {_norm_label(r.label): r for r in existing}

    # 父级先建：按依赖排序
    keys = {it.key for it in items}
    ordered: list[SkeletonItem] = []
    pending = list(items)
    while pending:
        progressed = False
        for it in list(pending):
            if it.parent_key is None or it.parent_key not in keys or any(o.key == it.parent_key for o in ordered):
                ordered.append(it)
                pending.remove(it)
                progressed = True
        if not progressed:                      # 成环：剩余当作根
            ordered.extend(pending)
            break

    created: dict[str, Annotation] = {}
    skipped_links: list[str] = []
    linked = 0
    palette_start = len(existing)
    for i, it in enumerate(ordered):
        parent = created.get(it.parent_key) if it.parent_key else None
        if parent is None and it.parent_key and it.parent_key not in keys:
            # 父级未一同创建：挂到库中已有的同名节点（例如层节点已存在）
            parent = by_label.get(_norm_label(it.parent_label))
        x = Annotation(
            stone_id=stone.id, asset_id=asset.id, tool="annotate", atype="none", geometry={},
            label=it.label, note="", color=PALETTE[(palette_start + i) % len(PALETTE)],
            level=it.level if it.level in LEVELS else "", category=it.category or "", seq=it.seq,
            review_status="reviewed", parent_id=parent.id if parent else None,
            semantics={"inscription": {"transcription": it.transcription}} if it.transcription else {},
        )
        db.add(x)
        db.flush()
        created[it.key] = x
        for cid in match_concepts(concepts, [it.label, *it.concept_names]):
            db.add(AnnotationConcept(annotation_id=x.id, concept_id=cid))
        if it.desc_source and it.desc_start is not None and it.desc_end is not None:
            src_text, _ = textlinks.source_text(stone, it.desc_source)
            txt = src_text[it.desc_start:it.desc_end]
            try:
                textlinks.set_link(db, x, it.desc_source, it.desc_start, it.desc_end, txt)
                linked += 1
            except HTTPException as e:
                skipped_links.append(f"「{it.label}」：{e.detail}")
    db.commit()
    rows = [created[it.key] for it in ordered]
    return SkeletonCreateOut(created=len(rows), linked=linked, skipped_links=skipped_links,
                             annotations=annotations_out(db, rows))
