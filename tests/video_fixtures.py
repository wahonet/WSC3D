"""An isolated annotated image and book, never the user's research database."""
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.db import Base
from app.models import Annotation, Asset, Concept, AnnotationConcept, Document, Page, Segment, Stone
from app.schemas import AnnotationReferenceCreate
from app.services import references, video_sources as sources


class SourceFixture:
    def setup_sources(self):
        self.root = Path(self.enterContext(TemporaryDirectory(prefix='wsc-video-test-'))).resolve()
        config = replace(sources.settings, assets_root=self.root / 'stones', cache_dir=self.root / 'cache',
                         resources_dir=self.root / 'resources', data_dir=self.root / 'data')
        self.enterContext(patch.object(sources, 'settings', config))
        config.assets_root.mkdir()
        self.image_path = config.assets_root / 'base.png'
        Image.new('RGB', (800, 800), '#255580').save(self.image_path)
        self.original_bytes = self.image_path.read_bytes()
        self.enterContext(patch.object(sources.resources, 'asset_path', return_value=self.image_path))
        engine = create_engine('sqlite:///' + str(self.root / 'test.db'), connect_args={'check_same_thread': False})
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        self.db = self.enterContext(Session(engine, expire_on_commit=False))
        self.stone = Stone(id='T001', code='T001', name='试验石', dirname='trial')
        self.asset = Asset(id=1, stone_id='T001', kind='rubbing', filename='base.png', relpath='base.png', width=800, height=800)
        self.db.add_all([self.stone, self.asset, Asset(id=2, stone_id='T001', kind='rubbing', filename='other.png', relpath='other.png', width=800, height=800)])
        self.parent = Annotation(id=10, stone_id='T001', asset_id=1, tool='annotate', atype='none', geometry={}, label='宴饮场景', review_status='reviewed', semantics={'iconographic': '宴饮中的奏乐场景。'})
        self.figure = Annotation(id=11, stone_id='T001', asset_id=1, tool='segment', atype='polygon', geometry={'points': [[.1, .1], [.5, .1], [.1, .5]]}, label='抚琴者', parent_id=10, review_status='candidate', semantics={'pre_iconographic': '一人席地抚琴。'})
        self.scene = Annotation(id=12, stone_id='T001', asset_id=1, tool='annotate', atype='rect', geometry={'x': .1, 'y': .1, 'w': .6, 'h': .6}, label='宴饮全景', review_status='reviewed')
        self.ellipse = Annotation(id=13, stone_id='T001', asset_id=1, tool='annotate', atype='ellipse', geometry={'cx': .7, 'cy': .7, 'rx': .1, 'ry': .1}, label='圆盘', review_status='candidate')
        self.other = Annotation(id=14, stone_id='T001', asset_id=2, tool='annotate', atype='rect', geometry={'x': 0, 'y': 0, 'w': .2, 'h': .2}, label='另一底图', review_status='reviewed')
        self.db.add_all([self.parent, self.figure, self.scene, self.ellipse, self.other])
        concept = Concept(name='琴', category_id='')
        self.figure.concept_links.append(AnnotationConcept(concept=concept))
        self.doc = Document(id=1, code='TEST-BOOK', title='画像研究试验册', relpath='test.pdf')
        self.page = Page(id=1, document_id=1, page_no=7)
        self.segment = Segment(id=1, document_id=1, page_id=1, seq=1, text='乐人跽坐，双手拨弦。')
        self.db.add_all([self.doc, self.page, self.segment])
        self.db.flush()
        self.reference = references.add_reference(self.db, self.parent, AnnotationReferenceCreate(kind='segment', segment_id=1))
        self.db.commit()
        return config

    def prepare(self, ids=None, **options):
        return sources.prepare(self.db, sources.PrepareRequest(annotation_ids=ids or [11], **options))
