"""Build review-only graph candidates from the frozen ten-book corpus.

Reads SQLite in mode=ro. Never writes annotations, concepts, assets, or the source
database. Directory/section extraction is deterministic; candidates are not claims
that a particular pixel region has been identified or that all OCR was proofread.
"""
from __future__ import annotations
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'resources/knowledge/candidates'
OUT.mkdir(parents=True, exist_ok=True)
sys.stdout.reconfigure(encoding='utf-8')


def clean(value):
    return re.sub(r'\s+', '', value)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:16]


def chinese_number(value):
    digits = {'〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
    if '十' in value:
        left, right = value.split('十', 1)
        return (digits.get(left, 1) * 10) + digits.get(right, 0)
    return int(''.join(str(digits[ch]) for ch in value))


def stone_name(value):
    return re.sub(r'[“”"\s]', '', value).replace('武氏祠', '').replace('画像石', '').replace('画像', '').replace('承檐石', '承檐枋').replace('室后壁小龛', '室小龛')


def story_name(value):
    value = re.sub(r'^\d+\s*[.．、]\s*', '', value).strip()
    value = re.split(r'如图|如前|解说如前|故事解说|故事如前|故事略|[（(]图', value)[0].strip('，,。 ')
    return value


db = sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
manifest = json.loads(db.execute("SELECT payload FROM source_manifests WHERE id='core10-v1'").fetchone()[0])
core_ids = [entry['id'] for entry in manifest]
assert len(core_ids) == 10 and len(set(core_ids)) == 10
documents = {}
for entry in manifest:
    doc = dict(db.execute('SELECT * FROM documents WHERE id=?', (entry['id'],)).fetchone())
    assert doc['collection'] == 'core' and doc['sha256'] == entry['sha256']
    assert doc['reference_identity'] == entry['reference_identity']
    documents[doc['id']] = doc

rows = [dict(row) for row in db.execute(
    "SELECT s.id,s.document_id,s.page_id,s.seq,s.kind,s.review_status,s.reference_identity AS source_identity,"
    "s.revision,CASE WHEN s.text_edit!='' THEN s.text_edit ELSE s.text END AS content,"
    "p.page_no,p.reference_identity AS page_identity,p.engine "
    "FROM segments s JOIN doc_pages p ON p.id=s.page_id "
    "WHERE s.document_id IN (%s) AND s.review_status!='rejected' ORDER BY s.document_id,p.page_no,s.seq" % ','.join('?' * 10), core_ids)
    if row['content'].strip()]
by_doc = defaultdict(list)
by_id = {}
for row in rows:
    by_doc[row['document_id']].append(row)
    by_id[row['id']] = row

nodes, edges, evidence = {}, {}, {}
edge_counts = Counter()


def cite(row, term='', note=''):
    text = row['content']
    start = max(0, text.find(term) - 90) if term else 0
    excerpt = text[start:start + 420]
    eid = f"core:{row['document_id']}:{row['id']}:{digest(excerpt)}"
    doc = documents[row['document_id']]
    evidence[eid] = {
        'id': eid, 'document_id': row['document_id'], 'document_title': doc['title'],
        'document_identity': doc['reference_identity'], 'document_sha256': doc['sha256'],
        'file_sha256': doc['sha256'], 'page_no': row['page_no'], 'page_id': row['page_id'],
        'page_identity': row['page_identity'], 'segment_id': row['id'],
        'source_identity': row['source_identity'], 'segment_revision': row['revision'],
        'review_status': row['review_status'], 'engine': row['engine'],
        'excerpt': excerpt, 'excerpt_start': start,
        'locator_note': note or '连续文段摘录；页码为PDF物理页。机器识别底稿仍需对照原页。',
        'source_available': True,
    }
    return eid


def node(nid, kind, label, refs=(), **extras):
    item = nodes.setdefault(nid, {'id': nid, 'kind': kind, 'label': label, 'aliases': [], 'status': 'candidate', 'description': '', 'evidence_ids': [], **extras})
    item['evidence_ids'] = list(dict.fromkeys(item['evidence_ids'] + list(refs)))
    return item


def edge(source, target, relation, refs, note, support_level):
    eid = 'edge:' + digest('|'.join([source, target, relation]))
    item = edges.setdefault(eid, {'id': eid, 'source': source, 'target': target, 'relation': relation,
        'status': 'candidate', 'evidence_ids': [], 'note': note, 'support_level': support_level})
    item['evidence_ids'] = list(dict.fromkeys(item['evidence_ids'] + list(refs)))
    return item


# Inventory is used only to resolve a book's physical stone name to the present
# identifier. It is not permitted to supply stories, entities, or evidence.
stones = [dict(row) for row in db.execute('SELECT id,name FROM stones ORDER BY id')]
stone_lookup = defaultdict(list)
for item in stones:
    stone_lookup[stone_name(item['name'])].append(item)
    if '西壁及西侧' in item['name'] or '东壁及东侧' in item['name']:
        for face in ('壁', '侧'):
            stone_lookup[stone_name(item['name']).replace('壁及西侧', face).replace('壁及东侧', face)].append(item)

# The book supplies a complete numbered subject directory, including decorative
# subjects. Preserve its duplicate numbers and OCR differences in directory_rows.
directory = []
last = None
for row in by_doc[3]:
    if not 47 <= row['page_no'] <= 51:
        continue
    match = re.match(r'^\s*(\d+)\s*[.．]\s*(.+?)\s*见图\s*(.+)', row['content'])
    if match:
        last = {'number': int(match[1]), 'raw_label': match[2].strip(), 'rows': [row], 'figure_text': match[3]}
        directory.append(last)
    elif last and re.match(r'^图\s*\d', row['content']):
        last['figure_text'] += '、' + row['content']
        last['rows'].append(row)

chapters, sections = {}, {}
current_chapter = None
current_section = None
chapter_re = re.compile(r'^([一二三四五六七八九十〇零]+)[、，](.+)')
for row in by_doc[3]:
    if row['page_no'] < 52:
        continue
    title = row['content'].strip()
    chapter_match = chapter_re.match(title) if row['kind'] == 'title' else None
    if chapter_match:
        number = chinese_number(chapter_match[1])
        current_chapter = {'number': number, 'title': chapter_match[2], 'row': row, 'rows': [], 'stone_matches': stone_lookup.get(stone_name(chapter_match[2]), [])}
        chapters[number] = current_chapter
        current_section = None
    if current_chapter is None:
        continue
    current_chapter['rows'].append(row)
    story_match = re.match(r'^(\d+)\s*[.．]\s*(.+)', title) if row['kind'] in ('title', 'caption', 'text') else None
    if story_match and len(title) < 100:
        key = (current_chapter['number'], int(story_match[1]))
        current_section = {'label': story_name(story_match[2]), 'row': row, 'rows': [], 'chapter': current_chapter['number']}
        sections[key] = current_section
    if current_section is not None:
        current_section['rows'].append(row)

# DOC-006 is a second, separately authored story book with explicit image
# descriptions. The following correspondence was read in its printed headings;
# it supplies parallel candidate evidence, not automatically confirmed aliases.
parallel_titles = {
    '伏羲与女娲': '伏羲、女娲', '祝融': '祝融', '神农': '神农', '黄帝作冠裳': '黄帝',
    '帝尧': '帝尧', '舜耕历山': '帝舜', '大禹治洪水': '夏禹', '夏桀行暴政': '夏桀',
    '曾母投杼': '曾母投杼', '闵子骞失捶': '闵子骞失棰', '老莱子娱亲': '老菜子娱亲',
    '丁兰供木人': '丁兰立木为父', '曹子劫桓': '曹子劫持齐桓公', '专诸刺吴王': '专诸刺吴王僚',
    '荆轲刺秦王': '荆轲刺秦王', '梁高行拒婚': '梁高行拒王聘', '鲁秋胡戏妻': '鲁秋胡戏妻',
    '鲁义姑姊舍儿': '鲁义姑姊', '鲁义姑姊': '鲁义姑姊', '楚昭贞姜待符': '楚昭贞姜',
    '韩柏榆被苔': '韩伯榆被母答', '邢渠哺父': '邢渠哺父', '董永卖身侍父': '董永卖身',
    '李善保幼主': '忠实的仆人李善', '金日碑画像': '骑都尉金日䃅',
    '蔺相如完璧归赵': '蔺相如完璧归赵', '范雎辱魏须贾': '范雎辱报魏须贾',
    '梁节姑姊故事': '梁节姑姊', '齐义继母': '齐义继母', '京师节女故事': '京师节女',
    '三州孝人': '三州孝人', '义浆羊公': '义浆羊公', '魏汤报仇': '魏汤报父仇',
    '赵徇的故事': '赵徇五岁知孝敬', '孝孙原谷': '孝孙原谷妙语救祖父',
    '要离刺庆忌': '要离刺庆忌', '豫让刺赵襄子': '豫让杀身报知己',
    '聂政刺韩王': '聂政刺韩王', '钟离春说齐王': '钟离春感动齐王',
    '管仲射小白': '管仲射小白', '赵盾喂灵辄': '赵盾救灵辄', '二桃杀三士': '二桃杀三士',
    '季札挂剑': '季扎挂剑', '周公辅成王': '周公辅成王', '文王十子': '太姒生十子',
    '孔子见老子': '孔子见老子', '孔子遇大人': '何馈丈人听孔子击磬',
    '柳下惠坐怀不乱': '柳下惠坐怀不乱', '赵氏托孤': '公孙杵臼程婴救赵氏孤儿',
    '泗水捞鼎图': '秦始皇泗水捞鼎',
}
parallel_sections = {}
current = None
for row in by_doc[6]:
    match = re.match(r'^[一二三四五六七八九十〇零—]+\s*(.+)', row['content']) if row['kind'] == 'title' and row['page_no'] >= 9 else None
    if match:
        current = {'label': match[1].strip(), 'row': row, 'rows': []}
        parallel_sections[current['label']] = current
    if current:
        current['rows'].append(row)

# Named people are a matching vocabulary, not independent evidence. No person is
# emitted unless the exact text occurs in a bounded story heading or depiction
# sentence. Potentially ambiguous ruler titles remain local to a story.
people = '''西王母 东王公 伏羲 女娲 祝融 神农 黄帝 颛顼 帝喾 帝尧 帝舜 虞舜 夏禹 大禹 夏桀 曾母 曾参 曾子 闵子骞 闵损 老莱子 丁兰 曹沫 曹子 齐桓公 小白 管仲 专诸 吴王僚 荆轲 秦王 秦始皇 秦武阳 秦舞阳 樊於期 夏无且 梁高行 鲁秋胡 秋胡 秋胡妻 鲁义姑姊 楚昭贞姜 贞姜 韩伯榆 邢渠 董永 朱明 章孝母 李善 金日磾 蔺相如 范雎 须贾 梁节姑姊 齐义继母 京师节女 魏汤 赵徇 原谷 要离 庆忌 豫让 赵襄子 聂政 韩王 钟离春 颜叔 信陵君 王陵母 王陵 赵盾 灵辄 晋灵公 高渐离 季札 周公 成王 周文王 太姒 孔子 老子 项橐 子路 何馈 柳下惠 公孙杵臼 程婴 赵朔 赵武 屠岸贾 随侯 蚩尤 雷神 天吴 北斗星君 南宫敬叔'''.split()
generic_roles = '侍者 侍女 侍郎 侍卫 使者 卫士 武士 官吏 骑士 御者 乐工 舞者 童子 妇人 老人 仙人 羽人 神人 奉金者 药官'.split()
ambiguous_names = {'秦王', '韩王', '小白', '成王', '贞姜', '曹子', '王陵母'}
objects = '匕首 地图 铜柱 柱 人头 首级 匣 木匣 容器 绣墩 轺车 织布机 曲足杖 拐杖 旌节 编磬 镜 弓 刀 剑 盾 笏 符 筑 伞盖 粮仓 桃 木人 木主 木棍 绳子 鼎 简册 雁 马 牛 弩 棋盘 酒杯 琉璃璧 玄圭 银瓮 连理树 六博 锦囊 手杖 车轮 双菱纹 铺首 鼓 磬 浪井 神鼎 麒麟 黄龙 莫荚 六足兽 玉英 白鱼 比翼鸟 比肩兽 比目鱼 泽马 嘉禾 云纹 鸡 鸭 鱼 朱雀 青龙 玄武'.split()
visual_re = re.compile(r'画面|画上|图中|像上|画像上|图像中|题榜|榜题|题曰|横题|刻[“着有一两二三四五六七八九十]|[“”]二字|手[执持捧握扶]|持[镜刀剑弓]|捧[盘雁]|拄[着一]|戴[一高]')
unprocessed_stones = []
story_records = []


def sentence_with(row, term):
    for match in re.finditer(r'[^。！？\n]+[。！？]?', row['content']):
        sentence = match.group()
        if term in sentence and visual_re.search(sentence):
            return True
    return False


def depicted_person(row, person):
    p = re.escape(person)
    for match in re.finditer(r'[^。！？\n]+[。！？]?', row['content']):
        sentence = match.group()
        if person not in sentence or not visual_re.search(sentence):
            continue
        # Reject mere references to neighbouring scenes and historical commentary.
        if re.search(p + r'[^，；。]{0,12}(?:故事|画像)[^，；。]{0,8}(?:左|右|前|后|侧)', sentence):
            continue
        if re.search(r'(?:为|是|即|题|曰|榜)[“：:「]?[^，；。]{0,5}' + p, sentence) or re.search(p + r'[^，；。]{0,12}(?:手|戴|跪|坐|站|捧|握|执|面向|面朝|拄|画像|之像)', sentence):
            return True
    return False


for entry in directory:
    figure_text = entry['figure_text'].replace('二1', '2-1')
    figures = list(dict.fromkeys(re.findall(r'(\d+)(?:\s*[-—－]\s*(\d+))?', figure_text)))
    figure_keys = [(int(a), int(b) if b else None) for a, b in figures]
    related_sections = [sections[key] for key in figure_keys if key in sections]
    raw_label = entry['raw_label']
    parallel = parallel_sections.get(parallel_titles.get(raw_label))
    label = next((s['label'] for s in related_sections if s['label']), raw_label)
    if raw_label.startswith(label):
        label = raw_label
    # Never merge a differently named story because of a broad character overlap.
    sid = 'story:' + digest(raw_label)
    refs = [cite(row, note='故事目录条目；不是对图像区域的确认。') for row in entry['rows']]
    story = node(sid, 'story', label, refs, raw_directory_label=raw_label,
                 extraction_status='section_supported' if related_sections else 'directory_only',
                 description='由核心书目录及对应正文生成的图像题材候选，等待核对原页并定位原石区域。')
    if raw_label != label:
        story['observed_variants'] = list(dict.fromkeys(story.get('observed_variants', []) + [raw_label]))
        story['variant_note'] = '同一目录图号对应的正文题名不同；可能为表述差异或OCR错字，尚未合并为确认别名。'
    for section in related_sections:
        ref = cite(section['row'], note='目录图号对应的分故事标题。')
        node(sid, 'story', label, [ref])
    if parallel:
        node(sid, 'story', label, [cite(parallel['row'], note='经比对题名与图像描述的第二核心故事书对应章节；仍为待核候选。')])
    context_rows = []
    stone_links = []
    for chapter_num, figure_num in figure_keys:
        chapter = chapters.get(chapter_num)
        if not chapter:
            continue
        section = sections.get((chapter_num, figure_num))
        selected_rows = section['rows'] if section else chapter['rows']
        context_rows.extend(selected_rows)
        chapter_ref = cite(chapter['row'], note='对应图号所在章节的原石名称；现行石号仅按名称匹配，需人工复核。')
        matches = chapter['stone_matches']
        if len(matches) == 1:
            stone = matches[0]
            nid = 'stone:' + stone['id']
            node(nid, 'stone', stone['name'], [chapter_ref], stone_id=stone['id'], mapping_status='name_match_pending_review')
            depiction_refs = [cite(r, label) for r in selected_rows if label in r['content'] and visual_re.search(r['content'])][:2]
            edge(nid, sid, 'depicts', refs + [chapter_ref] + depiction_refs,
                 '目录图号与章标题建立原石关联，现行档案按名称匹配；尚未定位图像区域。', 'directory_chapter_name_match')
            stone_links.append({'stone_id': stone['id'], 'book_stone_name': chapter['title'], 'figure': f'{chapter_num}' + (f'-{figure_num}' if figure_num else ''), 'status': 'candidate', 'evidence_ids': [chapter_ref] + refs})
        else:
            unprocessed_stones.append({'story_id': sid, 'book_stone_name': chapter['title'], 'chapter': chapter_num, 'reason': '现行档案无唯一同名项；不推断石号', 'evidence_id': chapter_ref})
    # Narrow entity facts to bounded story sections. A whole chapter is used only
    # for one-subject chapters; otherwise chapter co-occurrence remains unsupported.
    entity_rows = []
    for key in figure_keys:
        if key in sections:
            entity_rows.extend(sections[key]['rows'])
        elif key[1] is None and key[0] in chapters:
            entity_rows.extend(chapters[key[0]]['rows'])
    entity_rows = list({r['id']: r for r in entity_rows}.values())
    if parallel:
        entity_rows.extend(parallel['rows'])
    characters, depicted_objects = [], []
    for person in sorted(set(people + generic_roles), key=lambda value: (-len(value), value)):
        # A shorter name inside a longer explicitly qualified name is not another entity.
        matches = [r for r in entity_rows if person in r['content'] and depicted_person(r, person)]
        title_match = next((s['row'] for s in related_sections + ([parallel] if parallel else []) if person in s['label']), None)
        if title_match:
            matches = [title_match] + matches
        if not matches:
            continue
        if person in {'王陵', '秋胡', '贞姜'} and any(longer in label for longer in ['王陵母', '秋胡妻', '楚昭贞姜']):
            matches = [r for r in matches if re.search(re.escape(person) + r'(?!母|妻)', r['content'])]
            if not matches:
                continue
        local = person in generic_roles or person in ambiguous_names
        nid = 'person:' + (digest(sid) + ':' if local else '') + person
        person_refs = [cite(r, person, '故事标题或图像描述中的名称。人物身份及其图像区域仍待核对。') for r in matches[:2]]
        node(nid, 'person', person, person_refs, entity_scope='story_role' if local else 'named_person',
             context_story_id=sid if local else None,
             description='本故事中的泛称角色，不能与其他故事中的同名角色视为同一人。' if local else '核心文献出现的具名人物；跨故事共用名称节点，具体图像认定仍为候选。')
        edge(sid, nid, 'has_character', person_refs, '名称见于该故事标题或图像描述；并非已确认的图像分割或身份标注。', 'story_title_or_depiction_sentence')
        characters.append({'node_id': nid, 'label': person, 'status': 'candidate', 'evidence_ids': person_refs})
    for obj in objects:
        matches = [r for r in entity_rows if sentence_with(r, obj)]
        if len(obj) > 1:
            matches = [s['row'] for s in related_sections if obj in s['label']] + matches
        if len(obj) == 1:
            matches = [r for r in matches if re.search(r'(?:执|持|握|捧|扶|抱|拄|一|两|二|三|藏|置|拔|张|拉|驾|悬|击|坐|立|跪|放|插)[^。！？]{0,5}' + re.escape(obj), r['content'])]
        if not matches:
            continue
        nid = 'object:' + obj
        obj_refs = [cite(r, obj, '物象类别在该故事图像描述中出现；不表示跨故事是同一实物。') for r in matches[:2]]
        node(nid, 'object', obj, obj_refs, entity_scope='object_type', description='跨故事共享的是物象类别，不是同一件实物；图像位置待核。')
        edge(sid, nid, 'has_object', obj_refs, '图像描述中出现的物象类别候选；具体形制与图像区域需核对。', 'depiction_sentence')
        depicted_objects.append({'node_id': nid, 'label': obj, 'status': 'candidate', 'evidence_ids': obj_refs})
    # Supplement story/topic evidence from each of the other core books. Exact
    # labels are required. These are source pointers, never new depicted edges.
    cross_refs = []
    variants = list(dict.fromkeys([label, raw_label, re.sub(r'的故事$|故事$', '', label)]))
    if '孔子见老子' in variants:
        # This exact traditional form was inspected in DOC-008, p141, seg6606.
        variants.append('孔子見老子')
    for did in core_ids:
        if did == 3:
            continue
        matches = [r for r in by_doc[did] if r['kind'] not in ('header', 'page_number') and any(len(v) >= 2 and v in r['content'] for v in variants)]
        matches.sort(key=lambda r: (-(int(bool(visual_re.search(r['content']))) * 3 + int(r['kind'] == 'title') * 2), r['page_no'], r['seq']))
        if matches:
            row = matches[0]
            term = next(v for v in variants if v in row['content'])
            cross_refs.append(cite(row, term, '另一核心书的同名题材线索；仅供交叉核对，不据共现自动认定人物、原石或别名关系。'))
    node(sid, 'story', label, cross_refs)
    story_records.append({'id': sid, 'label': label, 'aliases': [], 'observed_variants': story.get('observed_variants', []),
        'directory_number': entry['number'], 'raw_directory_label': raw_label, 'status': 'candidate',
        'stone_associations': stone_links, 'characters': characters, 'objects': depicted_objects,
        'evidence_ids': story['evidence_ids'], 'cross_book_evidence_ids': cross_refs,
        'figure_references': [f'{a}' + (f'-{b}' if b is not None else '') for a, b in figure_keys]})

# These additions were read in the actual core-book paragraphs. They address
# short, unnumbered descriptions which the conservative automatic extractor
# intentionally misses. An anchor must occur verbatim in every cited paragraph.
def add_fact(raw_label, kind, label, row_ids, anchor=None, scope=None, note='', level='explicit_image_description'):
    records = [s for s in story_records if s['raw_directory_label'] == raw_label]
    assert records, ('Unknown directory subject', raw_label)
    sid = records[0]['id']
    anchor = anchor or label
    facts = [by_id[rid] for rid in row_ids]
    assert all(anchor in row['content'] for row in facts), (raw_label, label, anchor, row_ids)
    refs = [cite(row, anchor, note or '逐段核对的图像描述；仍需对照原页确认机器识别与图像位置。') for row in facts]
    if kind == 'person':
        scope = scope or 'story_role'
        nid = 'person:' + (digest(sid) + ':' if scope == 'story_role' else '') + label
        extra = {'entity_scope': scope, 'context_story_id': sid if scope == 'story_role' else None}
        relation = 'has_character'
    else:
        nid, relation = 'object:' + label, 'has_object'
        extra = {'entity_scope': 'object_type'}
    node(nid, kind, label, refs, **extra)
    item = edge(sid, nid, relation, refs,
                note or '核心书图像描述明确出现；跨故事共享物品仅表示类别，具体原石版本和区域待核。', level)
    if note:
        item['note'] = note
    item['support_level'] = level
    node(sid, 'story', records[0]['label'], refs)


add_fact('三州孝人', 'person', '三州孝人', [4678], '三位陌生人', note='原文描述三位陌生人互认父子；作为本故事的泛称人物组，不建立三位具名人物。')
add_fact('义浆羊公', 'person', '羊公', [4689], scope='named_person')
add_fact('义浆羊公', 'person', '亡浆者', [4689], note='榜题机器识别为“亡浆者”，字形和称谓需核对原页；不合并其他故事角色。')
for term in ['罐子', '勺']:
    add_fact('义浆羊公', 'object', term, [4689])
for term in ['大树', '大鸟']:
    add_fact('颜乌故事', 'object', term, [4707], note='书中以大树、大鸟和“孝鸟”榜题解释颜乌孝行；未据此认定画面另有人物颜乌。')
for term, rid in [('颜回', 5194), ('子路', 5195)]:
    add_fact('孔门弟子', 'person', term, [rid], scope='named_person', note='作者以“应是”辨认人物，为有出处的解释候选，尚待核图；不视为确定身份。', level='author_interpretation_uncertain')
add_fact('孔门弟子', 'person', '弟子', [5195])
add_fact('孔门弟子', 'object', '简', [5195], '执简')
add_fact('伯游孝亲', 'person', '伯游', [5275], note='仅见对应图号题名“伯游孝亲”，人物名字可能存在OCR问题；不自动归并为韩伯榆。', level='subject_title_only')
for term in ['狗', '鸡', '猪', '牛']:
    add_fact('庳厨', 'object', term, [5319])
add_fact('抚琴', 'object', '琴', [5370], level='subject_title_only')
add_fact('车骑', 'object', '车', [5432], level='subject_title_only')
for term in ['神人', '童子']:
    add_fact('风云之神出行', 'person', term, [5544])
add_fact('风云之神出行', 'object', '云车', [5544])
add_fact('风云之神出行', 'person', '风伯', [5544], scope='named_person', note='原文称“或者是传说中的风伯”，属不确定的作者解释。', level='author_interpretation_uncertain')
add_fact('北斗星君', 'person', '北斗星君', [5563], scope='named_person')
add_fact('北斗星君', 'person', '官吏', [5563])
for term in ['云车', '绣墩', '北斗七星']:
    add_fact('北斗星君', 'object', term, [5563])
add_fact('神人出行', 'person', '神人', [5573], level='subject_title_only')
add_fact('神话人物', 'person', '神话人物', [5576], level='subject_title_only')
for term in ['毛笔', '简牍']:
    add_fact('毛笔简牍图', 'object', term, [5783])
add_fact('人物车马', 'person', '人物', [5859], level='subject_title_only')
for term in ['车', '马']:
    add_fact('人物车马', 'object', term, [5859], level='subject_title_only')
add_fact('蚩尤故事', 'person', '蚩尤', [5931], scope='named_person', note='正文明确将图39-3解释为蚩尤故事；该节标题OCR为“蚩光”，保留题名差异待核。')
add_fact('人物画像', 'person', '人物', [5955], level='subject_title_only')
add_fact('人物和神话故事', 'person', '人物', [5942], level='subject_title_only')
add_fact('鸟、人物', 'person', '人物', [5968], note='原文明示画面残缺，人物身份不明。')
add_fact('鸟、人物', 'object', '鸟', [5968])
add_fact('蔡仞秋题字', 'object', '题字', [6008], note='题字作为文字物象；不把书写者蔡仞秋当作画面人物。')
add_fact('云纹', 'object', '云纹', [6020])
add_fact('蔡寿生题字', 'object', '题字', [6016, 6024], note='章概述称蔡寿生，图45-3题注识别为蔡仞秋；题字物象可作候选，作者身份差异待核。')
for term in ['鸡', '鸭', '鱼']:
    add_fact('祭品：鸡、鸭、鱼', 'object', term, [6055])
add_fact('孔子问师图', 'person', '人物', [6148], '刻六人', note='目录题名为孔子问师图；正文只写六人的姿态，未指认哪位是孔子，因此保留未识名人物候选。')
add_fact('八分铭文内容', 'object', '铭文', [6141])
add_fact('角抵戏', 'person', '角抵表演者', [6157], '两人在表演角抵', note='原文称两人在表演角抵，画面不清；本故事的角色类别，不是具名人物。')
add_fact('角抵戏', 'person', '观众', [6157], '另外三人在观看表演', note='原文称另外三人在观看表演；本故事的角色类别。')
add_fact('题记', 'object', '文字', [6183], '圆饼内刻一字', note='图53-1小圆饼内文字，原文注明剥落和可辨字；不将全部残字识别为定论。')
for term in ['兽', '虎']:
    add_fact('一兽一虎', 'object', term, [6183], note='图53-2题述“一兽一虎”；具体物种及残损状态待核。')
add_fact('朱雀', 'object', '朱雀', [6183], note='原文为“不易辨识，似朱雀模样”，仅保留有出处的存疑候选。', level='author_interpretation_uncertain')
add_fact('青龙', 'object', '青龙', [6191], note='原文为“青龙（或白虎）”，物种有争议，未确认；待核图后选定。', level='author_interpretation_uncertain')
add_fact('三执戟骑士', 'person', '骑士', [6233])
add_fact('三执戟骑士', 'object', '戟', [6233])
for term in ['朱雀', '玄武']:
    add_fact('朱雀玄武', 'object', term, [6242])
add_fact('天吴像', 'person', '天吴', [6286], scope='named_person')
add_fact('执彗门吏图', 'person', '执彗者', [6313], '左立人执彗', note='原文为左立人执彗；目录称门吏，角色身份及所在建筑版本需核对。')
for term in ['彗', '楼梯', '马']:
    add_fact('执彗门吏图', 'object', term, [6313])
for term in ['马', '轺车']:
    add_fact('马拉轺车', 'object', term, [6315], level='subject_title_only')

# Different surviving stones show different actors and poses. These menus unite
# source-supported variants for review, never assert every figure on every stone.
jing_note = '荆轲刺秦王的不同原石版本合并为题材菜单候选；本关系只由所引段落描述的版本支持，不能泛化为每块原石都出现此形象。具体石面及区域需逐一核对。'
add_fact('荆轲刺秦王', 'person', '夏无且', [3552, 3693], scope='named_person', note=jing_note + '书2明确称“夏无且紧抱荆轲”“御医夏无且”；书6史事段的“夏天且”为待核OCR，不作确认别名。')
for term in ['武士', '卫士']:
    add_fact('荆轲刺秦王', 'person', term, [3552] if term == '武士' else [5025], note=jing_note)
for term in ['柱', '匕首', '剑', '盾', '戟', '鞋', '匣子']:
    add_fact('荆轲刺秦王', 'object', term, [3552], note=jing_note)
add_fact('荆轲刺秦王', 'object', '头匣', [13714], note=jing_note + '“头匣”与“匣子”保留书中不同用词，尚未确认为同义词合并。')
add_fact('荆轲刺秦王', 'object', '人头', [5025], '内盛一头', note=jing_note + '原文“内盛一头，旁题樊於期”；这是樊於期首级物象，不是另一个站立人物。')
add_fact('荆轲刺秦王', 'object', '断袖', [13714], note=jing_note)

# Audit rejects lexical false positives: a person's surname, a hat shape,
# comparisons to another stone, and background narratives are not depicted items.
rejected_candidate_facts = []
def remove_fact(raw_label, relation, label, reason):
    sid = next(s['id'] for s in story_records if s['raw_directory_label'] == raw_label)
    for eid, item in list(edges.items()):
        if item['source'] == sid and item['relation'] == relation and nodes[item['target']]['label'] == label:
            rejected_candidate_facts.append({'story_id': sid, 'label': label, 'relation': relation, 'reason': reason,
                                             'evidence_ids': item['evidence_ids']})
            del edges[eid]

remove_fact('祝融', 'has_object', '弓', '原文是弓形帽子，不是弓箭。')
remove_fact('赵盾喂灵辄', 'has_object', '盾', '“赵盾”姓名被子串误命中，不是盾牌。')
remove_fact('文王十子', 'has_object', '人头', '原文是两人的头部中间榜题，不是独立首级物象。')
remove_fact('海神出行', 'has_object', '人头', '原文是人头鱼身神怪，不是独立首级物象。')
remove_fact('颀顼继黄帝', 'has_character', '黄帝', '此小节描绘颛顼，黄帝是邻图和历史比较，不是本图人物。')
remove_fact('玄圭', 'has_object', '琉璃璧', '仅比较斜斗纹相同，不是本图另刻琉璃璧。')
remove_fact('射鸟图', 'has_object', '鱼', '该段举例沂南、枣庄其他遗址祭祀供品，不能充当武氏祠射鸟图实体。')
remove_fact('泗水捞鼎图', 'has_character', '秦始皇', '章节标题涉及秦始皇，但图像描述没有明确识认秦始皇本人。')
remove_fact('神人操蛇', 'has_character', '神人', '原自动命中包含战国铜器背景比较，改用对应武氏祠图31-1的直接描述。')
add_fact('神人操蛇', 'person', '神人', [5711], '解释神人操蛇', note='作者认为解释为神人操蛇“较为贴切”，保留解释候选。', level='author_interpretation_uncertain')
add_fact('颀顼继黄帝', 'person', '颛顼', [4870], scope='named_person')
add_fact('祝融', 'object', '帽子', [6731], note='原文“弓形的帽子”；不按其外形生成弓箭物象。')
add_fact('射鸟图', 'object', '鸟', [4605], level='subject_title_only')
for term in ['勺', '盂', '桑树', '鸟', '狗']:
    add_fact('赵盾喂灵辄', 'object', term, [7069])
add_fact('赵盾喂灵辄', 'person', '御者', [7069])
add_fact('赵盾喂灵辄', 'person', '官员', [7069])
for term in ['周文王', '伯邑考', '姬发', '霍叔度', '康叔封', '冉季载']:
    add_fact('文王十子', 'person', term, [7096], scope='named_person', note='书6对前石室第七石图中榜题和人物顺序的解释；部分题榜依旧录辨识，非所有石面通用。')
add_fact('文王十子', 'person', '乳母', [7096])
for term in ['食盘', '板']:
    add_fact('文王十子', 'object', term, [7096])
add_fact('海神出行', 'person', '海神', [5954])
for term in ['云车', '龙', '龟', '蟾蜍', '矛', '简', '戟']:
    add_fact('海神出行', 'object', term, [5954])
add_fact('海神出行', 'person', '人头鱼身者', [5954], '人头鱼身', note='图40-1的人头鱼身神怪类型，不与樊於期首级物象混为一类。')
for term in ['蛇', '斧', '锤', '壁虎', '蜻蜓']:
    add_fact('神人操蛇', 'object', term, [5711])
for term in ['剑', '坟堆', '树', '鸟', '供案', '供品', '祭器']:
    add_fact('季札挂剑', 'object', term, [5828])
add_fact('季札挂剑', 'person', '随从', [5828])
for term in ['剑', '高足豆', '桃']:
    add_fact('二桃杀三士', 'object', term, [5767])
add_fact('二桃杀三士', 'person', '三位勇士', [5767], '为三个勇士', note='图33-2描述三个勇士，榜题均无内容；未将站位逐一强配古冶子、公孙接、田开疆。')
add_fact('二桃杀三士', 'person', '齐臣', [5767], note='原文“应为齐臣”，属作者的存疑角色解释。', level='author_interpretation_uncertain')
add_fact('二桃杀三士', 'person', '晏婴', [5767], scope='named_person', note='原文“似为晏婴”，保留存疑身份。', level='author_interpretation_uncertain')
for term in ['绳索', '龙', '舟', '桥']:
    add_fact('泗水捞鼎图', 'object', term, [6039])
add_fact('泗水捞鼎图', 'person', '渔夫', [7133])
add_fact('泗水捞鼎图', 'person', '官员', [7133], note='书6称“可能是秦官员”，不确认为秦始皇本人。', level='author_interpretation_uncertain')
for term in ['规', '矩']:
    add_fact('伏羲与女娲', 'object', term, [4819], note='书3分别说明后石室第五石、左石室第四石伏羲持矩、女娲持规；位置、尾部和羽翼随版本不同，需按具体原石核图。')
add_fact('孔子见老子', 'person', '项橐', [7103], scope='named_person', note='书6物理页80描述其他画像石第八石两人间推小单轮的儿童“应是项橐”，属推定身份，不泛化为所有版本。', level='author_interpretation_uncertain')
add_fact('孔子见老子', 'person', '随从', [7103], note='原文“应当是随从”，仅指该版本孔子身后人物，非具名身份。', level='author_interpretation_uncertain')
add_fact('孔子见老子', 'person', '御者', [7103], note='书6明确说老子身后车上坐一御者；具体原石为其他画像石第八石。')
for term in ['小单轮', '拐棍', '轩车']:
    add_fact('孔子见老子', 'object', term, [7103], note='仅由书6描述的其他画像石第八石版本支持，形制和区域仍待核。')

# Canonical identities require actual naming/context evidence. Ruler titles are
# resolved only within the attested story, never used as global identity keys.
identity_merges = []
def role_id(raw_label, label):
    sid = next(s['id'] for s in story_records if s['raw_directory_label'] == raw_label)
    return 'person:' + digest(sid) + ':' + label


def canonical_person(canonical_id, label, old_ids, aliases, row_ids, note, scope='named_person', context_story_id=None, contextual_aliases=None):
    refs = [cite(by_id[rid], note='人物同一性或别称的核心原文依据。' + note) for rid in row_ids]
    merged = [nid for nid in old_ids if nid in nodes and nid != canonical_id]
    item = node(canonical_id, 'person', label, refs, entity_scope=scope, context_story_id=context_story_id)
    item['entity_scope'], item['context_story_id'] = scope, context_story_id
    item['aliases'] = list(dict.fromkeys(item['aliases'] + aliases))
    item['alias_evidence_ids'] = list(dict.fromkeys(item.get('alias_evidence_ids', []) + refs))
    item['identity_note'] = note
    if contextual_aliases:
        item['contextual_aliases'] = contextual_aliases
    contexts = set()
    for nid in merged:
        item['evidence_ids'] = list(dict.fromkeys(item['evidence_ids'] + nodes[nid]['evidence_ids']))
        for eid, old_edge in list(edges.items()):
            if old_edge['target'] != nid:
                continue
            contexts.add(old_edge['source'])
            replacement = edge(old_edge['source'], canonical_id, old_edge['relation'],
                               old_edge['evidence_ids'] + refs, old_edge['note'], old_edge['support_level'])
            replacement['identity_evidence_ids'] = list(dict.fromkeys(replacement.get('identity_evidence_ids', []) + refs))
            del edges[eid]
        del nodes[nid]
    identity_merges.append({'canonical_node_id': canonical_id, 'canonical_label': label,
        'merged_node_ids': merged, 'aliases': aliases, 'contextual_aliases': contextual_aliases or [],
        'context_story_ids': sorted(contexts), 'evidence_ids': refs, 'note': note})


# The old short-name match in this paragraph occurred only inside “秋胡妻”.
# Keep it as evidence for the wife, but remove it from the husband's provenance.
for holder in [nodes['person:秋胡']] + [e for e in edges.values() if e['target'] == 'person:秋胡']:
    holder['evidence_ids'] = [eid for eid in holder['evidence_ids'] if evidence[eid]['segment_id'] != 4460]
canonical_person('person:鲁秋胡', '鲁秋胡', ['person:秋胡'], ['秋胡'], [6883, 6884],
                 '同章画像榜题称鲁秋胡，随后的故事明确“鲁国有个叫秋胡的人”；归并同一主人公，秋胡妻保持独立。')
canonical_person('person:楚昭贞姜', '楚昭贞姜', [role_id('楚昭贞姜待符', '贞姜')], ['贞姜'], [6894, 6895],
                 '同一图像段先称楚昭贞姜、后简称贞姜，下一段明确其为楚昭王夫人；不是泛称角色。')
canonical_person('person:大禹', '大禹', ['person:夏禹'], ['夏禹', '禹', '文命'], [4907, 4908, 4919, 6811],
                 '书3同一大禹治洪水节称大禹、禹，图3-10描述明确称夏禹；书6说明夏禹名文命、因封于夏故称夏禹。')
canonical_person('person:曹沫', '曹沫', [role_id('曹子劫桓', '曹子')], ['曹子'], [4999, 17652],
                 '书3把曹沫人物与“曹子劫桓”榜题对应；书5明确解释不同文献称曹沫、曹子。其他疑似OCR异文不自动归并。')
canonical_person('person:曾子', '曾子', [], ['曾参'], [13182, 19134],
                 '书4索引“曾参（曾子）”、书5索引“曾参，参见曾子”提供明确同人指引；故事中杀人的同名曾参未建立为该人物。')
canonical_person('person:虞舜', '虞舜', ['person:帝舜'], ['帝舜', '舜', '重华'], [6796, 6797, 5752],
                 '帝舜章正文称虞舜，并明确名重华、简称舜；与虞舜登梯修粮仓正文的同人说明相合。')
canonical_person('person:齐桓公', '齐桓公', [role_id('管仲射小白', '小白')], ['小白'], [7062],
                 '管仲射小白的核心书正文明确小白先入齐国即位“这就是齐桓公”。')

jing_sid = next(s['id'] for s in story_records if s['raw_directory_label'] == '荆轲刺秦王')
gao_sid = next(s['id'] for s in story_records if s['raw_directory_label'] == '高渐离击秦王')
canonical_person('person:秦始皇', '秦始皇', [role_id('荆轲刺秦王', '秦王'), role_id('高渐离击秦王', '秦王')],
                 ['秦王政'], [5020, 5024, 13811],
                 '仅荆轲、高渐离两故事的秦王按核心正文明确身份归并秦始皇。“秦王”是有歧义的君主称谓，不列为全局别名；蔺相如故事的秦王继续独立。',
                 contextual_aliases=[{'label': '秦王', 'story_ids': [jing_sid, gao_sid]}])
canonical_person('person:晏婴', '晏婴', [], ['晏子'], [7077],
                 '同段前称晏婴向齐景公建议，后写晏子作答；保留同人称谓，图像辨识本身仍为“似为晏婴”。')
canonical_person('person:秦武阳', '秦武阳', [], ['秦舞阳'], [6870],
                 '图像描述明确写“秦武(舞)阳”，并列题榜“秦武阳”。')

he_sid = next(s['id'] for s in story_records if s['raw_directory_label'] == '孔子遇大人')
he_id = role_id('孔子遇大人', '何馈')
canonical_person(he_id, '何馈', ['person:何馈'], [], [7111, 7113],
                 '“何馈”为机器识别底稿称谓，姓名疑字需对照原页；原书另说何匇／荷荼是另一回故事，不能把何瓯等OCR形近字自动视为确认别名。',
                 scope='story_role', context_story_id=he_sid)
nodes[he_id]['description'] = '疑字称谓，保留原文“何馈”供核对；暂按本故事身份保存，不建立确定的跨故事历史人物。何瓯／何匇／荷荼相关文字另需核页，未归并为别名。'
nodes[he_id]['observed_variants'] = ['何馈（原机器文字，待核字形）']
identity_scope_adjustments = [identity_merges.pop()]

for raw, corrected in [('麒麟', '麒麟'), ('蚩尤故事', '蚩尤故事'), ('泗水捞鼎图', '泗水捞鼎图')]:
    for record in story_records:
        if record['raw_directory_label'] == raw:
            original = record['label']
            record['label'] = corrected
            item = nodes[record['id']]
            item['label'] = corrected
            item['observed_variants'] = list(dict.fromkeys(item.get('observed_variants', []) + [original]))
            record['observed_variants'] = item['observed_variants']

# Recompute menus from graph edges so repeated directory entries show the same
# candidate menu, and explicitly distinguish partial decomposition from coverage.
menu_pending = {
    '关于射': '目录图15-2题名与正文“连理树”冲突；在对照页图前不据错位图号拆实体。',
    '乐舞图': '对应段落为乐舞文化概述，尚未取得足以指认该图各人物和乐器的明确描述。',
    '升仙图': '正文仅称“升仙图，解说略”；具体人物和器物待核原图及其他核心书。',
    '狩猎': '正文仅称“狩猎，解说略”；不凭题材补造猎人、武器或猎物。',
}
for record in story_records:
    for relation, field in [('has_character', 'characters'), ('has_object', 'objects')]:
        record[field] = [{'node_id': e['target'], 'label': nodes[e['target']]['label'], 'status': 'candidate',
                          'evidence_ids': e['evidence_ids'], 'support_level': e['support_level'], 'note': e['note']}
                         for e in edges.values() if e['source'] == record['id'] and e['relation'] == relation]
    has_facts = bool(record['characters'] or record['objects'])
    record['menu_status'] = 'partially_decomposed' if has_facts else 'needs_source_review'
    record['menu_note'] = menu_pending.get(record['raw_directory_label'],
        '已提取有出处的部分人物/物象；菜单未经原页逐图穷尽核对，不表示每个形象均已识别。')
    nodes[record['id']]['menu_status'] = record['menu_status']
    nodes[record['id']]['menu_note'] = record['menu_note']
unique_stories = {s['id']: s for s in story_records}
menu_coverage = {
    'unique_subjects': len(unique_stories),
    'with_entity_candidates': sum(bool(s['characters'] or s['objects']) for s in unique_stories.values()),
    'with_character_candidates': sum(bool(s['characters']) for s in unique_stories.values()),
    'with_object_candidates': sum(bool(s['objects']) for s in unique_stories.values()),
    'with_both': sum(bool(s['characters'] and s['objects']) for s in unique_stories.values()),
    'no_safe_entity_decomposition': [s['raw_directory_label'] for s in unique_stories.values() if not s['characters'] and not s['objects']],
    'exhaustively_verified_menus': 0,
    'title_only_menus': [s['raw_directory_label'] for s in unique_stories.values()
                        if s['characters'] or s['objects']
                        if all(e['support_level'] == 'subject_title_only' for e in s['characters'] + s['objects'])],
    'note': '主题目录完整覆盖不等于人物/物象穷尽拆解；当前实体菜单均是有出处的部分候选，待人工核图补齐。',
}
connected_entity_ids = {e['target'] for e in edges.values()}
for nid, item in list(nodes.items()):
    if item['kind'] in ('person', 'object') and nid not in connected_entity_ids:
        del nodes[nid]

coverage = []
for did, doc in documents.items():
    pages = {r['page_no'] for r in by_doc[did]}
    substantive_pages = {r['page_no'] for r in by_doc[did] if r['kind'] not in ('header', 'page_number')
        and len(re.findall(r'[\u3400-\u9fffA-Za-z]', re.sub(r'\[NO TEXT\]|\[Illegible Text\]', '', r['content'], flags=re.I))) >= 2}
    evidence_rows = [item for item in evidence.values() if item['document_id'] == did]
    stories = [n for n in nodes.values() if n['kind'] == 'story' and any(evidence[e]['document_id'] == did for e in n['evidence_ids'])]
    coverage.append({'document_id': did, 'title': doc['title'], 'authors': doc['authors'], 'code': doc['code'],
        'document_identity': doc['reference_identity'], 'document_sha256': doc['sha256'],
        'total_pages': doc['page_count'], 'pages_with_nonempty_segments': len(pages),
        'readable_pages': len(substantive_pages), 'readable_segments': len(by_doc[did]),
        'unprocessed_pages': [p for p in range(1, doc['page_count'] + 1) if p not in substantive_pages],
        'reviewed_segments': sum(r['review_status'] == 'reviewed' for r in by_doc[did]),
        'candidate_story_count': len(stories), 'candidate_evidence_count': len(evidence_rows), 'evidence_count': len(evidence_rows),
        'coverage_note': '可读指存在非页眉/页码、非占位符且含至少两个文字字符的未拒绝文段；不表示OCR语义准确、全文校对完成或所有页图内容已提取。'})

dataset = {'schema_version': 1, 'dataset_id': 'core10-candidates-v1', 'generated_at': datetime.now(timezone.utc).isoformat(),
    'scope': 'core10', 'status': 'candidate', 'documents': coverage, 'nodes': list(nodes.values()),
    'edges': list(edges.values()), 'evidence': list(evidence.values()), 'stories': story_records,
    'unresolved_stone_associations': unprocessed_stones, 'rejected_candidate_facts': rejected_candidate_facts,
    'identity_merges': identity_merges,
    'identity_scope_adjustments': identity_scope_adjustments,
    'metadata': {'source_manifest': 'core10-v1', 'generation_method': 'bounded_directory_and_section_extraction',
        'directory_document_id': 3, 'directory_pages': [47, 48, 49, 50, 51], 'directory_entries': len(directory),
        'chapter_count': len(chapters), 'story_sections': len(sections), 'entity_menu_coverage': menu_coverage,
        'no_formal_annotations_written': True, 'no_coordinates_inferred': True,
        'coverage_limitations': ['尚无区域坐标，不自动建立分割框或人物区域。', '机器识别的疑字、正文与目录题名差异保留待核。',
          '其他核心书的同名命中仅供交叉回查；不是人物、原石关系已被多书确认。',
          '泛称角色按故事区分，物品共享仅表示物象类别。', '未匹配当前唯一原石名称的资料保留无石号候选，不猜测藏品归属。',
          '目录包含神话、历史故事及装饰物象；story节点表示可标注图像主题，并非全部是叙事故事。']}}

# Fail before publishing any dataset with a broken/foreign provenance anchor.
for item in evidence.values():
    row = by_id[item['segment_id']]
    assert item['document_id'] in core_ids and row['document_id'] == item['document_id']
    assert row['page_id'] == item['page_id'] and row['page_no'] == item['page_no']
    assert item['excerpt'] in row['content']
    assert row['source_identity'] == item['source_identity'] and row['page_identity'] == item['page_identity']
for item in edges.values():
    assert item['source'] in nodes and item['target'] in nodes
    assert item['evidence_ids'] and all(e in evidence for e in item['evidence_ids'])
assert len(directory) >= 125, 'Directory coverage unexpectedly incomplete'
target = OUT / 'core10-candidates.v1.json'
target.write_text(json.dumps(dataset, ensure_ascii=False, indent=2), encoding='utf-8')
summary = {'ok': True, 'dataset': str(target), 'directory_entries': len(directory),
    'node_counts': dict(Counter(n['kind'] for n in nodes.values())), 'edge_counts': dict(Counter(e['relation'] for e in edges.values())),
    'evidence_count': len(evidence), 'documents_with_evidence': sorted({e['document_id'] for e in evidence.values()}),
    'total_pages': sum(d['total_pages'] for d in coverage), 'readable_pages': sum(d['readable_pages'] for d in coverage),
    'unresolved_stone_associations': len(unprocessed_stones), 'verified_contiguous_excerpts': True, 'entity_menu_coverage': menu_coverage,
    'cross_story_named_people': sorted({nodes[e['target']]['label'] for e in edges.values() if e['relation'] == 'has_character' and nodes[e['target']].get('entity_scope') == 'named_person' and sum(x['target'] == e['target'] for x in edges.values()) > 1})}
(OUT / 'validation.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
db.close()
