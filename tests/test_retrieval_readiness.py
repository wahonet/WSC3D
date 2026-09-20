"""Index preparation must never call a model with incomplete evidence."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from app.services import retrieval


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        for mocker in [
            patch.dict(retrieval._state, ready=True, building=False, error='',
                       dense_ready=False, dense_building=False, dense_pending=False, dense_error=''),
        ]:
            mocker.start()
            self.addCleanup(mocker.stop)
        self.empty = {'dense': False, 'groups': [], 'source_version': 'current'}
        self.search = self.enterContext(patch.object(retrieval, 'search', return_value=self.empty))
        self.wait = self.enterContext(patch.object(retrieval._dense_complete, 'wait', return_value=False))
        self.gateway = self.enterContext(patch.object(retrieval.model_gateway, 'answer', return_value={'route': 'online', 'answer': '有据可查[1]'}))

    def test_long_vector_build_returns_pending_without_calling_model(self):
        retrieval._state['dense_building'] = True
        result = retrieval.ask('画像中的人物')
        self.assertEqual(result['route'], 'retrieval_pending')
        self.wait.assert_called_once_with(timeout=2)
        self.gateway.assert_not_called()

    def test_text_index_build_is_also_pending(self):
        retrieval._state.update(ready=False, building=True)
        self.assertEqual(retrieval.ask('画像中的人物')['route'], 'retrieval_pending')
        self.gateway.assert_not_called()

    def test_failed_build_is_not_retried_as_success(self):
        retrieval._state.update(dense_building=True, dense_error='model missing')
        self.assertEqual(retrieval.ask('画像中的人物')['route'], 'retrieval_unavailable')
        self.gateway.assert_not_called()

    def test_ready_index_with_no_evidence_does_not_invent_answer(self):
        self.search.return_value = {**self.empty, 'dense': True}
        self.assertEqual(retrieval.ask('无关问题')['route'], 'evidence_only')
        self.gateway.assert_not_called()

    def test_cached_vectors_becoming_ready_continue_the_same_question(self):
        retrieval._state['dense_ready'] = True
        self.search.side_effect = [self.empty, {**self.empty, 'dense': True, 'groups': [
            {'scope': 'core', 'items': [{'scope': 'core', 'kind': 'segment', 'title': '文献',
             'text': '已校订文段', 'page_no': 12, 'document_id': 1, 'retrieval_methods': ['vector']}]}]}]
        result = retrieval.ask('画像中的人物')
        self.assertEqual(result['route'], 'online')
        self.assertTrue(result['retrieval']['dense'])
        self.assertEqual(result['citations'][0]['page_no'], 12)
        self.gateway.assert_called_once()

    def test_cached_index_warms_encoder_before_declaring_it_ready(self):
        import numpy as np
        with TemporaryDirectory(prefix='wsc-readiness-') as directory:
            vectors = Path(directory) / 'vectors.npz'
            np.savez(vectors, matrix=np.ones((1, 1024), dtype=np.float32),
                     ids=np.array([1]), scopes=np.array(['core']), version='current:bge-m3:1024:v1')
            with patch.object(retrieval, 'VECTORS', vectors), patch.object(retrieval, '_dense', None), \
                 patch.object(retrieval, 'ensure_index'), patch.object(retrieval, 'model') as encoder:
                retrieval._state['source_version'] = 'current'
                encoder.side_effect = lambda: self.assertFalse(retrieval._state['dense_ready'])
                retrieval.build_dense()
                encoder.assert_called_once()
                self.assertTrue(retrieval._state['dense_ready'])
                self.assertEqual(retrieval._state['dense_n'], 1)

    def test_bm25_matches_short_objects_and_contiguous_chinese_names(self):
        import sqlite3
        from app.services import hybrid_rank
        with sqlite3.connect(':memory:') as db:
            db.execute("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='unicode61')")
            db.executemany('INSERT INTO docs VALUES(?)', [(hybrid_rank.index_text(value),) for value in
                          ['荆轲执匕首而秦王拔剑。', '伏羲执规而女娲执矩。', '云纹。']])
            for query, expected in [('匕首', [1]), ('剑', [1]), ('规', [2]), ('女娲', [2])]:
                ids = [row[0] for row in db.execute('SELECT rowid FROM docs WHERE docs MATCH ?',
                       (hybrid_rank.query_expression([query]),))]
                self.assertEqual(ids, expected, query)


if __name__ == '__main__':
    unittest.main()
