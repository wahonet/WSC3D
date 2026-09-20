"""Check relocated model paths, including a still-accessible old installation."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from app.portable_models import mineru_config, write_mineru_config


class PortableModelTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='模型 迁移-')
        self.root = Path(self.temporary.name)
        self.old = self.root / 'old/mineru-models'
        self.new = self.root / '新位置/models/mineru'
        for root in (self.old, self.new):
            for engine in ('pipeline', 'vlm'):
                (root / engine).mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def save(self, paths):
        data = {'models-dir': paths, 'custom-option': {'keep': True}}
        (self.new / 'mineru.json').write_text(json.dumps(data), encoding='utf-8')

    def test_relative_models_do_not_follow_current_working_directory(self):
        self.save({'pipeline': 'pipeline', 'vlm': 'vlm'})
        resolved = mineru_config(self.new)
        self.assertEqual(resolved['models-dir'], {key: str(self.new / key) for key in ('pipeline', 'vlm')})
        self.assertEqual(resolved['custom-option'], {'keep': True})

    def test_old_accessible_bundle_is_rebased(self):
        self.save({key: str(self.old / key) for key in ('pipeline', 'vlm')})
        resolved = mineru_config(self.new)
        self.assertTrue(all(Path(path).is_relative_to(self.new) for path in resolved['models-dir'].values()))

    def test_custom_external_path_is_preserved(self):
        custom = self.root / 'custom-pipeline'
        custom.mkdir()
        self.save({'pipeline': str(custom), 'vlm': 'vlm'})
        self.assertEqual(mineru_config(self.new)['models-dir']['pipeline'], str(custom))

    def test_missing_models_fail_before_library_download_fallback(self):
        self.save({'pipeline': 'absent', 'vlm': 'vlm'})
        with self.assertRaises(FileNotFoundError):
            mineru_config(self.new)

    def test_resolved_config_does_not_rewrite_bundled_template(self):
        self.save({'pipeline': 'pipeline', 'vlm': 'vlm'})
        before = (self.new / 'mineru.json').read_bytes()
        target = write_mineru_config(self.new, self.root / 'worker/mineru.json')
        self.assertEqual((self.new / 'mineru.json').read_bytes(), before)
        self.assertTrue(all(Path(p).is_absolute() for p in json.loads(target.read_text())['models-dir'].values()))


if __name__ == '__main__':
    unittest.main()
