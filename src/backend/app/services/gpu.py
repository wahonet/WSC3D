"""Serialize local GPU users and release idle weights before changing engines."""
from contextlib import contextmanager
import json
import threading
from urllib.request import Request, urlopen

_lock = threading.RLock()

def release_ollama():
    from .model_gateway import load_config
    base = load_config()["api_base"].removesuffix("/v1")
    try:
        with urlopen(base + "/api/ps", timeout=5) as response:
            models = json.load(response).get("models", [])
        for model in models:
            body = json.dumps({"model": model["name"], "keep_alive": 0}).encode()
            with urlopen(Request(base + "/api/generate", body, {"Content-Type": "application/json"}), timeout=30) as response:
                response.read()
    except (OSError, ValueError, KeyError):
        pass

@contextmanager
def lease(owner):
    with _lock:
        from . import segment
        from . import library
        if owner != "mineru":
            library.shutdown_worker("mineru")
        if owner in {"ollama", "mineru"}:
            for engine in segment.TEXT_ENGINES:
                if segment._engine_state[engine]["status"] == "ready":
                    segment.unload_engine(engine)
            if owner == "mineru":
                release_ollama()
        else:
            release_ollama()
            for engine in segment.TEXT_ENGINES:
                if engine != owner and segment._engine_state[engine]["status"] == "ready":
                    segment.unload_engine(engine)
        yield
