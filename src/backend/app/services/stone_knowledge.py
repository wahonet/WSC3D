"""Stone-centred reading index: canonical names, book passages and inventory facts.

The OCR map is a derived reading aid. Counts use positive, per-stone descriptions,
never the number of retrieved passages or unconfirmed knowledge-graph neighbors.
All source identities remain those of the existing library and annotation store.
"""
from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from functools import lru_cache
import hashlib
import json
import re
import threading

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Document, Page, Segment, Stone
from . import catalogue

ALIASES_PATH = settings.root / 'config/knowledge-graph/stone-name-aliases.json'
_lock = threading.RLock()
_cache_key = None
_cache = None
_TRADITIONAL = str.maketrans('畫闕後東祠龕閣圖龍鳳鳥馬車魚獵樂樂獅宮廟國藺齊魯義孝韓闵萊荊軻獻羲媧堯舜禹湯來學見陰陽',
                            '画阙后东祠龛阁图龙凤鸟马车鱼猎乐乐狮宫庙国蔺齐鲁义孝韩闵莱荆轲献羲娲尧舜禹汤来学见阴阳')


def normalize(value: str) -> str:
    result = re.sub(r'[^\w\u3400-\u9fff]', '', (value or '').translate(_TRADITIONAL)).casefold()
    def ordinal(match):
        word = match[1]
        if word.isdecimal():
            number = int(word)
        else:
            digits = {c: i for i, c in enumerate('零一二三四五六七八九')}
            number, digit = 0, 0
            for char in word:
                if char in '十百':
                    number += (digit or 1) * (10 if char == '十' else 100); digit = 0
                else:
                    digit = digits.get(char, 0)
            number += digit
        return f'第{number}石'
    return re.sub(r'第([零〇一二三四五六七八九十百\d]+)石', ordinal, result)


def name_registry(stones: list[Stone]) -> dict[str, set[str]]:
    custom = json.loads(ALIASES_PATH.read_text(encoding='utf-8'))['aliases'] if ALIASES_PATH.exists() else {}
    registry = defaultdict(set)
    for stone in stones:
        meta = catalogue.metadata(stone)
        names = [stone.name, stone.id, *meta.get('aliases', []), *custom.get(stone.id, [])]
        if '画像第' in stone.name:
            names.append(stone.name.replace('画像', ''))
        for alias in list(names):
            match = re.fullmatch(r'(前石室|左石室)([一二三四五六七八九十]+)', alias)
            if match:
                names.append(match[1] + '第' + match[2] + '石')
        for name in names:
            # Imported folder numbers are not part of the name in books.
            name = re.sub(r'^\d+\s+', '', name)
            term = normalize(name)
            if (len(term) >= 4 or name in ('西阙', '东阙') or
                len(term) == 3 and (name.endswith(('碑', '石狮')) or name in custom.get(stone.id, []))):
                registry[term].add(stone.id)
    return dict(registry)


@lru_cache(maxsize=8)
def _name_pattern(names: tuple[str, ...]):
    return re.compile('|'.join(re.escape(name) for name in sorted(names, key=len, reverse=True)) or r'(?!)')


def match_names(value: str, registry: dict[str, set[str]]) -> dict[str, str]:
    hits = {}
    for match in _name_pattern(tuple(registry)).finditer(normalize(value)):
        term = match.group()
        # A shared historical name cannot silently choose one current stone.
        if len(registry[term]) == 1:
            hits[next(iter(registry[term]))] = term
    return hits


def description(stone: Stone) -> str:
    value = str((stone.archive or {}).get('intro') or '')
    return re.split(r'(?:资料来源|依据|参考资料|参考文献)\s*[:：]', value, maxsplit=1)[0].strip()


def positive_excerpt(value: str, terms: list[str]) -> str:
    """A source citation, comparison, question or negation is not a depiction."""
    found = []
    for clause in re.split(r'[\n。；;]', value):
        if not any(normalize(term) in normalize(clause) for term in terms):
            continue
        if re.search(r'未见|不见|没有|并非|不是|是否|疑似|可能|参见|对比|比较|类似|参照', clause):
            continue
        found.append(clause.strip().strip('*'))
    return '；'.join(found)


