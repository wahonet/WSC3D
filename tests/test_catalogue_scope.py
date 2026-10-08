"""Research may include related objects without changing local-holdings counts."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from app.db import Base
from app.models import Stone
from app.services import catalogue
from app.routers import archive, stones


class CatalogueScopeTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.db.execute(text('CREATE TABLE extension_books (id TEXT PRIMARY KEY, payload JSON NOT NULL)'))
        self.db.add_all([
            Stone(id='武001', code='武001', name='本地石', dirname='local', archive={}),
            Stone(id='武151', code='武151', name='武荣碑', dirname='related', archive={'in_local_collection': False}),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_local_archive_and_research_have_explicit_scopes(self):
        self.assertEqual([s['id'] for s in archive.stones(db=self.db)], ['武001'])
        self.assertEqual([s['id'] for s in archive.stones(include_related=True, db=self.db)], ['武001', '武151'])
        self.assertEqual([s.id for s in stones.list_stones(db=self.db)], ['武001', '武151'])
        related = archive.detail('武151', db=self.db)
        self.assertIs(related['in_local_collection'], False)

    def test_statistics_do_not_count_related_objects_as_local(self):
        stats = catalogue.statistics(self.db)
        self.assertEqual(stats['total'], 1)
        self.assertEqual(stats['research_total'], 2)
        self.assertEqual(stats['related_objects'], 1)
        self.assertEqual(sum(stats['by_location'].values()), 1)


if __name__ == '__main__':
    unittest.main()
