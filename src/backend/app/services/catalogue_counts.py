"""Deterministic counts over the same current catalogue used by the sidebar.

Only fully resolved metadata questions enter this path. Iconography, document,
photo and historical questions still require textual evidence, not row counts.
"""
from collections import Counter, defaultdict
import html
import re
import unicodedata

COUNT_INTENT = re.compile(r'多少|几\s*[件块幅副个]|数量|总数|总量|合计|统计|数一[下数]|有哪些|哪些|列出|列举|清单')
_NUMBERED_STONE = re.compile(r'^(.+?)(?:画像)?第[一二三四五六七八九十百零〇两0-9]+石')
_EXCLUDED = re.compile(r'《|照片|图片|拓片|书籍|文献|论文|全国|世界|流散|佚失|外地|历史上|原来|过去')
_FILLER = re.compile('|'.join(sorted([
    '武氏墓群石刻博物馆', '武氏墓群石刻', '武氏墓群', '武氏祠',
    '我想知道', '告诉我', '请统计', '请查询', '请问', '帮我', '帮忙', '查一下',
    '统计一下', '计算一下', '数一下', '数一数', '查询', '统计', '计算',
    '一共有', '总共有', '一共', '总共', '共有', '总数', '总量', '数量', '合计',
    '多少', '馆藏', '全馆', '台账', '当前', '现在', '目前', '现有', '现存',
    '全部', '所有', '到底', '究竟', '文物', '藏品', '石头', '石刻',
    '有哪些', '哪些', '列出来', '列出', '列举', '清单',
    '存放在', '摆放在', '存放', '摆放', '位于', '属于', '来自', '出土于', '出土',
    '组属', '来源', '里面', '一共', '是', '有', '的', '在', '中', '内', '里',
    '共', '几', '件', '块', '幅', '副', '个', '吗', '呢', '请',
], key=len, reverse=True)))


def norm(value):
    return re.sub(r'[\s，。？！：；、“”‘’"?!.:,;]+', '', unicodedata.normalize('NFKC', value or '')).casefold()


def active_rows(catalogue):
    rows = {}
    for key, raw in catalogue.items():
        if raw.get('active') is False:
            continue
        sid = raw.get('id') or key
        rows[sid] = {**raw, 'id': sid, 'name': raw.get('name') or sid}
    return sorted(rows.values(), key=lambda row: (row.get('display_order') or 9999, row['id']))


def group_aliases(rows):
    """Recover shared origin prefixes from existing names/aliases, not answers."""
    groups = {row['group'] for row in rows if row.get('group')}
    candidates = defaultdict(lambda: defaultdict(set))
    for row in rows:
        group = row.get('group')
        if not group:
            continue
        for name in [row['name'], *(row.get('aliases') or [])]:
            match = _NUMBERED_STONE.match(name)
            if match and len(match[1]) >= 2:
                candidates[match[1]][group].add(row['id'])
    aliases = {group: group for group in groups}
    for alias, targets in candidates.items():
        if len(targets) == 1:
            group, ids = next(iter(targets.items()))
            if len(ids) >= 2 and (alias not in groups or alias == group):
                aliases[alias] = group
    return aliases


