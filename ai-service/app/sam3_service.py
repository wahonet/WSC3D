"""
SAM3 concept segmentation service.

SAM3 is much heavier than MobileSAM and may need gated Hugging Face weights or a
local checkpoint, so this module is loaded lazily on the first /ai/sam3 request.
MobileSAM remains the interactive point/box default at /ai/sam.
"""

from __future__ import annotations

import os
import threading
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
from PIL import Image

from .resources import load_image_from_uri, load_source_image
from .utils import contour_to_polygon, decode_image

_MODEL_NAME = "sam3"
_SERVICE_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_SAM3_CHECKPOINT = _SERVICE_ROOT / "weights" / "sam3" / "sam3.pt"
_DEFAULT_HF_HUB_CACHE = _SERVICE_ROOT / "weights" / "huggingface" / "hub"
_model_lock = threading.Lock()
_model: Optional[Any] = None
_processor: Optional[Any] = None
_load_status: dict[str, Any] = {
    "ready": False,
    "status": "pending",
    "model": _MODEL_NAME,
    "detail": "",
}


def get_status() -> dict[str, Any]:
    return dict(_load_status)


def _set_status(status: str, detail: str = "") -> None:
    _load_status["ready"] = status == "ready"
    _load_status["status"] = status
    _load_status["detail"] = detail
    print(f"[SAM3] status={status} detail={detail}", flush=True)


def _device() -> str:
    configured = os.environ.get("WSC3D_SAM3_DEVICE")
    if configured:
        return configured
    try:
        import torch

        # On Windows it is possible to have CUDA probes or env state that make
        # downstream code try `.cuda()` even when this PyTorch build has no CUDA
        # runtime. Guard on both signals and default to CPU unless CUDA is truly
        # compiled in and visible.
        has_cuda_build = bool(getattr(torch.version, "cuda", None))
        return "cuda" if has_cuda_build and torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001
        return "cpu"


def _checkpoint_path() -> Optional[Path]:
    configured = os.environ.get("WSC3D_SAM3_CHECKPOINT")
    if configured:
        return Path(configured).expanduser()
    if _DEFAULT_SAM3_CHECKPOINT.exists():
        return _DEFAULT_SAM3_CHECKPOINT
    return None


def _bpe_path() -> Optional[Path]:
    try:
        import sam3 as sam3_pkg  # type: ignore

        path = Path(sam3_pkg.__file__).resolve().parent / "assets" / "bpe_simple_vocab_16e6.txt.gz"
        return path if path.exists() else None
    except Exception:  # noqa: BLE001
        return None


def _prepare_hf_env() -> None:
    os.environ.setdefault("HF_HUB_CACHE", str(_DEFAULT_HF_HUB_CACHE))
    endpoint = os.environ.get("WSC3D_SAM3_HF_ENDPOINT")
    if endpoint:
        os.environ.setdefault("HF_ENDPOINT", endpoint)


def _has_hf_token() -> bool:
    if os.environ.get("HF_TOKEN"):
        return True
    try:
        from huggingface_hub import get_token  # type: ignore

        return bool(get_token())
    except Exception:  # noqa: BLE001
        return False


def _missing_checkpoint_detail() -> str:
    return (
        "SAM3 checkpoint is not available locally and facebook/sam3 requires Hugging Face access. "
        "Put sam3.pt at "
        f"{_DEFAULT_SAM3_CHECKPOINT}, or approve facebook/sam3 on Hugging Face and run "
        "`ai-service\\.venv\\Scripts\\hf.exe auth login` before retrying."
    )


def _inference_context():
    try:
        import torch

        device = _device()
        if device.startswith("cuda") and torch.cuda.is_available():
            return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    except Exception:  # noqa: BLE001
        pass
    return nullcontext()


def _load_model() -> tuple[Optional[Any], Optional[Any]]:
    global _model, _processor
    if _model is not None and _processor is not None:
        return _model, _processor

    with _model_lock:
        if _model is not None and _processor is not None:
            return _model, _processor
        _set_status("loading", "loading SAM3 model")
        try:
            _prepare_hf_env()
            from sam3.model.sam3_image_processor import Sam3Processor  # type: ignore
            from sam3.model_builder import build_sam3_image_model  # type: ignore

            checkpoint_path = _checkpoint_path()
            load_from_hf = checkpoint_path is None or not checkpoint_path.exists()
            if load_from_hf and not _has_hf_token():
                raise RuntimeError(_missing_checkpoint_detail())
            device = _device()
            bpe_path = _bpe_path()
            _model = build_sam3_image_model(
                bpe_path=str(bpe_path) if bpe_path else None,
                device=device,
                checkpoint_path=str(checkpoint_path) if checkpoint_path and checkpoint_path.exists() else None,
                load_from_HF=load_from_hf,
                enable_segmentation=True,
            )
            _processor = Sam3Processor(_model)
            source = "Hugging Face" if load_from_hf else str(checkpoint_path)
            _set_status("ready", f"{_MODEL_NAME} loaded from {source} on {device}")
        except Exception as exc:  # noqa: BLE001
            _model = None
            _processor = None
            detail = f"{type(exc).__name__}: {exc}"
            if (
                "Access denied" in detail
                or "requires approval" in detail
                or "401" in detail
                or "403" in detail
                or "LocalEntryNotFoundError" in detail
            ):
                detail += (
                    f"; facebook/sam3 is gated. Accept access on Hugging Face and run `hf auth login`, "
                    f"or place sam3.pt at {_DEFAULT_SAM3_CHECKPOINT}."
                )
            if "CUDA" in detail or "cuda" in detail:
                detail += (
                    "; install a CUDA PyTorch wheel, or set WSC3D_SAM3_DEVICE=cpu "
                    "and restart ai-service."
                )
            _set_status("error", detail)
    return _model, _processor


