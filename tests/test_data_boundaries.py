"""Layouts, allowed-source rebuilds, stale-index rejection: isolated data only."""
from contextlib import closing
from dataclasses import replace
from pathlib import Path
import copy,hashlib,json,os,re,shutil,sqlite3,sys,time,uuid
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];FOLDER=Path(os.environ.get('WSC_TEST_OUTPUT',str(Path(os.environ.get('TEMP','.'))/'wsc-tests')))/('boundaries-'+uuid.uuid4().hex[:8]);FOLDER.mkdir(parents=True)
with closing(sqlite3.connect((ROOT/'data/stonelab.db').as_uri()+'?mode=ro',uri=True)) as source,closing(sqlite3.connect(FOLDER/'stonelab.db')) as target:source.backup(target)
os.environ['STONELAB_DATA']=str(FOLDER);sys.path.insert(0,str(ROOT/'src/backend'));sys.stdout.reconfigure(encoding='utf-8')
from fastapi.testclient import TestClient
from app.main import app
from app.services import retrieval
from app.config import settings
from app.routers import xcl_layout,rear_layout
client=TestClient(app);report=[]

def login():
    response=client.post('/api/workspace/login',json={'username':'admin','password':os.environ.get('WSC_WORKSPACE_PASSWORD','123456')})
    assert response.status_code==200,response.text

