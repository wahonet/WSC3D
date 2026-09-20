"""Read-only acceptance against the installed vector index and configured model.

Run with tools/run.ps1 tests/test_archive_qa.py. Model answers use
the same configured gateway as the application; only the acceptance report is written.
"""
from pathlib import Path
import argparse
import copy
import tempfile
import json
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
sys.stdout.reconfigure(encoding='utf-8')
from app.services import retrieval
from app.services import model_gateway

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--local-only', action='store_true')
parser.add_argument('--output', type=Path, default=Path(tempfile.gettempdir()) / 'wsc-tests/search-qa')
args = parser.parse_args()
if args.local_only:
    original_answer = model_gateway.answer
    local_config = copy.deepcopy(model_gateway.load_config())
    local_config['online']['mode'] = 'local_only'
    model_gateway.answer = lambda messages, cfg=None: original_answer(messages, cfg or local_config)
OUT = args.output
OUT.mkdir(parents=True, exist_ok=True)
report = []


def check(name, run):
    started = time.monotonic()
    try:
        detail = run()
        item = {'name': name, 'ok': True, 'detail': detail}
    except Exception as error:
        item = {'name': name, 'ok': False, 'error': str(error)}
    item['seconds'] = round(time.monotonic() - started, 2)
    report.append(item)
    (OUT / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(item, ensure_ascii=False), flush=True)


def vectors():
    retrieval.build_dense()
    assert retrieval._state['dense_ready'], retrieval._state['dense_error']
    return {key: retrieval._state[key] for key in ('dense_ready', 'dense_n', 'chunks')}


def ranking():
    result = retrieval.search('西王母在武梁祠画像中有哪些特征？', 'all', 8)
    assert result['dense']
    assert result['groups'][0]['items'][0]['id'] == '武011'
    for group in result['groups'][1:]:
        assert any('vector' in item.get('retrieval_methods', []) for item in group['items'][:6]), group['scope']
    (OUT / 'hybrid-retrieval.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return [{'scope': g['scope'], 'count': g['count'], 'top': [{'id': i['id'], 'methods': i.get('retrieval_methods')} for i in g['items'][:3]]} for g in result['groups']]


def first_question():
    # Simulate a fresh process with a completed event from an earlier build.
    # The first query must clear it before scheduling the cached vector loader.
    retrieval._state.update(dense_ready=False, dense_building=False, dense_pending=False)
    retrieval._dense_complete.set()
    result = retrieval.ask('量子计算纠错阈值')
    assert result['route'] == 'evidence_only' and result['retrieval']['dense'], result
    return {'route': result['route'], 'dense': True, 'pending': retrieval._state['dense_pending']}


def pagination():
    first = retrieval.search('西王母', 'all', 8)['groups'][2]
    second = retrieval.search('西王母', 'all', 8, {'extension': 8})['groups'][2]
    assert first['count'] == second['count']
    assert not {i['id'] for i in first['items']} & {i['id'] for i in second['items']}
    assert all(not i.get('duplicate_core') for i in first['items'] + second['items'])
    return {'count': first['count'], 'first': len(first['items']), 'second': len(second['items'])}


def answer(question, extension=False):
    result = retrieval.ask(question, extension)
    assert result['answer'] and result['route'] in ('online', 'local'), result.get('notice')
    assert result['retrieval']['dense']
    refs = result['citations']
    assert refs and any('vector' in c.get('retrieval_methods', []) for c in refs if c['scope'] == 'core')
    assert any(c['scope'] == 'extension' for c in refs) == extension
    assert all(c.get('document_id') and c.get('page_no') and c.get('source_identity') for c in refs if c['scope'] != 'stone')
    (OUT / ('answer-extension.json' if extension else 'answer-' + ('short' if question == '武梁祠' else 'topic') + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'query': question, 'route': result['route'], 'dense': True, 'scopes': sorted({c['scope'] for c in refs}), 'citations': len(refs), 'answer_start': result['answer'][:220]}


def absent():
    result = retrieval.ask('量子计算纠错阈值')
    assert result['route'] == 'evidence_only' and result['citations'] == [], result
    return result


def counts():
    result = retrieval.ask('全馆有多少件文物？')
    assert result['route'] == 'catalogue'
    assert result['aggregate']['count'] == 150 and len(result['citations']) == 150
    return {'route': result['route'], 'count': 150}


check('installed_vectors', vectors)
check('first_question_waits_for_cached_vectors', first_question)
check('hybrid_ranking_and_west_wall', ranking)
check('extension_pagination_same_population', pagination)
check('no_evidence_no_fabrication', absent)
check('catalogue_count_preserved', counts)
check('short_query_direct_ai', lambda: answer('武梁祠'))
check('topic_core_answer', lambda: answer('西王母在武梁祠画像中有哪些特征？'))
check('topic_extension_answer', lambda: answer('西王母在武梁祠画像中有哪些特征？', True))
sys.exit(0 if all(item['ok'] for item in report) else 1)
