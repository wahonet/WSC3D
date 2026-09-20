"""Build content-addressed web mip levels; archival source images stay untouched."""
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
THREE = ROOT / 'src/frontend/src/archive/three'
SOURCE = ROOT / 'resources/scenes/textures/stones'
DEST = SOURCE / 'levels'
DEST.mkdir(exist_ok=True)
entries = [e for name in ('stoneTextureManifest', 'stoneTextureManifestBL', 'stoneTextureManifestOutdoor', 'stoneTextureManifestXCL')
           for e in json.loads((THREE / (name + '.json')).read_text(encoding='utf-8'))['entries']]

def convert(name):
    raw = (SOURCE / name).read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    result = {'sourceSha256': sha, 'sourceBytes': len(raw)}
    with Image.open(SOURCE / name) as original:
        result['sourcePixels'] = original.width * original.height
        for tier, size, quality in [('preview', 512, 82), ('detail', 2048, 92)]:
            file = f'{sha[:20]}-{size}-q{quality}.webp'
            copy = original.copy()
            copy.thumbnail((size, size), Image.Resampling.LANCZOS)
            if not (DEST / file).exists():
                copy.save(DEST / file, 'WEBP', quality=quality, method=4)
            result[tier] = {'file': 'levels/' + file, 'width': copy.width, 'height': copy.height,
                            'bytes': (DEST / file).stat().st_size}
    return name, result

if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=4) as pool:
        files = dict(pool.map(convert, sorted({e['file'] for e in entries})))
    manifest = {'version': 1, 'files': files}
    (THREE / 'stoneTextureLevels.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(files), 'sourceMB': sum(v['sourceBytes'] for v in files.values()) / 1e6,
                      'previewMB': sum(v['preview']['bytes'] for v in files.values()) / 1e6,
                      'sourceMegapixels': sum(v['sourcePixels'] for v in files.values()) / 1e6,
                      'previewMegapixels': sum(v['preview']['width'] * v['preview']['height'] for v in files.values()) / 1e6}, indent=2))
