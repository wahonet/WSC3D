"""Pad UV borders by nearest photographed edge pixels; never alter copied originals."""
from pathlib import Path
import sys,json
import numpy as np
from PIL import Image
from scipy.ndimage import binary_fill_holes,distance_transform_edt
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT / 'resources/authoring/stone-reconstruction/que-texture-padding';OUT.mkdir(parents=True,exist_ok=True)
for id in ['QUE-W','QUE-E']:
 cfg=json.loads((source_path(f'resources/authoring/stone-reconstruction/{id}-mapping.json')).read_text(encoding='utf-8'))
 for d,s in cfg['sources'].items():
  im=Image.open(source_path(s['sourcePath'])).convert('RGB');a=np.asarray(im)
  mask=binary_fill_holes(np.max(a,axis=2)>18)
  indices=distance_transform_edt(~mask,return_distances=False,return_indices=True)
  padded=a[indices[0],indices[1]]
  Image.fromarray(padded).save(OUT/f'{id}-{d}.jpg',quality=95)
  print(id,d,flush=True)
