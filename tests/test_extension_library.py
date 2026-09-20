"""扩展文献登记、检索隔离与重新 OCR 的回归测试，只使用临时资料。"""
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from app.db import Base
from app.models import Document, Page, Segment
from app.migrations import migrate
from app.services import library


class ExtensionLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = replace(library.settings, extension_root=self.root / 'documents/extension', data_dir=self.root / 'data')
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.db.execute(text("CREATE VIRTUAL TABLE segments_fts USING fts5(text, segment_id UNINDEXED, document_id UNINDEXED, page_no UNINDEXED, tokenize='trigram')"))
        self.db.execute(text('CREATE TABLE extension_books (id TEXT PRIMARY KEY, payload TEXT)'))
        self.folder = self.config.extension_root / 'books/test-book'
        self.folder.mkdir(parents=True)
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument.new()
        for _ in range(3):
            page = pdf.new_page(100, 100)
            page.close()
        pdf.save(str(self.folder / 'test.pdf'))
        pdf.close()
        self.book = {'id': 'test-book', 'title': '扩展文献测试', 'file': 'test.pdf', 'year': '2020', 'provenance': {}}
        self.db.execute(text('INSERT INTO extension_books VALUES (:id,:payload)'), {'id': self.book['id'], 'payload': json.dumps(self.book)})
        (self.folder / 'ocr-pages.json').write_text(json.dumps([{'page': 1, 'text': '旧版 OCR'}, {'page': 2, 'text': '武梁祠画像西王母'}, {'page': 99, 'text': '无效页'}]), encoding='utf-8')
        (self.folder / 'text-pages.json').write_text(json.dumps([{'page': 1, 'text': '武梁祠的文字层优先'}]), encoding='utf-8')
        self.db.commit()
        self.config_patch = patch.object(library, 'settings', self.config)
        self.config_patch.start()

    def tearDown(self):
        self.config_patch.stop()
        self.db.close()
        self.engine.dispose()
        self.temp.cleanup()

    def register(self):
        result = library.register_extension_books(self.db)
        return result, self.db.query(Document).filter_by(collection='extension').one()

    def test_registration_and_repeat_preserve_text_and_identity(self):
        result, doc = self.register()
        self.assertEqual((result['added'], result['imported_pages'], doc.page_count), (1, 2, 3))
        self.assertEqual(library.doc_path(doc), self.folder / 'test.pdf')
        pages = self.db.query(Page).order_by(Page.page_no).all()
        self.assertEqual([(p.status, p.engine) for p in pages], [('done', 'text-layer'), ('done', 'legacy-ocr'), ('pending', '')])
        self.assertEqual(pages[0].text, '武梁祠的文字层优先')
        originals = [(s.id, s.reference_identity, s.text) for s in self.db.query(Segment)]
        again, _ = self.register()
        self.assertEqual((again['added'], again['imported_pages']), (0, 0))
        self.assertEqual(originals, [(s.id, s.reference_identity, s.text) for s in self.db.query(Segment)])
        self.assertEqual(self.db.execute(text('SELECT count(*) FROM segments_fts')).scalar(), 2)
        self.assertEqual(library._import_legacy_text(self.db, doc, self.book), 0)
        self.assertEqual(self.db.execute(text('SELECT count(*) FROM segments_fts')).scalar(), 2)

    def test_collection_search_does_not_mix_core_and_extension(self):
        self.register()
        for query in ('武梁祠', '画像'):
            self.assertGreater(library.search(self.db, query, None, collection='extension')['total'], 0)
            self.assertEqual(library.search(self.db, query, None, collection='core')['total'], 0)

    def test_reocr_replaces_legacy_text_and_preserves_human_edit(self):
        _, doc = self.register()
        library._store_page(self.db, doc, 2, {'blocks': [{'seq': 0, 'text': '重新识别的文段', 'bbox': [.1, .1, .8, .2], 'kind': 'text'}], 'figures': []}, 'ndl')
        self.db.expire_all()
        page = self.db.query(Page).filter_by(document_id=doc.id, page_no=2).one()
        self.assertEqual(len(page.segments), 1)
        segment = page.segments[0]
        library.patch_segment(self.db, segment, '人工校订保留内容', None, 'reviewed', '核对原页', 0)
        library._store_page(self.db, doc, 2, {'blocks': [{'seq': 0, 'text': '全新的段落', 'bbox': [.1, .6, .8, .8], 'kind': 'text'}], 'figures': []}, 'ndl')
        self.db.expire_all()
        self.assertEqual(self.db.get(Segment, segment.id).text_edit, '人工校订保留内容')

    def test_unified_database_migration_is_idempotent(self):
        engine = create_engine('sqlite://')
        with engine.begin() as db:
            db.execute(text('CREATE TABLE documents (id INTEGER PRIMARY KEY)'))
            db.execute(text('CREATE TABLE stones (id TEXT, code TEXT)'))
            db.execute(text('CREATE TABLE unified_migrations (id TEXT)'))
            db.execute(text('INSERT INTO documents VALUES (1)'))
        self.assertEqual(len(migrate(engine)), 2)
        self.assertEqual(migrate(engine), [])
        with engine.connect() as db:
            self.assertEqual(tuple(db.execute(text('SELECT collection,book_id FROM documents')).one()), ('core', ''))
        engine.dispose()

    def test_script_uses_bibliographic_type_not_year_alone(self):
        self.assertEqual(library._script_of({'category': '外文与综合', 'year': '1893'}), 'modern')
        self.assertEqual(library._script_of({'title': 'La sculpture sur pierre en Chine', 'category': '古籍与图录', 'year': '1893'}), 'modern')
        self.assertEqual(library._script_of({'kind': '古籍木板刷印分册', 'year': '1982'}), 'classical')


if __name__ == '__main__':
    unittest.main(verbosity=2)
