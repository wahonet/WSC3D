"""OCR every page without a usable text layer. Save page-level coverage and checkpoints."""
import argparse, concurrent.futures, json, os, sys, time
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/backend'))
from app.config import settings, model_path
from app.resource_paths import resolve_resource
BASE=settings.extension_root
_engine=None

def save(path,data):
    tmp=path.with_suffix('.tmp'); tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8'); os.replace(tmp,path)

def process(bid):
    global _engine
    # OpenCV 5 preserves the original OCR crop/spacing behavior. Keep only this
    # small compatibility package; the interpreter and other packages are shared.
    compat=settings.rapidocr_compat
    if (compat/'cv2').is_dir():sys.path.insert(0,str(compat))
    device=os.environ.get('WSC_RAPIDOCR_DEVICE','auto')
    if device not in {'auto','cpu','dml'}:raise ValueError('WSC_RAPIDOCR_DEVICE must be auto, cpu or dml')
    if device!='cpu' and (settings.rapidocr_dml/'onnxruntime').is_dir():
        sys.path.insert(0,str(settings.rapidocr_dml))
    import onnxruntime as ort
    import pypdfium2 as pdfium
    from rapidocr_onnxruntime import RapidOCR
    import numpy as np
    mp=BASE/'books'/bid/'book.json'
    b=json.loads(mp.read_text(encoding='utf-8'))
    text=json.loads((mp.parent/'text-pages.json').read_text(encoding='utf-8'))
    op=mp.parent/'ocr-pages.json'; cp=mp.parent/'ocr-coverage.json'
    done=json.loads(cp.read_text(encoding='utf-8')) if cp.exists() else []
    pages=json.loads(op.read_text(encoding='utf-8')) if op.exists() else []
    pages=list({p['page']:p for p in pages}.values())
    have={r['page'] for r in text}|{r['page'] for r in done}|{r['page'] for r in pages}
    dml=device!='cpu' and 'DmlExecutionProvider' in ort.get_available_providers()
    if device=='dml' and not dml:raise RuntimeError('DirectML provider is unavailable in the selected OCR environment')
    t0=time.time()
    pdf_path=mp.parent/b['file']
    if not pdf_path.is_file():pdf_path=BASE/'library'/b['file']
    pdf_path=resolve_resource(pdf_path)
    with pdfium.PdfDocument(str(pdf_path)) as doc:
        for n in range(len(doc)):
            if n+1 in have: continue
            if _engine is None:
                _engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1,det_limit_side_len=960,
                    rec_batch_num=16,text_score=.65,det_use_dml=dml,cls_use_dml=dml,rec_use_dml=dml,
                    det_model_path=str(model_path('rapidocr')/'ch_PP-OCRv4_det_infer.onnx'),
                    cls_model_path=str(model_path('rapidocr')/'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
                    rec_model_path=str(model_path('rapidocr')/'ch_PP-OCRv4_rec_infer.onnx'))
            page=doc[n]
            scale=min(2.25,2000/max(page.get_size()))
            bitmap=page.render(scale=scale)
            im=bitmap.to_pil().convert('RGB')
            result,_=_engine(np.array(im))
            im.close(); bitmap.close(); page.close()
            rows=[r for r in (result or []) if r[2]>=.68]
            content='\n'.join(r[1] for r in rows).strip()
            letters=sum(c.isalpha() for c in content)
            confidence=round(sum(r[2] for r in rows)/len(rows),4) if rows else 0
            accepted=letters>=25
            if accepted: pages.append({'page':n+1,'text':content,'method':'ocr','confidence':confidence})
            done.append({'page':n+1,'status':'indexed' if accepted else 'image-or-insufficient-text','characters':len(content),'confidence':confidence})
            if len(done)%8==0:
                save(op,sorted(pages,key=lambda r:r['page']));save(cp,done)
        save(op,sorted(pages,key=lambda r:r['page']));save(cp,done)
        b['text_index']={'total_pages':len(doc),'text_pages':len(text),'ocr_pages':len(pages),
            'indexed_pages':len(text)+len(pages),'ocr_checked_pages':len(done),
            'status':'text-and-ocr','note':'已检查全部PDF页面；文字层含来源OCR，补充OCR需核对原图。纯图版、空白及无足够可识别文字的页仅供阅览。'}
    save(mp,b)
    return {'book_id':bid,'title':b['title'],**b['text_index'],'seconds':round(time.time()-t0,1)}

if __name__=='__main__':
    print(json.dumps(process(sys.argv[1]),ensure_ascii=False))
