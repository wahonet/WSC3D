# ASCII only. Functional probe: load sam3.1 multiplex fp16 detector weights into
# the SAM3 image model and run a real text-prompt inference. Compare with sam3.
import glob
import sys
import time

ST = glob.glob(r"c:\Users\wahon\Desktop\20260831*\stonelab\ml\sam3.1\**\sam3*multiplex*.safetensors",
               recursive=True)[0]
IMG = glob.glob(r"c:\Users\wahon\Desktop\20260831*\stonelab\server\data\previews\*.jpg")
print("weights:", ST)

import torch
from PIL import Image
from safetensors.torch import load_file
from sam3.model_builder import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor

dev = "cuda" if torch.cuda.is_available() else "cpu"
print("device:", dev)

t0 = time.time()
model = build_sam3_image_model(device="cpu", checkpoint_path=None, load_from_HF=False,
                               enable_segmentation=True)
sd = load_file(ST)
det = {k.replace("detector.", "", 1): v.float() for k, v in sd.items() if k.startswith("detector.")}
missing, unexpected = model.load_state_dict(det, strict=False)
print(f"load_state_dict: missing={len(missing)} unexpected={len(unexpected)}  ({time.time()-t0:.0f}s)")
print("missing full list:")
for k in missing:
    print("   ", k)

# text_projection check: is it under another name in ckpt?
tp = [k for k in sd.keys() if "text_projection" in k]
print("ckpt text_projection keys:", tp)

model = model.to(dev).eval()
proc = Sam3Processor(model)

# pick the biggest preview (the emperor part image used in earlier test)
img_path = max(IMG, key=lambda p: len(p))
print("image:", img_path)
pil = Image.open(img_path).convert("RGB")

t0 = time.time()
with torch.autocast(device_type="cuda", dtype=torch.bfloat16) if dev == "cuda" else torch.no_grad():
    state = proc.set_image(pil)
    out = proc.set_text_prompt(state=state, prompt="person")
dt = time.time() - t0

scores = out.get("scores")
if scores is not None and hasattr(scores, "detach"):
    s = scores.detach().float().cpu().numpy().ravel().tolist()
else:
    s = list(scores) if scores is not None else []
s = sorted([round(float(x), 3) for x in s], reverse=True)
print(f"sam3.1-image infer ok in {dt:.1f}s, detections={len(s)}, scores={s[:8]}")