def check(name,fn):
    try:r={'name':name,'ok':True,'detail':fn()}
    except Exception as e:r={'name':name,'ok':False,'error':str(e)}
    report.append(r);print(json.dumps(r,ensure_ascii=False),flush=True)
    (FOLDER.parent/'data-boundaries.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
def workspace_access():
    anonymous=TestClient(app)
    public_posts={'/api/workspace/login','/api/workspace/logout','/api/archive/ask',
                  '/api/creative/preview','/api/creative/works','/api/creative/works/{identifier}/share'}
    reached=[]
    app.add_api_route('/api/future-write-probe',lambda: reached.append(True),methods=['POST'])
    before=hashlib.sha256(settings.db_path.read_bytes()).hexdigest()
    protected=[]
    try:
        assert anonymous.get('/api/workspace/session').json()=={'authenticated':False}
        for route in app.routes:
            for method in getattr(route,'methods',set()) & {'POST','PUT','PATCH','DELETE'}:
                if method=='POST' and route.path in public_posts:continue
                path=re.sub(r'\{[^}]+\}','999999',route.path)
                result=anonymous.request(method,path,json={})
                assert result.status_code==401,(method,path,result.status_code,result.text[:200])
                protected.append(method+' '+route.path)
        assert len(protected)>30 and not reached
        # The SPA catch-all rejects this unmatched trailing-slash route before
        # any API handler. It must never turn an anonymous write into success.
        assert anonymous.patch('/api/annotations/999999/',json={}).status_code in {401,405}
        assert hashlib.sha256(settings.db_path.read_bytes()).hexdigest()==before
        for path in ['/api/health','/api/archive/stones','/api/library/documents']:
            assert anonymous.get(path).status_code==200,path
        for path in ['/api/archive/ask','/api/creative/preview','/api/creative/works','/api/creative/works/not-a-uuid/share']:
            assert anonymous.post(path,json={}).status_code in {400,404,422},path
        login()
        original=client.get('/api/archive/stones/武011').json()['note']
        edited=client.patch('/api/archive/stones/武011',json={'note':'隔离权限验证'})
        assert edited.status_code==200 and edited.json()['stone']['note']=='隔离权限验证'
        assert client.patch('/api/archive/stones/武011',json={'note':'跨站不应保存'},headers={'Origin':'https://untrusted.invalid'}).status_code==403
        assert client.post('/api/workspace/logout').status_code==200
        assert client.patch('/api/archive/stones/武011',json={'note':'退出后不应保存'}).status_code==401
        login()
        assert client.get('/api/archive/stones/武011').json()['note']=='隔离权限验证'
        assert client.patch('/api/archive/stones/武011',json={'note':original}).status_code==200
        return {'protected_write_routes':protected,'public_reads_and_creation_preserved':True,'authenticated_edit_logout_and_origin_checked':True}
    finally:anonymous.close()
check('workspace_write_access_boundary',workspace_access)

def layouts():
    rows=[]
    for name,module,key in [('xcl',xcl_layout,'along'),('rear',rear_layout,'x')]:
        folder=FOLDER/name;shutil.copytree(ROOT/'data/layouts',folder)
        module.FOLDER=folder;module.CURRENT=folder/(name+'.json');module.DEFAULT=folder/(name+'-default.json')
        before=client.get('/api/layouts/'+name).json();changed=copy.deepcopy(before)
        changed['stones'][0][key]+=.01
        changed['base_updated_at']=before['updated_at']
        result=client.post('/api/layouts/'+name,json=changed);assert result.status_code==200,result.text
        saved=client.get('/api/layouts/'+name).json();assert saved['stones'][0][key]==round(changed['stones'][0][key],6)
        assert client.post('/api/layouts/'+name,json=changed).status_code==409
        bad=copy.deepcopy(changed);bad['stones'][0]['id']='WS001';assert client.post('/api/layouts/'+name,json=bad).status_code==422
        assert list((folder/'history').glob('*.json'))
        rows.append({'layout':name,'stones':len(saved['stones']),'edit_reload':True,'old_id_rejected':True,'history_retained':True})
    return rows
check('scene_layout_edit_save_reload',layouts)
def rebuild():
    assert not retrieval.INDEX.exists()
    retrieval.build_index();assert retrieval._state['ready'],retrieval._state
    retrieval._state['dense_building']=True
    with closing(retrieval.connect()) as db:
        kinds=[list(r) for r in db.execute('SELECT scope,kind,COUNT(*) FROM chunks GROUP BY scope,kind')]
        assert {r[0] for r in kinds}=={'core','extension'}
        assert {r[1] for r in kinds}<={'segment','figure','bibliography','page'}
    core=retrieval.search('西王母','core');assert not core['groups'][2]['items']
    return {'created_from_registered_sources':True,'groups':kinds,'core_excludes_extension':True}
check('missing_index_rebuild_from_registered_sources',rebuild)

def edit_and_rebuild():
    with closing(sqlite3.connect(settings.db_path)) as db:
        row=db.execute('SELECT id,text,revision FROM segments WHERE document_id=1 ORDER BY id LIMIT 1').fetchone()
    marker='修复回归检索甲乙丙'
    changed=client.patch('/api/library/segments/'+str(row[0]),json={'text_edit':row[1]+'\n'+marker,'base_revision':row[2]})
    assert changed.status_code==200,changed.text
    result=retrieval.search('西王母','core')
    assert retrieval._state['ready'] and result['groups'][1]['count']>0,result
    with closing(retrieval.connect()) as index:
        assert index.execute('SELECT COUNT(*) FROM chunks WHERE text LIKE ?',('%'+marker+'%',)).fetchone()[0]>0
    return {'segment_id':row[0],'edit_triggers_successful_rebuild':True,'edited_text_indexed':True}
check('segment_edit_keeps_document_search_available',edit_and_rebuild)
def excluded():
    with closing(sqlite3.connect(settings.db_path)) as db:
        sid,raw=db.execute('SELECT id,archive FROM stones LIMIT 1').fetchone();archive=json.loads(raw)
        archive.update(intro='迁移排除简介甲乙丙',research='迁移排除研究丁戊己',media=[{'label':'迁移排除媒体庚辛壬'}])
        db.execute('UPDATE stones SET archive=? WHERE id=?',(json.dumps(archive,ensure_ascii=False),sid));db.commit()
    values={}
    for query in ['迁移排除简介甲乙丙','迁移排除研究丁戊己','迁移排除媒体庚辛壬']:
        r=retrieval.search(query)
        if query == '迁移排除简介甲乙丙':
            assert [hit['id'] for hit in r['groups'][0]['items']] == [sid]
            assert all(g['count']==0 for g in r['groups'][1:])
            assert query not in json.dumps(r['groups'][0]['items'][0]['identity'],ensure_ascii=False)
        else:
            assert all(g['count']==0 for g in r['groups']),r
        values[query]=[g['count'] for g in r['groups']]
    assert retrieval.search('全馆有多少西王母画像？').get('aggregate') is None
    return {'excluded_field_sentinels':values,'unannotated_theme_not_counted_as_whole_catalogue':True}
check('intro_matches_stones_only_and_legacy_evidence_exclusions',excluded)
def fail_closed():
    with closing(sqlite3.connect(settings.db_path)) as db:
        title=db.execute('SELECT title FROM documents WHERE id=1').fetchone()[0]
        db.execute('UPDATE documents SET title=? WHERE id=1',(title+'（隔离测试）',));db.commit()
    original=retrieval.settings
    retrieval.settings=replace(original,library_root=FOLDER/'missing-pdfs')
    result=retrieval.search('西王母','core')
    assert not result['groups'][1]['items'] and result['groups'][1]['error']
    assert not retrieval._state['ready']
    retrieval.settings=original
    with closing(sqlite3.connect(settings.db_path)) as db:db.execute('UPDATE documents SET title=? WHERE id=1',(title,));db.commit()
    retrieval.build_index();assert retrieval._state['ready'] and retrieval.search('西王母','core')['groups'][1]['count']>0
    return {'stale_index_not_served_on_rebuild_failure':True,'recovered_by_rebuild':True}
check('changed_source_failure_and_index_recovery',fail_closed)

def alias_integrity():
    from app.resource_paths import resolve_resource
    with closing(sqlite3.connect(settings.db_path)) as db:
        relative=db.execute('SELECT relpath FROM documents WHERE id=1').fetchone()[0]
    logical=settings.library_root/relative
    physical=resolve_resource(logical)
    assert physical.is_file()
    corrupt=FOLDER/'tampered-frozen-original.pdf'
    corrupt.write_bytes(b'This is deliberately not the registered PDF.')
    with patch.object(retrieval,'resolve_resource',side_effect=lambda path: corrupt if path==logical else resolve_resource(path)):
        retrieval.build_index()
        assert not retrieval._state['ready'] and '原件校验未通过' in retrieval._state['error']
    retrieval.build_index()
    assert retrieval._state['ready'],retrieval._state
    return {'aliased_original':physical!=logical,'corrupt_physical_file_rejected':True,'valid_file_rebuild_recovers':True}
check('resolved_original_still_requires_matching_hash',alias_integrity)
sys.exit(0 if all(r['ok'] for r in report) else 1)
