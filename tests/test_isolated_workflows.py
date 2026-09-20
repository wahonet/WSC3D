"""Mutation, recovery and scanner tests use a disposable database and test images."""
from contextlib import closing
from dataclasses import replace
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
FOLDER=Path(os.environ.get('WSC_TEST_OUTPUT',str(Path(os.environ.get('TEMP','.'))/'wsc-tests')))/('workflows-'+uuid.uuid4().hex[:8])
FOLDER.mkdir(parents=True)
with closing(sqlite3.connect((ROOT/'data/stonelab.db').as_uri()+'?mode=ro',uri=True)) as source, closing(sqlite3.connect(FOLDER/'stonelab.db')) as target:source.backup(target)
os.environ['STONELAB_DATA']=str(FOLDER)
sys.path.insert(0,str(ROOT/'src/backend'))
sys.stdout.reconfigure(encoding='utf-8')
from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app.models import Annotation,Asset,Stone
from app.services import retrieval,scanner,resources,resource_versions,library
from app.config import settings
from PIL import Image
client=TestClient(app)
client.post('/api/workspace/login',json={'username':'admin','password':os.environ.get('WSC_WORKSPACE_PASSWORD','123456')}).raise_for_status()
report=[]
def check(name,fn):
    try:row={'name':name,'ok':True,'detail':fn()}
    except Exception as exc:row={'name':name,'ok':False,'error':str(exc)}
    report.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    (FOLDER.parent/'isolated-workflows.json').write_text(json.dumps({'sandbox':str(FOLDER),'checks':report},ensure_ascii=False,indent=2),encoding='utf-8')
def call(method,path,body=None):
    response=client.request(method,path,json=body);assert response.is_success,(path,response.status_code,response.text[:500]);return response.json()
def save_model_result():
    raw=json.loads(Path(os.environ['WSC_SAM_RESULT']).read_text())
    polygon=raw['detections'][0]['polygon']
    created=call('POST','/api/annotations',{'stone_id':'武011','asset_id':15,'tool':'segment','atype':'polygon','geometry':{'points':polygon},'label':'迁移验收临时候选','review_status':'candidate'})
    aid=created['id']
    call('PATCH',f'/api/annotations/{aid}',{'label':'迁移验收已保存','review_status':'approved','note':'SAM3 实际推理结果的保存重开测试'})
    reopened=next(a for a in call('GET','/api/annotations?asset_id=15') if a['id']==aid)
    assert reopened['geometry']['points']==polygon and reopened['review_status']=='approved'
    segment=call('GET','/api/library/documents/1/pages/1')['segments'][0]
    ref=call('POST',f'/api/annotations/{aid}/references',{'kind':'segment','segment_id':segment['id']})
    assert ref['id']==aid and any(r['segment_id']==segment['id'] for r in ref['references'])
    assert client.post('/api/annotations',json={'stone_id':'武001','asset_id':15,'atype':'point','geometry':{'p':[.1,.2]}}).status_code==422
    return {'saved_annotation':aid,'points':len(polygon),'reference':ref['references'][-1]['id'],'cross_stone_reference_rejected':True}
def edit_identity():
    before=call('GET','/api/archive/stones/武001')
    result=call('PATCH','/api/archive/stones/武001',{'note':'隔离副本保存测试','size_cm':[100,80,12],'size_source':'estimated'})['stone']
    assert result['note']=='隔离副本保存测试' and result['size_cm']==[100,80,12] and result['size_source']=='estimated'
    assert client.patch('/api/archive/stones/武001',json={'id':'WS001'}).status_code==422
    with SessionLocal() as db:
        try:
            db.add(Stone(id='WS001',code='WS001',name='invalid',dirname=''));db.commit();raise AssertionError('old primary key allowed')
        except Exception as exc:
            db.rollback()
            assert 'CHECK' in str(exc) or '馆藏' in str(exc) or 'canonical' in str(exc),str(exc)
    return {'id':result['id'],'size_source':result['size_source'],'old_id_rejected':True}
def align_save():
    with SessionLocal() as db:
        row=db.query(Annotation).filter(Annotation.tool=='align').first();geometry=dict(row.geometry)
    left=geometry.get('left_asset_id',15);right=geometry.get('right_asset_id',1)
    result=call('POST','/api/align/commit',{'stone_id':'武011','left_asset_id':left,'right_asset_id':right,'geometry':geometry})
    assert result['annotation']['geometry']==geometry
    bad=client.post('/api/align/commit',json={'stone_id':'武001','left_asset_id':left,'right_asset_id':right,'geometry':geometry})
    assert bad.status_code==422
    return {'saved':result['annotation']['id'],'geometry_exact':True,'cross_stone_rejected':True}