def inventory(question: str, terms: list[str], stones: list[Stone]) -> dict | None:
    if not re.search(r'多少|几[块件处方]|数量|总数|哪些', question) or not re.search(r'石|[块件]', question):
        return None
    from .knowledge_graph import search_vocabulary
    groups = search_vocabulary()
    tail = re.search(r'(?:刻有|刻着|带有|绘有|画有|画着|描绘|有)([^，。！？?]+?)(?:的?形象|的?题材|的?画像(?!石)|[，。！？?]|$)', question)
    value = tail[1] if tail else ''
    value = re.split(r'刻有|刻着|带有|绘有|画有|画着|描绘|有', value)[-1].strip('的“”「」呢吗？? ')
    if value and not re.search(r'多少|几|哪些|块|画像石|石头', value) and len(value) <= 20:
        # A broad dictionary word inside a longer requested subject must not
        # broaden the count: 凤鸟 is not every 鸟, and 玉兔 is not every 兔.
        selected = [group for group in groups if any(normalize(term) == normalize(value) for term in group)] or [[value]]
        topic = value
    else:
        selected = [group for group in groups if any(term in question for term in group)]
        if not selected:
            return None
        names = sorted({word for group in selected for word in group if word in question}, key=len, reverse=True)
        topic = names[0]
        selected = [group for group in selected if topic in group]
    variants = list(dict.fromkeys([topic, *[word for group in selected for word in group]]))
    # A deity may appear as both a person and a story label in the vocabulary.
    if topic.endswith('的故事'):
        variants.append(topic.removesuffix('的故事'))
    locations = [name for name in ['武梁祠', '前石室', '左石室'] if name in question and name not in topic]
    explicit = match_names(question, name_registry(stones))
    items = []
    described = 0
    for stone in sorted(stones, key=lambda row: row.id):
        meta = catalogue.metadata(stone)
        if explicit and stone.id not in explicit:
            continue
        if locations and not any(loc in stone.name or loc == meta.get('group') for loc in locations):
            continue
        body = description(stone)
        described += bool(body)
        excerpt = positive_excerpt(body, variants)
        if excerpt:
            items.append({'id': stone.id, 'name': stone.name, 'text': excerpt,
                          'source_text': (stone.archive or {}).get('intro', '')})
    return {'topic': topic, 'count': len(items), 'items': items, 'basis': '逐石底本', 'described_stones': described}


def inventory_answer(result: dict) -> dict:
    items = result['items']
    if items:
        answer = f"按逐石底本记载，共 **{len(items)} 块**画像石有**{result['topic']}**形象：\n\n"
        answer += '\n'.join(f"- **{item['id']} {item['name']}**：{item['text']}。[{index}]" for index, item in enumerate(items, 1))
    else:
        answer = f"逐石底本中尚未找到“{result['topic']}”的记载。"
    return {'answer': answer, 'route': 'stone_inventory', 'provider': '逐石底本', 'inventory': result,
            'citations': [{'number': i, 'scope': 'stone', 'id': row['id'], 'title': row['id'] + ' ' + row['name'],
                           'text': row['source_text']} for i, row in enumerate(items, 1)]}


def _stamp() -> tuple:
    paths = [settings.db_path, settings.db_path.with_name(settings.db_path.name + '-wal'), ALIASES_PATH,
             settings.root / 'config/knowledge-graph/core10-candidates.v1.json']
    return tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) if path.exists() else (str(path), 0, 0) for path in paths)


