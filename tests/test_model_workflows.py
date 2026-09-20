"""Real SAM parameters and GPU handover; results stay in the acceptance folder."""
import argparse,json,os,sys,time,copy
from pathlib import Path
import tempfile
import requests
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/backend'))
sys.stdout.reconfigure(encoding='utf-8')
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,default=Path(tempfile.gettempdir()) / 'wsc-tests/model-workflows')
parser.add_argument('--engine',choices=['sam3','sam3.1'],default='sam3')
parser.add_argument('--online',action='store_true',help='Also run the configured online API test')
args=parser.parse_args()
ENGINE=args.engine
BASE=os.environ.get('WSC_TEST_URL','http://127.0.0.1:8030').rstrip('/')+'/api'
session=requests.Session()
session.post(BASE+'/workspace/login',json={'username':'admin','password':os.environ.get('WSC_WORKSPACE_PASSWORD','123456')},timeout=30).raise_for_status()
OUT=args.output;OUT.mkdir(parents=True,exist_ok=True)
report=[]
def check(name,fn):
    start=time.monotonic()
    try:r={'name':name,'ok':True,'detail':fn()}
    except Exception as e:r={'name':name,'ok':False,'error':str(e)}
    r['seconds']=round(time.monotonic()-start,2);report.append(r)
    print(json.dumps(r,ensure_ascii=False),flush=True)
    (OUT/'model-workflows.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
def post(path,body=None):
    r=session.post(BASE+path,json=body,timeout=360);r.raise_for_status();return r.json()
def load(engine):
    assert post('/tools/segment/load/'+engine)['ok']
    for _ in range(90):
        state=requests.get(BASE+'/tools/segment/status',timeout=20).json()['engines'][engine]
        if state['status']=='ready':return state
        if state['status']=='error':raise RuntimeError(state['detail'])
        time.sleep(1)
    raise TimeoutError(engine)
def sam_case(name,**kw):
    body={'engine':ENGINE,'asset_id':15,'prompt':'person','threshold':.1,'max_results':5,**kw}
    data=post('/tools/segment/text',body)
    (OUT/('sam-parameters-'+name+'.json')).write_text(json.dumps({'input':body,'result':data},ensure_ascii=False,indent=2),encoding='utf-8')
    assert data['ok'],data.get('error')
    if name in ['exemplar','reload']:assert len(data['detections'])>0
    return {'input':body,'detections':len(data['detections']),'engine':ENGINE}
check('load_'+ENGINE,lambda:load(ENGINE))
seed=post('/tools/segment/text',{'engine':ENGINE,'asset_id':15,'prompt':'person','threshold':.1,'max_results':5})
assert seed['ok'] and seed['detections'],seed
polygon=seed['detections'][0]['polygon']
xs,ys=zip(*polygon)
box={'cx':(min(xs)+max(xs))/2,'cy':(min(ys)+max(ys))/2,'w':max(xs)-min(xs),'h':max(ys)-min(ys),'label':1}
check(ENGINE+'_positive_negative_exemplars',lambda:sam_case('exemplar',boxes=[box,{'cx':.03,'cy':.03,'w':.04,'h':.04,'label':0}]))
check(ENGINE+'_enhanced_preview_tiles',lambda:sam_case('enhance',preprocess='enhance',tiling='preview'))
check(ENGINE+'_rubbing_invert_hires_tiles',lambda:sam_case('rubbing',preprocess='rubbing',invert=True,tiling='hires'))
def switch_local():
    r=post('/archive/llm/test',{'target':'local'});assert r['ok'],r
    state=requests.get(BASE+'/tools/segment/status',timeout=20).json()['engines'][ENGINE]
    assert state['status']=='idle',state
    return {'connection':r,'sam_state':state['status']}
check('sam_to_local_llm_releases_vram',switch_local)
check('local_llm_to_sam_reload',lambda:load(ENGINE))
check('sam_inference_after_handover',lambda:sam_case('reload'))
post('/tools/segment/unload/'+ENGINE)
from app.services import model_gateway as gateway
def local_grounded():
    cfg=gateway.load_config();cfg['online']['mode']='local_only'
    card=requests.get(BASE+'/archive/stones/武011',timeout=30).json()
    messages=[{'role':'system','content':'只依据给出的身份卡回答并引用[1]，不要补充其他信息。'}, {'role':'user','content':'[1] 馆藏编号：'+card['id']+'；名称：'+card['name']+'。请回答武梁祠西壁的馆藏编号。'}]
    r=gateway.answer(messages,cfg);assert r['route']=='local' and '武011' in ''.join(r['answer'].split()),r
    return r
check('real_local_grounded_answer',local_grounded)
def fallback():
    before=gateway.CONFIG_PATH.read_bytes();cfg=copy.deepcopy(gateway.load_config())
    cfg['online']['mode']='online_first'
    cfg['online']['profiles'][cfg['online']['provider']]['api_base']='http://127.0.0.1:1/v1'
    r=gateway.answer([{'role':'user','content':'只回复：迁移回退测试成功。'}],cfg)
    assert r['route']=='local' and r['notice'] and r['answer'],r
    assert gateway.CONFIG_PATH.read_bytes()==before
    return {**r,'config_unchanged':True,'simulated_failure':'unreachable loopback endpoint'}
check('online_failure_real_local_fallback',fallback)
if args.online:
    check('real_deepseek_after_fallback',lambda:post('/archive/llm/test',{'target':'online'}))
sys.exit(0 if all(r['ok'] for r in report) else 1)