def resolve(question, catalogue, location_groups):
    """Return complete metadata matches, or None if any condition is unresolved."""
    if not COUNT_INTENT.search(question) or _EXCLUDED.search(question):
        return None
    rows = active_rows(catalogue)
    vocabulary = []
    for alias, group in group_aliases(rows).items():
        vocabulary.append((alias, 'group', group, '组属'))
    locations = {row.get('location', '') for row in rows} - {''}
    areas = {area['key']: tuple([*area.get('locs', []), *area.get('children', [])])
             for area in location_groups}
    for location in locations:
        if location not in areas:
            vocabulary.append((location, 'location', (location,), '位置'))
    for area, locs in areas.items():
        vocabulary.append((area, 'location', locs, '位置'))
    for category in {row.get('category', '') for row in rows} - {''}:
        vocabulary.append((category, 'category', category, '类别'))
    vocabulary.append(('画像', 'category', '画像石', '类别'))
    # A question about confirmed grading can also be answered from the ledger.
    vocabulary.extend([('已定级', 'graded', True, '定级状态'),
                       ('未定级', 'graded', False, '定级状态')])
    text = norm(question)
    found = {}
    # Consume longer names first: 后展厅外墙 must not be reduced to 后展厅.
    for alias, field, value, label in sorted(vocabulary, key=lambda term: -len(norm(term[0]))):
        key = norm(alias)
        if key not in text:
            continue
        if field in found and found[field]['value'] != value:
            return None  # Multiple groups/alternatives need an explicit query plan.
        found[field] = {'field': field, 'value': value, 'label': label,
                        'display': value if field in ('group', 'category') else
                                   ('未见确认定级' if field == 'graded' and not value else alias)}
        text = text.replace(key, ' ')
    remaining = re.sub(r'\s+', '', _FILLER.sub('', text))
    if remaining or (not found and not re.search(r'馆藏|全馆|文物|藏品|石头|石刻|武氏祠|台账', question)):
        return None  # Never silently discard a story, date, dimension or negation.
    filters = list(found.values())

    def matches(row):
        for condition in filters:
            field, value = condition['field'], condition['value']
            if field == 'location' and row.get('location') not in value:
                return False
            if field == 'graded' and bool((row.get('grading') or {}).get('confirmed')) != value:
                return False
            if field in ('group', 'category') and row.get(field) != value:
                return False
        return True

    items = [{**{key: row.get(key, '') for key in ('id', 'catalogue_no', 'name', 'location', 'group', 'category')},
              'is_graded': bool((row.get('grading') or {}).get('confirmed'))}
             for row in rows if matches(row)]
    by_location = Counter(item['location'] for item in items)
    by_area = Counter()
    for location, count in by_location.items():
        area = next((key for key, locs in areas.items() if location in locs), location)
        by_area[area] += count
    return {'kind': 'catalogue', 'complete': True, 'scope': '当前馆藏台账',
            'scanned_archives': len(rows), 'count': len(items), 'unit': '件',
            'filters': filters, 'items': items,
            'by_location': [{'name': name, 'count': count} for name, count in by_location.items()],
            'by_area': [{'name': name, 'count': by_area[name]} for name in dict.fromkeys([*areas, *by_area])
                        if name in by_area]}


def evidence(result):
    sources = []
    for index, item in enumerate(result['items'], 1):
        title = '%s · %s · 身份卡' % (item['catalogue_no'], item['name'])
        text = '现行编号：%s；名称：%s；组属：%s；类别：%s；位置：%s。' % (
            item['catalogue_no'], item['name'], item['group'], item['category'], item['location'])
        text += '定级状态：%s。' % ('已确认定级' if item['is_graded'] else '未见确认定级')
        sources.append({'id': -index, 'kind': 'stone', 'ref': item['id'], 'title': title,
                        'page': 0, 'score': 0, 'snippet': text, 'text': text})
    return sources


def answer(result):
    def escape(value):
        return html.escape(str(value)).replace('|', '\\|').replace('\n', ' ')
    conditions = '、'.join('%s为“%s”' % (f['label'], escape(f['display'])) for f in result['filters'])
    description = ('符合%s的文物' % conditions) if conditions else '文物'
    lines = ['按当前馆藏台账，%s共 **%d 件**。' % (description, result['count'])]
    if result['items']:
        lines += ['', '存放分布：' + '、'.join('%s %d 件' % (escape(area['name']), area['count'])
                                           for area in result['by_area']) + '。', '',
                  '| 编号 | 名称 | 存放位置 | 依据 |', '| --- | --- | --- | --- |']
        for index, item in enumerate(result['items'], 1):
            lines.append('| %s | %s | %s | [E%d] |' % (
                escape(item['catalogue_no']), escape(item['name']), escape(item['location']), index))
    lines += ['', '按现行档案逐件计数，同一件文物的别名、照片和拓片不重复计算。']
    return {'answer': '\n'.join(lines), 'model': '', 'provider': '馆藏台账',
            'route': 'catalogue', 'notice': ''}
