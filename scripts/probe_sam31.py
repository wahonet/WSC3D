# ASCII only. Run inside WSC3D venv python.
# Probe: can sam3.1_multiplex_fp16.safetensors feed the SAM3 *image* model?
import glob
import sys

ST = glob.glob(r"c:\Users\wahon\Desktop\20260831*\stonelab\ml\sam3.1\**\sam3*multiplex*.safetensors",
               recursive=True)
print("safetensors:", ST)
if not ST:
    sys.exit(1)

from safetensors import safe_open

with safe_open(ST[0], framework="pt", device="cpu") as f:
    keys = list(f.keys())
print("tensor count:", len(keys))

prefixes = {}
for k in keys:
    p = k.split(".", 1)[0]
    prefixes[p] = prefixes.get(p, 0) + 1
print("top-level prefixes:", prefixes)

det_keys = {k.replace("detector.", "") for k in keys if k.startswith("detector.")}
print("detector.* keys:", len(det_keys))

print("building image model arch (cpu, no checkpoint)...")
from sam3.model_builder import build_sam3_image_model

model = build_sam3_image_model(device="cpu", checkpoint_path=None, load_from_HF=False,
                               enable_segmentation=True)
msd = set(model.state_dict().keys())
print("image model params:", len(msd))

inter = msd & det_keys
print("match(detector-stripped vs model):", len(inter))
print("model keys missing from ckpt:", len(msd - det_keys))
print("ckpt detector keys unused:", len(det_keys - msd))
miss = sorted(msd - det_keys)[:8]
extra = sorted(det_keys - msd)[:8]
print("sample missing:", miss)
print("sample unused:", extra)