def reading_index(db: Session) -> dict:
    global _cache, _cache_key
    with _lock:
        # Annotation edits do not invalidate an OCR/name index. Hash the actual
        # reading sources so a new label does not force a full corpus scan.
        source_rows = db.execute(text("SELECT s.id,s.document_id,s.page_id,s.kind,s.seq,s.text,s.text_edit,s.review_status,s.revision,s.reference_identity "
                                      "FROM segments s JOIN documents d ON d.id=s.document_id WHERE d.collection='core' ORDER BY s.id")).all()
        stone_rows = db.execute(text('SELECT id,name,archive FROM stones ORDER BY id')).all()
        doc_rows = db.execute(text("SELECT id,title,collection,sha256,reference_identity FROM documents WHERE collection='core' ORDER BY id")).all()
        page_rows = db.execute(text("SELECT p.id,p.document_id,p.page_no,p.reference_identity FROM doc_pages p JOIN documents d ON d.id=p.document_id WHERE d.collection='core' ORDER BY p.id")).all()
        raw_manifest = db.execute(text("SELECT payload FROM source_manifests WHERE id='core10-v1'")).scalar()
        signature = hashlib.sha256(json.dumps([*[list(map(list, rows)) for rows in [source_rows, stone_rows, doc_rows, page_rows]], raw_manifest], ensure_ascii=False).encode()).hexdigest()
        key = (id(db.get_bind()), signature, _stamp()[2:])
        if _cache is not None and key == _cache_key:
            return _cache
        from . import knowledge_graph
        stones = db.query(Stone).order_by(Stone.id).all()
        registry = name_registry(stones)
        manifest = {int(row['id']): row for row in json.loads(raw_manifest or '[]')}
        docs = {doc.id: doc for doc in db.query(Document).filter(Document.collection == 'core').all()
                if doc.id in manifest and doc.sha256 == manifest[doc.id].get('sha256')}
        rows = db.query(Segment, Page).join(Page, Segment.page_id == Page.id).filter(
            Segment.document_id.in_(docs), Segment.review_status != 'rejected').order_by(Segment.document_id, Page.page_no, Segment.seq, Segment.id).all()
        graph = knowledge_graph._dataset()
        graph_sources, _ = knowledge_graph._sources(db, graph['evidence'])
        valid = {source['id']: source for source in graph_sources if source['source_available']}
        graph_nodes = {node['id']: node for node in graph['nodes']}
        topic_registry = defaultdict(set)
        for node in graph['nodes']:
            if node['kind'] == 'stone' or node.get('entity_scope') == 'story_role':
                continue
            for name in [node['label'], *node.get('aliases', [])]:
                if len(normalize(name)) >= 2:
                    topic_registry[normalize(name)].add(node['id'])
        topic_pattern = _name_pattern(tuple(topic_registry))
        passages, topics = {}, defaultdict(set)
        links = defaultdict(dict)
        unresolved = []
        current_doc, section_stones, chapter, section_topics = None, {}, '', set()
        for seg, page in rows:
            doc = docs[seg.document_id]
            body = seg.display_text.strip()
            if not body:
                continue
            if current_doc != doc.id:
                current_doc, section_stones, chapter, section_topics = doc.id, {}, '', set()
            hits = match_names(body, registry)
            body_topics = {nid for match in topic_pattern.finditer(normalize(body)) for nid in topic_registry[match.group()]}
            # Numbered stone chapters explicitly establish scope until the next
            # peer chapter. Never carry a name from ordinary prose into later pages.
            stone_chapter = (seg.kind == 'title' and len(body) < 85 and
                             bool(re.match(r'^[一二三四五六七八九十百〇零]+、', body)) and
                             bool(re.search(r'画像|[东西南北]壁|石室|阙', body)))
            picture_heading = (seg.kind in ('title', 'caption') and len(body) < 85 and
                               bool(re.match(r'^图(?:版)?[\s\d一二三四五六七八九十]+', body)) and
                               (bool(hits) or bool(re.search(r'第.+石|[东西南北]壁', body))))
            if stone_chapter or picture_heading:
                section_stones, chapter = hits, body
                section_topics = set()
                if not hits and re.search(r'[东西南北前后]壁|隔梁|小龛|承檐|屋顶|第.+石|母阙|子阙|“[^”]+画像”', body):
                    unresolved.append({'document_id': doc.id, 'page_no': page.page_no, 'segment_id': seg.id, 'name': body})
            elif seg.kind == 'title' and len(body) < 90 and re.match(r'^[一二三四五六七八九十百〇零\d]+[、．.\s]?', body):
                section_topics = {nid for nid in body_topics if graph_nodes[nid]['kind'] == 'story'}
            # Headers/footers and TOC lines are navigation, not reading evidence.
            if seg.kind in ('header', 'footer') or re.search(r'\.{4}|…{2}', body):
                continue
            evidence = {'id': 'segment:' + seg.reference_identity, 'document_id': doc.id, 'document_title': doc.title,
                        'document_identity': doc.reference_identity, 'document_sha256': doc.sha256, 'file_sha256': doc.sha256,
                        'page_id': page.id, 'page_no': page.page_no, 'page_identity': page.reference_identity,
                        'segment_id': seg.id, 'source_identity': seg.reference_identity, 'segment_revision': seg.revision,
                        'review_status': seg.review_status, 'excerpt': body, 'kind': seg.kind,
                        'source_available': True, 'source_status': 'available'}
            passages[seg.id] = evidence
            for topic in body_topics | section_topics:
                topics[topic].add(seg.id)
            for stone_id, name in {**section_stones, **hits}.items():
                links[stone_id][seg.id] = {'method': 'name' if stone_id in hits else 'chapter',
                                          'matched_name': name, 'heading': chapter if stone_id in section_stones else ''}
        stone_topics = defaultdict(set)
        for edge in graph['edges']:
            ends = [graph_nodes[edge[side]] for side in ('source', 'target')]
            stone_ids = [node.get('stone_id', node['id'].removeprefix('stone:')) for node in ends if node['kind'] == 'stone']
            for sid in stone_ids:
                if any(eid in valid for eid in edge.get('evidence_ids', [])):
                    stone_topics[sid].update(node['id'] for node in ends if node['kind'] != 'stone')
                for eid in edge.get('evidence_ids', []):
                    if eid in valid and valid[eid]['segment_id'] in passages:
                        links[sid].setdefault(valid[eid]['segment_id'], {'method': 'book_association', 'matched_name': '', 'heading': ''})
        for association in graph.get('unresolved_stone_associations', []):
            hits = match_names(association['book_stone_name'], registry)
            source = valid.get(association['evidence_id'])
            if len(hits) == 1 and source:
                sid = next(iter(hits))
                stone_topics[sid].add(association['story_id'])
                if source['segment_id'] in passages:
                    links[sid].setdefault(source['segment_id'], {'method': 'book_association', 'matched_name': association['book_stone_name'], 'heading': ''})
        # Previously checked catalogue entries record the precise source page.
        for stone in stones:
            body = description(stone)
            stone_topics[stone.id].update(node['id'] for node in graph['nodes'] if node['kind'] != 'stone'
                and node.get('entity_scope') != 'story_role' and positive_excerpt(body, [node['label'], *node.get('aliases', [])]))
            source = catalogue.metadata(stone).get('intro_source') or {}
            if source.get('book') == '朱锡禄嘉祥汉画像石' and source.get('pdf_page'):
                for segid, entry in passages.items():
                    if '嘉祥汉画像石' in entry['document_title'] and entry['page_no'] == source['pdf_page']:
                        links[stone.id].setdefault(segid, {'method': 'catalogue_page', 'matched_name': stone.name, 'heading': ''})
        data = {'passages': passages, 'links': dict(links), 'registry': registry, 'topics': dict(topics),
                'stone_topics': dict(stone_topics), 'unresolved': unresolved,
                'books': [{'id': doc.id, 'title': doc.title} for doc in docs.values()], 'graph': graph, 'graph_sources': valid}
        _cache, _cache_key = data, key
        report = {'version': 1, 'books': data['books'], 'processed_stones': len(stones),
                  'matched_stones': len(links), 'unresolved_headings': unresolved,
                  'stones': [{'id': stone.id, 'name': stone.name, 'matched': bool(links.get(stone.id)),
                   'aliases': [alias for alias, ids in registry.items() if stone.id in ids],
                   'topics': [{'id': nid, 'name': graph_nodes[nid]['label']} for nid in sorted(stone_topics.get(stone.id, []))],
                   'segments': [{'segment_id': segid, 'document_id': passages[segid]['document_id'],
                                 'page_no': passages[segid]['page_no'], **link}
                                for segid, link in links.get(stone.id, {}).items()]} for stone in stones]}
        destination = settings.data_dir / 'index/stone-literature-map.json'
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        temporary.replace(destination)
        return data