def ocr_edit():
    before=retrieval.source_version()
    page=call('GET','/api/library/documents/1/pages/1');segment=page['segments'][0]
    refs_before=call('GET','/api/stones/武011/annotations')
    patched=call('PATCH',f"/api/library/segments/{segment['id']}",{'text_edit':'隔离校订测试：迁移后文字可保存。','base_revision':segment['revision']})
    assert patched['text']==segment['text'] and patched['text_edit'].startswith('隔离校订测试')
    assert before!=retrieval.source_version()
    assert call('GET','/api/stones/武011/annotations')==refs_before
    stale=client.patch(f"/api/library/segments/{segment['id']}",json={'text_edit':'过期请求','base_revision':segment['revision']})
    assert stale.status_code==409
    return {'segment':segment['id'],'old_revision_rejected':True,'machine_text_preserved':True,'reference_snapshots_preserved':True,'source_version_changed':True}
def file_changes():
    fake=replace(settings,root=FOLDER/'files',assets_root=FOLDER/'files/resources/stones')
    scanner.settings=resources.settings=resource_versions.settings=fake
    folder=fake.assets_root/'验收__武901'/ 'images/photos';folder.mkdir(parents=True)
    original=folder/'original.bmp';Image.new('RGB',(32,32),(20,40,60)).save(original)
    with SessionLocal() as db:
        stone=Stone(id='武901',code='武901',name='隔离测试石',dirname='验收__武901')
        db.add(stone);db.flush()
        asset=Asset(stone_id=stone.id,kind='photo',filename=original.name,relpath=original.relative_to(fake.assets_root).as_posix(),bytes=original.stat().st_size,width=32,height=32,fmt='BMP',sha256=resource_versions.digest(original))
        db.add(asset);db.flush()
        node=Annotation(stone_id=stone.id,asset_id=asset.id,tool='annotate',atype='point',geometry={'point':[.5,.5]},label='原节点')
        db.add(node);db.flush();saved=resource_versions.pin_asset(db,asset);db.commit()
        # Restrict scanner to this fixture by using a dedicated database for it.
        fixture=FOLDER/'scanner-runtime/stonelab.db'
        fixture.parent.mkdir()
        with closing(sqlite3.connect(FOLDER/'stonelab.db')) as source,closing(sqlite3.connect(fixture)) as dest:source.backup(dest)
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session
        engine=create_engine('sqlite:///'+fixture.as_posix())
        with Session(engine) as testdb:
            testdb.connection().exec_driver_sql('PRAGMA foreign_keys=OFF')
            testdb.connection().exec_driver_sql('DELETE FROM annotations WHERE stone_id != ?',('武901',))
            testdb.connection().exec_driver_sql('DELETE FROM assets WHERE stone_id != ?',('武901',))
            testdb.connection().exec_driver_sql('DELETE FROM stones WHERE id != ?',('武901',))
            testdb.commit()
            resources.settings=replace(fake,data_dir=FOLDER/'scanner-runtime')
            assert resources.settings.db_path == fixture
            moved=folder/'renamed.bmp';original.rename(moved)
            r=scanner.scan(testdb);assert r['assets_updated']==1
            current=testdb.get(Asset,asset.id);rel=current.relpath
            held=FOLDER/'held.bmp';moved.rename(held)
            r=scanner.scan(testdb);assert asset.id in r['assets_missing']
            held.rename(moved)
            old_size=moved.stat().st_size
            Image.new('RGB',(32,32),(60,40,20)).save(moved);assert moved.stat().st_size==old_size
            r=scanner.scan(testdb);assert asset.id in r['changed_files']
            assert testdb.query(Annotation).count()==1
            assert resource_versions.digest(resources.asset_path(rel))==saved['sha256']
            assert scanner.scan(testdb)['assets_removed']==0
        engine.dispose()
    return {'rename_recovered':True,'missing_preserved':True,'same_size_replacement_detected':True,'base_snapshot_unchanged':True,'nodes_preserved':True}
check('real_sam_result_save_reference_and_reopen',save_model_result)
check('identity_edit_and_old_key_rejection',edit_identity)
check('alignment_save_and_ownership',align_save)
check('ocr_edit_version_and_reference_preservation',ocr_edit)
check('file_rename_missing_replace_rescan',file_changes)
sys.exit(0 if all(r['ok'] for r in report) else 1)
