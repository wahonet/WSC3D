"""Read-only ranking regressions for story aliases; no embeddings or model calls."""
from pathlib import Path
import json
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from app.services import retrieval


class StorySearchTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(retrieval, 'ensure_index'))
        self.enterContext(patch.dict(retrieval._state, ready=False, dense_ready=False, dense_pending=False, dense_building=False))

    def test_guan_zhong_aliases_find_the_two_archives(self):
        for question in ['有多少石头上有管仲射小白的形象', '管仲射公子小白', '管仲箭射公子小白']:
            result = retrieval.search(question, 'stone')
            self.assertEqual({item['id'] for item in result['groups'][0]['items']}, {'武021', '武037'})
            self.assertEqual(result['groups'][0]['count'], 2)
            self.assertIsNone(result.get('aggregate'))
            for item in result['groups'][0]['items']:
                # The current corpus contains curated nodes as well as intros.
                # Both are discovery signals; neither may enter the identity card.
                self.assertIn(item['match_reason'], {'标注匹配', '档案简介匹配 · 待核对'})
                if item['match_reason'] == '标注匹配':
                    self.assertTrue(item['nodes'])
                self.assertNotIn('管仲', json.dumps(item['identity'], ensure_ascii=False))

    def test_jing_ke_keeps_three_and_pagination_does_not_change_count(self):
        result = retrieval.search('有多少石头上有荆轲刺秦王的形象', 'stone', 2)
        rest = retrieval.search('有多少石头上有荆轲刺秦王的形象', 'stone', 2, {'stone': 2})
        self.assertEqual(result['groups'][0]['count'], 3)
        self.assertEqual({s['id'] for s in result['groups'][0]['items'] + rest['groups'][0]['items']}, {'武011', '武023', '武037'})

    def test_canonical_candidates_work_before_being_imported_as_concepts(self):
        self.assertIn('管仲射小白', retrieval.keywords('有多少石头上有管仲射小白的形象'))
        self.assertIn('管仲箭射公子小白', retrieval.keywords('管仲射小白'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
