"""Public names and photographic versions, independent of storage-directory keys."""
import re

VERSION_ORDER = ['2010年', '2010年拓片', '2024年', '2025年', '广陵书社拓片', '未标明来源照片']

def public_version(label, kind='photo'):
    label = label or ''
    if '演示附件' in label:
        return '未标明来源照片'
    if '广陵书社' in label and kind == 'rubbing':
        return '广陵书社拓片'
    if '2010' in label:
        return '2010年拓片' if kind == 'rubbing' or '拓片' in label else '2010年'
    if '2024' in label:
        return '2024年'
    if '2025' in label:
        return '2025年'
    return '未标明来源照片'

def is_retired_code(value):
    return bool(re.fullmatch(r'[A-Za-z]+(?:[-－][A-Za-z0-9]+)+', (value or '').strip()))

def public_aliases(values):
    result = []
    for value in values or []:
        if is_retired_code(value) or re.match(r'^占位石[A-Z]', value):
            continue
        name = re.sub(r'^\d+\s+', '', value).strip()
        if name and name not in result:
            result.append(name)
    return result
