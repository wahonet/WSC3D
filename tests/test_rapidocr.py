"""Exercise original RapidOCR parameters with either portable interpreter."""
import sys,json,time,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/backend'))
from app.config import settings,model_path
from app.resource_paths import resolve_resource
BASE=settings.extension_root
compat=settings.rapidocr_compat
if compat.is_dir():sys.path.insert(0,str(compat))
device=sys.argv[1] if len(sys.argv)>1 else 'cpu'
if device=='dml':sys.path.insert(0,str(settings.rapidocr_dml))
import onnxruntime as ort
from rapidocr_onnxruntime import RapidOCR
import pypdfium2 as pdfium
import numpy as np
sys.stdout.reconfigure(encoding='utf-8')
book=json.loads((BASE/'books/lit-706965facd00deed/book.json').read_text(encoding='utf-8'))
path=BASE/'library'/book['file']
if not path.exists():path=BASE/'books'/book['id']/book['file']
path=resolve_resource(path)
start=time.monotonic()
if device=='dml':assert 'DmlExecutionProvider' in ort.get_available_providers()
engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1,det_limit_side_len=960,rec_batch_num=16,text_score=.65,
               det_use_dml=device=='dml',cls_use_dml=device=='dml',rec_use_dml=device=='dml',
               det_model_path=str(model_path('rapidocr')/'ch_PP-OCRv4_det_infer.onnx'),
               cls_model_path=str(model_path('rapidocr')/'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
               rec_model_path=str(model_path('rapidocr')/'ch_PP-OCRv4_rec_infer.onnx'))
loaded=time.monotonic()-start
with pdfium.PdfDocument(str(path)) as pdf:
    page=pdf[3];bitmap=page.render(scale=min(2.25,2000/max(page.get_size())))
    result,timings=engine(np.array(bitmap.to_pil().convert('RGB')))
rows=[{'box':np.asarray(r[0]).tolist(),'text':r[1],'score':float(r[2])} for r in result or []]
assert len(rows)>5 and sum(len(r['text']) for r in rows)>100
data={'ok':True,'engine':'RapidOCR','device':device,'providers':ort.get_available_providers(),'python':sys.executable,'pdf':str(path),'page':4,'load_seconds':loaded,'total_seconds':time.monotonic()-start,'rows':rows}
output=Path(os.environ.get('WSC_SMOKE_OUTPUT',str(Path(os.environ.get('TEMP','.' ))/'wsc-tests/rapidocr')))
output.mkdir(parents=True,exist_ok=True)
(output/f'rapidocr-{device}.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in data.items() if k!='rows'},ensure_ascii=False));print('recognized_lines',len(rows),flush=True)
