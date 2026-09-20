"""Resume original RapidOCR for one registered extension book, then refresh its index."""
import argparse,json,sqlite3,subprocess,sys,shutil,os
from pathlib import Path
from datetime import datetime
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src/backend'))
from app.config import settings
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('book_id');parser.add_argument('--dry-run',action='store_true');parser.add_argument('--device',choices=['auto','cpu','dml'],default='auto');args=parser.parse_args()
base=settings.extension_root
db=sqlite3.connect(settings.db_path)
row=db.execute('SELECT payload FROM extension_books WHERE id=?',(args.book_id,)).fetchone()
if not row:raise SystemExit('只能处理已登记的扩展文献编号。')
folder=base/'books'/args.book_id
if not (folder/'book.json').is_file():raise SystemExit('该条目没有可处理的全文原件。')
if args.dry_run:print(json.dumps({'registered':True,'book_id':args.book_id,'folder':str(folder),'python':str(settings.rapidocr_python),'device':args.device},ensure_ascii=False));sys.exit(0)
backup=settings.data_dir/'maintenance'/('extension-'+datetime.now().strftime('%Y%m%d-%H%M%S'));backup.mkdir(parents=True)
for path in folder.glob('*.json'):shutil.copy2(path,backup/path.name)
if not (folder/'text-pages.json').exists():(folder/'text-pages.json').write_text('[]',encoding='utf-8')
environment={**os.environ,'WSC_RAPIDOCR_DEVICE':args.device,'PYTHONDONTWRITEBYTECODE':'1'}
subprocess.run([str(settings.rapidocr_python),'-X','utf8','-B',str(ROOT/'tools/ocr_extension_worker.py'),args.book_id],env=environment,check=True)
updated=json.loads((folder/'book.json').read_text(encoding='utf-8'));payload=json.loads(row[0])
payload['provenance']['text_index']=updated.get('text_index',{})
db.execute('UPDATE extension_books SET payload=?,updated_at=? WHERE id=?',(json.dumps(payload,ensure_ascii=False),datetime.now().isoformat(),args.book_id));db.commit();db.close()
sys.path.insert(0, str(ROOT/'src/backend'))
from app.db import SessionLocal
from app.models import Document
from app.services.library import register_extension_books, _import_legacy_text
with SessionLocal() as session:
    document = session.query(Document).filter_by(collection='extension', book_id=args.book_id).first()
    if document is None:
        added = register_extension_books(session)['imported_pages']
    else:
        added = _import_legacy_text(session, document, payload)
        session.commit()
print(f'OCR 已保存，补入平台 {added} 页；平台已有校订与 OCR 保留。下次检索会自动刷新。')
