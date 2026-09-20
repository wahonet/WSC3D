"""Package reviewed, already identified source images for stone-face mapping.

Sources stay byte-for-byte unchanged. Only display copies are WebP encoded;
no crop, rotation, reconstruction, contrast or geometry alteration is baked.
The reviewed source-pixel crop becomes a UV transform in Three and Blender.
"""
import hashlib
import json
from pathlib import Path
from PIL import Image

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
TASK = ROOT / 'resources/authoring/scene-textures'


def main():
    source = json.loads((TASK / 'texture-candidates.json').read_text(encoding='utf-8'))
    dest = ROOT / 'resources/scenes/textures/stones'
    dest.mkdir(parents=True, exist_ok=True)
    entries = []
    source_bytes = output_bytes = 0
    for item in source['entries']:
        if not item.get('approved'):
            continue
        path = (source_path(item['source'])).resolve()
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item['sourceSha256'], path
        number = int(item['id'].split(' ', 1)[0])
        file = f'stone-{number:02d}.webp'
        with Image.open(path) as im:
            assert list(im.size) == item['sourceImageSize']
            im.convert('RGB').save(dest / file, 'WEBP', quality=94, method=6)
        entry = {
            'id': item['id'], 'file': file, 'crop': item['crop'],
            'imageSize': item['sourceImageSize'], 'normal': item['normal'],
            'sourceKind': item['sourceKind'], 'sourcePath': item['source'],
            'sourceSha256': item['sourceSha256'], 'mappingEvidence': item['mappingEvidence'],
            'fit': 'contain' if number == 39 else 'face',
        }
        entries.append(entry)
        source_bytes += len(raw)
        output_bytes += (dest / file).stat().st_size
    manifest = {'version': 1, 'description': '已核验具名石刻的扫描正面影像；背面、多面透视、未确定占位不纳入',
                'imageTreatment': 'WebP display encoding, no image reconstruction or alteration; crop is UV only',
                'entries': entries, 'excluded': source.get('excluded', [])}
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    (ROOT / 'src/frontend/src/archive/three/stoneTextureManifest.json').write_text(text, encoding='utf-8')
    (TASK / 'stoneTextureManifest.json').write_text(text, encoding='utf-8')
    print(json.dumps({'count': len(entries), 'sourceBytes': source_bytes, 'displayBytes': output_bytes}, ensure_ascii=False))


if __name__ == '__main__':
    main()