def literature(db: Session, stone_id: str) -> dict:
    from fastapi import HTTPException
    stone = db.get(Stone, stone_id)
    if not stone:
        raise HTTPException(404, '文物不存在')
    data = reading_index(db)
    links = data['links'].get(stone_id, {})
    all_links = dict(links)
    for topic in data['stone_topics'].get(stone_id, []):
        for segid in data['topics'].get(topic, []):
            all_links.setdefault(segid, {'method': 'topic', 'matched_name': '', 'heading': ''})
    passages = [{**data['passages'][segid], **link} for segid, link in all_links.items()]
    passages.sort(key=lambda row: (row['document_id'], row['page_no'], row['segment_id']))
    books = [{**book, 'count': sum(p['document_id'] == book['id'] for p in passages)} for book in data['books']]
    return {'stone_id': stone.id, 'stone_name': stone.name, 'books': books, 'passages': passages, 'direct_count': len(links),
            'description': description(stone), 'source_text': (stone.archive or {}).get('intro', '')}


def enrich_candidates(db: Session, result: dict) -> dict:
    """Use book sections to complete the per-stone menu, preserving graph IDs."""
    data = reading_index(db)
    graph = data['graph']
    source = literature(db, result['stone_id'])
    byid = {node['id']: node for node in graph['nodes']}
    stories = {node['id']: deepcopy(node) for node in result['stories']}
    entities = {(node['id'], node.get('story_id')): deepcopy(node) for node in result['entities']}
    evidence = {item['id']: item for item in result['evidence']}
    evidence.update(data['graph_sources'])
    for passage in source['passages']:
        evidence[passage['id']] = passage
    for node in graph['nodes']:
        if node['kind'] != 'story':
            continue
        aliases = [node['label'], *node.get('aliases', [])]
        base_hit = positive_excerpt(source['description'], aliases)
        # The scoped section title or depiction paragraph must name this story;
        # distant historical discussion alone does not add a new occurrence.
        scoped = [p for p in source['passages'] if p['method'] == 'chapter' and p['kind'] == 'title'
                  and any(normalize(alias) in normalize(p['excerpt']) for alias in aliases)]
        relevant = [p for p in source['passages'] if any(normalize(alias) in normalize(p['excerpt']) for alias in aliases)]
        if node['id'] not in stories and not (node['id'] in data['stone_topics'].get(result['stone_id'], []) or base_hit and relevant or scoped):
            continue
        refs = [p['id'] for p in relevant]
        if node['id'] in stories:
            stories[node['id']]['evidence_ids'] = list(dict.fromkeys([*stories[node['id']]['evidence_ids'], *refs]))
        else:
            stories[node['id']] = {**node, 'concept_name': node['label'], 'story_id': None, 'story_label': None,
                                   'evidence_ids': refs, 'annotation_ids': [], 'source_available': bool(refs), 'status': 'candidate'}
        for edge in graph['edges']:
            if node['id'] not in (edge['source'], edge['target']):
                continue
            child = byid[edge['target'] if edge['source'] == node['id'] else edge['source']]
            if child['kind'] not in ('person', 'object'):
                continue
            key = (child['id'], node['id'])
            if key in entities:
                continue
            # Use references from this stone's section, not every mention of the
            # shared person elsewhere in the ten books.
            refs = [p['id'] for p in relevant if any(normalize(label) in normalize(p['excerpt']) for label in [child['label'], *child.get('aliases', [])])]
            if not refs:
                refs = [eid for eid in edge['evidence_ids'] if eid in evidence and evidence[eid]['source_available']]
            if not refs:
                continue
            name = child['label'] + ('（' + node['label'] + '）' if child.get('entity_scope') == 'story_role' else '')
            entities[key] = {**child, 'concept_name': name, 'story_id': node['id'], 'story_label': node['label'],
                             'evidence_ids': refs, 'annotation_ids': [], 'source_available': True, 'status': 'candidate'}
    for item in [*stories.values(), *entities.values()]:
        item['source_count'] = len(item['evidence_ids'])
    children = {item['id'] for item in entities.values()}
    for nid in sorted(data['stone_topics'].get(result['stone_id'], [])):
        node = byid[nid]
        if node['kind'] not in ('person', 'object') or nid in children:
            continue
        refs = [p['id'] for p in source['passages'] if any(normalize(label) in normalize(p['excerpt']) for label in [node['label'], *node.get('aliases', [])])]
        if refs:
            entities[(nid, None)] = {**node, 'concept_name': node['label'], 'story_id': None, 'story_label': None,
                                    'evidence_ids': refs, 'source_count': len(refs), 'annotation_ids': [], 'source_available': True, 'status': 'candidate'}
    eids = {eid for node in [*stories.values(), *entities.values()] for eid in node['evidence_ids']}
    return {**result, 'stories': list(stories.values()), 'entities': list(entities.values()), 'evidence': [evidence[eid] for eid in sorted(eids) if eid in evidence],
            'books': source['books'], 'passages': source['passages'], 'description': source['description']}
