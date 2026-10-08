"""A side face can localize its own versions without inheriting front-face labels."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/research'))
from multiversion_frames import reviewed_frames
from app.services import transforms as tf


def asset(key):
    return {'id': key, 'stone_id': '武033', 'width': 100, 'height': 80,
            'sha256': str(key)*64}


def pair(key, left, right, transform, local=False, accepted=True):
    return {'id': key, 'tool': 'align', 'asset_id': left, 'stone_id': '武033',
            'geometry': {**transform, 'target_asset_id': right, 'local_only': local,
                         'research_run': 'multiversion-20261002',
                         'source_sha256': [asset(left)['sha256'], asset(right)['sha256']],
                         'visual_review': {'decision': 'accepted' if accepted else 'pending'}}}


class FaceLocatorTests(unittest.TestCase):
    def test_front_side_remain_separate_despite_whole_stone_photo(self):
        assets = {key: asset(key) for key in range(1, 7)}
        rows = [pair(11, 1, 2, tf.identity()), pair(12, 3, 4, tf.identity()),
                pair(13, 3, 5, tf.identity(), local=True),
                pair(14, 1, 6, tf.identity(), accepted=False)]
        frames = reviewed_frames(assets, rows, {1: 10, 3: 9})
        self.assertEqual([set(f['to_reference']) for f in frames], [{1, 2}, {3, 4}, {5}, {6}])
        self.assertEqual(frames[1]['alignment_paths'][4], [12])

    def test_reverse_and_projective_multi_hop_pixel_mapping(self):
        h = tf.homography([[1.2, .04, 3], [.01, 1.1, 4], [.0005, .0002, 1]])
        sim = {'s': 2, 'theta_deg': 0, 'tx': 5, 'ty': 7}
        rows = [pair(20, 2, 1, sim), pair(21, 2, 3, h)]
        frame = reviewed_frames({i: asset(i) for i in (1, 2, 3)}, rows, {1: 10})[0]
        point = tf.apply(frame['to_reference'][3], 33, 44)
        expected = tf.apply(tf.invert(sim), *tf.apply(h, 33, 44))
        self.assertAlmostEqual(point[0], expected[0])
        self.assertAlmostEqual(point[1], expected[1])
        self.assertEqual(frame['alignment_paths'][3], [20, 21])

    def test_changed_original_and_cross_stone_pair_fail(self):
        assets = {1: asset(1), 2: asset(2)}
        rows = [pair(30, 1, 2, tf.identity())]
        assets[2]['sha256'] = 'changed'
        with self.assertRaises(ValueError):
            reviewed_frames(assets, rows)
        assets[2] = {**asset(2), 'stone_id': '武034'}
        with self.assertRaises(ValueError):
            reviewed_frames(assets, rows)


if __name__ == '__main__':
    unittest.main()