def sam3_segment(
    *,
    text_prompt: str,
    stone_id: str | None = None,
    image_uri: str | None = None,
    image_base64: str | None = None,
    threshold: float = 0.5,
    max_results: int = 20,
) -> dict:
    prompt = text_prompt.strip()
    if not prompt:
        return {
            "error": "text-prompt-required",
            "polygons": [],
            "detections": [],
            "confidence": 0.0,
            "model": _MODEL_NAME,
        }

    loaded = _load_input_image(stone_id=stone_id, image_uri=image_uri, image_base64=image_base64)
    if loaded is None:
        return {
            "error": "imageUri_or_stoneId_or_imageBase64_required_or_not_found",
            "polygons": [],
            "detections": [],
            "confidence": 0.0,
            "model": _MODEL_NAME,
        }
    image, name, source_mode = loaded

    model, processor = _load_model()
    if model is None or processor is None:
        return {
            "error": "sam3-unavailable",
            "detail": _load_status.get("detail", ""),
            "polygons": [],
            "detections": [],
            "confidence": 0.0,
            "model": _MODEL_NAME,
        }

    try:
        pil_image = Image.fromarray(image)
        with _inference_context():
            state = processor.set_image(pil_image)
            output = processor.set_text_prompt(state=state, prompt=prompt)
    except Exception as exc:  # noqa: BLE001
        return {
            "error": "sam3-inference-failed",
            "detail": f"{type(exc).__name__}: {exc}",
            "polygons": [],
            "detections": [],
            "confidence": 0.0,
            "model": _MODEL_NAME,
        }

    height, width = image.shape[:2]
    detections = _detections_from_output(output, width, height, threshold, max_results)
    return {
        "polygons": [item["polygon"] for item in detections],
        "detections": detections,
        "confidence": detections[0]["score"] if detections else 0.0,
        "model": _MODEL_NAME,
        "textPrompt": prompt,
        "sourceMode": source_mode,
        "sourceImage": name,
        "sourceSize": [width, height],
        "coordinateSystem": "image-uv" if source_mode == "resource-uri" else "modelbox-uv",
    }


def _load_input_image(
    *,
    stone_id: str | None,
    image_uri: str | None,
    image_base64: str | None,
) -> Optional[tuple[np.ndarray, str, str]]:
    if image_uri:
        loaded = load_image_from_uri(image_uri)
        if loaded is None:
            return None
        image, name = loaded
        return image, name, "resource-uri"
    if stone_id:
        loaded = load_source_image(stone_id)
        if loaded is None:
            return None
        image, name = loaded
        return image, name, "source"
    if image_base64:
        image = decode_image(image_base64)
        return image, "screenshot", "screenshot"
    return None


def _detections_from_output(
    output: dict,
    width: int,
    height: int,
    threshold: float,
    max_results: int,
) -> list[dict]:
    masks = _to_numpy(output.get("masks"))
    boxes = _to_numpy(output.get("boxes"))
    scores = _to_numpy(output.get("scores"))
    if masks is None:
        return []

    masks = np.asarray(masks)
    if masks.ndim == 4:
        masks = np.squeeze(masks, axis=1) if masks.shape[1] == 1 else masks[:, 0, :, :]
    if masks.ndim == 2:
        masks = masks[None, :, :]

    detections: list[dict] = []
    safe_threshold = max(0.0, min(float(threshold), 1.0))
    safe_max = max(1, min(int(max_results), 100))

    for idx, mask in enumerate(masks):
        score = float(np.ravel(scores)[idx]) if scores is not None and np.ravel(scores).size > idx else 1.0
        if score < safe_threshold:
            continue
        polygon = _mask_to_polygon(mask, width, height)
        if not polygon:
            continue
        box = _box_for_index(boxes, idx)
        detections.append({
            "polygon": polygon,
            "bbox": box,
            "score": score,
        })

    detections.sort(key=lambda item: item["score"], reverse=True)
    return detections[:safe_max]


def _to_numpy(value: Any) -> Optional[np.ndarray]:
    if value is None:
        return None
    if hasattr(value, "detach"):
        tensor = value.detach().cpu()
        if str(getattr(tensor, "dtype", "")) == "torch.bfloat16":
            tensor = tensor.float()
        return tensor.numpy()
    if hasattr(value, "cpu"):
        tensor = value.cpu()
        if str(getattr(tensor, "dtype", "")) == "torch.bfloat16":
            tensor = tensor.float()
        return tensor.numpy()
    return np.asarray(value)


def _mask_to_polygon(mask: np.ndarray, width: int, height: int) -> list[list[float]]:
    mask_uint8 = (np.asarray(mask) > 0.5).astype(np.uint8) * 255
    contours, _ = cv2.findContours(mask_uint8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 4:
        return []
    return contour_to_polygon(contour, width, height)


def _box_for_index(boxes: Optional[np.ndarray], idx: int) -> list[float] | None:
    if boxes is None:
        return None
    flat = np.asarray(boxes).reshape(-1, 4)
    if flat.shape[0] <= idx:
        return None
    return [float(value) for value in flat[idx].tolist()]
