"""Check real region export and saved annotation-to-book context without AI calls."""
from io import BytesIO
import json
import unittest
from datetime import datetime, timedelta

from video_fixtures import SourceFixture, sources, Image
from app.models import Annotation


class VideoSourcesTests(SourceFixture, unittest.TestCase):
    def setUp(self):
        self.setup_sources()

    def image(self, data):
        return Image.open(BytesIO((sources.source_dir(data['id']) / 'base.jpg').read_bytes()))

    def test_polygon_exports_exact_region_and_masks_background(self):
        data = self.prepare()
        self.assertEqual(data['pixel_box'], [80, 80, 400, 400])
        with self.image(data) as image:
            self.assertLess(image.getpixel((20, 20))[0], 70)
            self.assertGreater(min(image.getpixel((290, 290))), 248)
        self.assertEqual(self.image_path.read_bytes(), self.original_bytes)
        self.assertEqual(self.figure.review_status, 'candidate')

    def test_ellipse_and_multiple_shapes_keep_positions_within_union(self):
        data = self.prepare([11, 13])
        self.assertEqual(data['pixel_box'], [80, 80, 640, 640])
        with self.image(data) as image:
            self.assertLess(image.getpixel((20, 20))[0], 70)
            self.assertLess(image.getpixel((480, 480))[0], 70)
            self.assertGreater(min(image.getpixel((280, 280))), 248)

    def test_all_supported_regions_and_candidates_are_in_catalogue(self):
        nodes = sources.catalogue(self.db)[0]['assets'][0]['annotations']
        self.assertEqual([node['id'] for node in nodes], [11, 12, 13])

    def test_browse_is_live_searchable_and_excludes_non_image_annotations(self):
        self.assertEqual(sources.browse(self.db, q='琴')['items'][0]['id'], 11)
        self.assertEqual(sources.browse(self.db, q='试验石 抚琴')['total'], 1)
        self.assertEqual(sources.browse(self.db, q='#12')['items'][0]['id'], 12)
        self.assertEqual(sources.browse(self.db, q='%')['total'], 0)
        self.figure.label = '刚刚标注的乐人'
        self.figure.review_status = 'reviewed'
        self.figure.updated_at = datetime.now() + timedelta(seconds=10)
        self.db.commit()
        result = sources.browse(self.db, q='刚刚标注')
        self.assertEqual(result['items'][0]['label'], '刚刚标注的乐人')
        self.assertNotIn('geometry', result['items'][0])
        self.assertEqual(sources.browse(self.db)['items'][0]['id'], 11)
        self.figure.review_status = 'rejected'
        self.ellipse.geometry = {}
        self.db.commit()
        self.assertEqual({n['id'] for n in sources.browse(self.db)['items']}, {12, 14})
        groups = sources.source_groups(self.db)
        self.assertEqual([a['count'] for a in groups[0]['assets']], [1, 1])
        self.asset.missing = True
        self.db.commit()
        self.assertEqual([n['id'] for n in sources.browse(self.db)['items']], [14])

    def test_ten_thousand_annotations_are_paged_without_geometry_payloads(self):
        self.db.bulk_insert_mappings(Annotation, [dict(stone_id='T001', asset_id=1, tool='annotate',
            atype='rect', geometry={'x': .1, 'y': .1, 'w': .2, 'h': .2}, label=f'新标注 {i}',
            review_status='reviewed') for i in range(10000)])
        self.db.commit()
        first = sources.browse(self.db, q='新标注', limit=24)
        second = sources.browse(self.db, q='新标注', offset=24, limit=24)
        self.assertEqual(first['total'], 10000)
        self.assertEqual(len(first['items']), 24)
        self.assertFalse({n['id'] for n in first['items']} & {n['id'] for n in second['items']})
        self.assertLess(len(json.dumps(first, default=str)), 18000)
        self.assertEqual(sources.browse(self.db, ids=[11, 14])['total'], 2)
        self.assertEqual(sources.browse(self.db, asset_id=2)['total'], 1)

    def test_prompt_uses_selected_concepts_semantics_ancestor_story_and_book(self):
        data = self.prepare()
        for value in ['抚琴者', '概念：琴', '一人席地抚琴', '宴饮中的奏乐场景', '乐人跽坐，双手拨弦', '画像研究试验册，第 7 页', '二维剪纸']:
            self.assertIn(value, data['prompt'])
        self.assertEqual(data['source']['annotation_ids'], [11])
        self.assertEqual([n['id'] for n in data['source']['annotations']], [11, 10])
        self.assertFalse(data['source']['references'][0]['source_missing'])

    def test_document_identity_changes_exclude_old_reference_from_prompt(self):
        self.page.reference_identity = 'replacement-page'
        self.db.commit()
        data = self.prepare()
        self.assertTrue(data['source']['references'][0]['source_missing'])
        self.assertNotIn('乐人跽坐，双手拨弦', data['prompt'])

    def test_machine_label_is_not_used_as_a_subject_in_the_prompt(self):
        self.figure.label = 'sam3.1:person'
        self.db.commit()
        data = self.prepare()
        self.assertEqual(data['title'], '区域 11')
        self.assertNotIn('sam3.1', data['prompt'])
        self.assertEqual(data['source']['annotations'][0]['label'], 'sam3.1:person')

    def test_user_selected_excerpt_is_used_instead_of_whole_paragraph(self):
        text = self.reference.text
        self.reference.excerpts = [{'field': 'iconographic', 'start': 0, 'end': 5, 'text': text[:5]}]
        self.parent.semantics = {'iconographic': text[:5]}
        self.db.commit()
        data = self.prepare()
        self.assertIn(text[:5], data['prompt'])
        self.assertNotIn('双手拨弦', data['prompt'])

    def test_table_reference_excludes_unrelated_rows(self):
        self.reference.text = '<table><tr><td>宴饮场景</td><td>两人奏乐</td></tr><tr><td>渔猎</td><td>张网捕鱼</td></tr></table>'
        self.db.commit()
        data = self.prepare()
        self.assertIn('两人奏乐', data['prompt'])
        self.assertNotIn('张网捕鱼', data['prompt'])

    def test_reviewed_children_are_material_candidate_children_are_not_added(self):
        self.figure.parent_id = 12
        self.figure.review_status = 'reviewed'
        self.ellipse.parent_id = 12
        self.db.commit()
        data = self.prepare([12])
        self.assertIn('抚琴者', data['prompt'])
        self.assertNotIn('圆盘', data['prompt'])

    def test_prepare_is_stable_but_later_edits_make_new_snapshot(self):
        first = self.prepare()
        self.assertEqual(self.prepare()['id'], first['id'])
        self.figure.label = '另一名称'
        self.db.commit()
        second = self.prepare()
        self.assertNotEqual(second['id'], first['id'])
        self.assertEqual(sources.load(first['id'])['title'], '抚琴者')

    def test_tampered_image_or_metadata_is_not_accepted(self):
        data = self.prepare()
        path = sources.source_dir(data['id']) / 'source.json'
        value = json.loads(path.read_text('utf-8'))
        value['options']['mode'] = 'multimodal'
        path.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '失效'):
            sources.load(data['id'])
        path.write_text(json.dumps(data), encoding='utf-8')
        (path.parent / 'base.jpg').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, '失效'):
            sources.load(data['id'])

    def test_cross_image_missing_rejected_and_invalid_regions_are_rejected(self):
        for ids in ([11, 14], [10], [999]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                self.prepare(ids)
        self.figure.review_status = 'rejected'
        self.db.commit()
        with self.assertRaises(ValueError):
            self.prepare()
        self.figure.review_status = 'reviewed'
        self.figure.geometry = {'points': [[0, 0], [1.1, .5], [.3, .4]]}
        self.db.commit()
        with self.assertRaisesRegex(ValueError, '范围无效'):
            self.prepare()

    def test_source_dimensions_are_checked_before_crop(self):
        self.asset.width = 900
        self.db.commit()
        with self.assertRaisesRegex(ValueError, '尺寸已变化'):
            self.prepare()

    def test_padding_meets_vendor_aspect_and_minimum_size(self):
        self.scene.geometry = {'x': .1, 'y': .1, 'w': .6, 'h': .02}
        self.db.commit()
        data = self.prepare([12])
        self.assertGreaterEqual(min(data['width'], data['height']), 256)
        self.assertLessEqual(data['width'] / data['height'], 2.5)


if __name__ == '__main__':
    unittest.main()
