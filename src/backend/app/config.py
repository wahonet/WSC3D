"""Native workspace paths; resources, models and user data have separate roots."""
from __future__ import annotations
import json
import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
APP_NAME = "武氏祠数字档案与图像研究平台"
APP_VERSION = "2.0.0"
UNIFIED = json.loads((ROOT / 'config/project.json').read_text(encoding='utf-8'))

def project_path(value, default: Path) -> Path:
    if not value: return default
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else ROOT / path

def _env_path(name: str, default: Path) -> Path:
    return Path(os.environ[name]).expanduser().resolve() if os.environ.get(name) else default

def _env_int(name: str, default: int) -> int:
    try: return int(os.environ.get(name, default))
    except (TypeError, ValueError): return default

def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return value.strip().lower() in ('1', 'true', 'yes', 'on') if value is not None else default

def _env_list(name: str, default: list[str]) -> list[str]:
    return [v.strip() for v in os.environ[name].split(',') if v.strip()] if os.environ.get(name) else default

RUNTIME = _env_path('WSC_RUNTIME_ROOT', ROOT / 'runtime')
MODELS = _env_path('WSC_MODELS_ROOT', ROOT / 'models')
MODEL_REGISTRY = json.loads((ROOT / 'config/models.json').read_text(encoding='utf-8'))
CACHE = (Path(os.environ['STONELAB_DATA']) / 'cache' if os.environ.get('STONELAB_DATA') else
         Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'WSC-Unified/cache' /
         hashlib.sha256(str(ROOT).casefold().encode()).hexdigest()[:16])

def model_path(name: str, field: str = 'directory') -> Path:
    """Resolve a registered model beneath the shared weights directory."""
    value = MODEL_REGISTRY['models'][name][field]
    path = (MODELS / value).resolve()
    if not path.is_relative_to(MODELS.resolve()):
        raise ValueError(f'Model path escapes models directory: {name}.{field}')
    return path

def relocate_venvs(runtime_root: Path) -> list[str]:
    """Repair interpreter homes after extracting a runtime on another computer."""
    base = runtime_root / 'ocr-python'
    if not (base / 'python.exe').is_file(): return []
    fixed = []
    for name in ('mineru', 'ndl'):
        cfg = runtime_root / name / 'pyvenv.cfg'
        if not cfg.is_file(): continue
        old = cfg.read_text(encoding='utf-8')
        lines = [f'home = {base}' if line.partition('=')[0].strip() == 'home' else line for line in old.splitlines()]
        new = '\n'.join(lines) + '\n'
        if new != old:
            cfg.write_text(new, encoding='utf-8'); fixed.append(str(cfg))
    return fixed

@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    resources_dir: Path = ROOT / 'resources'
    assets_root: Path = field(default_factory=lambda: _env_path('STONELAB_ASSETS', ROOT / 'resources/stones'))
    documents_dir: Path = ROOT / 'resources/documents'
    library_root: Path = field(default_factory=lambda: _env_path('STONELAB_LIBRARY', ROOT / 'resources/documents/core/originals'))
    extension_root: Path = ROOT / 'resources/documents/extension'
    core_versions_dir: Path = ROOT / 'resources/documents/core/versions'
    scenes_dir: Path = ROOT / 'resources/scenes'
    data_dir: Path = field(default_factory=lambda: _env_path('STONELAB_DATA', ROOT / 'data'))
    logs_dir: Path = field(default_factory=lambda: _env_path('WSC_LOGS_ROOT', ROOT / 'logs'))
    cache_dir: Path = field(default_factory=lambda: _env_path('WSC_CACHE_ROOT', CACHE))
    web_dist: Path = ROOT / 'build/web'
    models_root: Path = MODELS
    runtime_root: Path = RUNTIME
    python: Path = RUNTIME / 'python/python.exe'
    rapidocr_python: Path = field(default_factory=lambda: _env_path('WSC_RAPIDOCR_PYTHON', RUNTIME / 'python/python.exe'))
    rapidocr_compat: Path = RUNTIME / 'rapidocr-compat'
    rapidocr_dml: Path = RUNTIME / 'rapidocr-dml'
    ollama_binary: Path = RUNTIME / 'ollama/ollama.exe'
    ollama_models: Path = model_path('ollama')
    ndl_root: Path = field(default_factory=lambda: _env_path('STONELAB_NDL_ROOT', ROOT / 'src/engines/ndl'))
    ndl_models_dir: Path = model_path('ndl')
    mineru_models_dir: Path = field(default_factory=lambda: _env_path('STONELAB_MINERU_MODELS', model_path('mineru')))
    host: str = os.environ.get('STONELAB_HOST', '127.0.0.1')
    port: int = _env_int('STONELAB_PORT', int(UNIFIED.get('port', 8030)))
    cors_origins: list[str] = field(default_factory=lambda: _env_list('STONELAB_CORS', ['http://127.0.0.1:5173', 'http://localhost:5173']))
    preview_long_edge: int = _env_int('STONELAB_PREVIEW_EDGE', 2560)
    preview_quality: int = 86
    thumb_long_edge: int = _env_int('STONELAB_THUMB_EDGE', 320)
    work_long_edge: int = _env_int('STONELAB_WORK_EDGE', 5120)
    scan_on_startup: bool = _env_bool('STONELAB_SCAN_ON_STARTUP', False)
    warm_previews: bool = _env_bool('STONELAB_WARM_PREVIEWS', True)
    ocr_dpi: int = _env_int('STONELAB_OCR_DPI', 300)
    view_dpi: int = 150
    sam_python_candidates: list[str] = field(default_factory=lambda: [os.environ.get('STONELAB_SAM_PYTHON', ''), str(RUNTIME / 'python/python.exe')])
    ocr_python_candidates: list[str] = field(default_factory=lambda: [os.environ.get('STONELAB_OCR_PYTHON', ''), str(RUNTIME / 'mineru/Scripts/python.exe')])
    ndl_python_candidates: list[str] = field(default_factory=lambda: [os.environ.get('STONELAB_NDL_PYTHON', ''), str(RUNTIME / 'ndl/Scripts/python.exe')])

    @property
    def layouts_dir(self) -> Path: return self.data_dir / 'layouts'
    @property
    def locations_file(self) -> Path: return ROOT / 'config/catalogue/locations.json'
    @property
    def reports_dir(self) -> Path: return self.data_dir / 'reports'
    @property
    def resource_manifest(self) -> Path: return self.data_dir / 'manifests/library-files.jsonl'
    @property
    def library_data_dir(self) -> Path: return self.data_dir / 'library'
    @property
    def ocr_log(self) -> Path: return self.logs_dir / 'ocr.log'
    @property
    def preview_dir(self) -> Path: return self.cache_dir / 'previews'
    @property
    def thumb_dir(self) -> Path: return self.cache_dir / 'thumbs'
    @property
    def db_path(self) -> Path: return self.data_dir / 'stonelab.db'
    @property
    def database_url(self) -> str: return f'sqlite:///{self.db_path.as_posix()}'
    @property
    def worker_log(self) -> Path: return self.logs_dir / 'segmentation.log'

settings = Settings()
for directory in (settings.data_dir, settings.preview_dir, settings.thumb_dir, settings.library_data_dir, settings.logs_dir, settings.reports_dir):
    directory.mkdir(parents=True, exist_ok=True)
relocate_venvs(settings.runtime_root)
