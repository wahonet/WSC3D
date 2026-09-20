"""Resolve bundled model configuration before importing model libraries."""
from __future__ import annotations

import json
from pathlib import Path


def mineru_config(models_dir: Path) -> dict:
    """Relative entries follow mineru.json, independently of cwd and user caches."""
    models_dir = models_dir.resolve()
    source = models_dir / 'mineru.json'
    config = json.loads(source.read_text(encoding='utf-8'))
    paths = dict(config.get('models-dir') or {})
    if not paths:
        raise ValueError(f'MinerU 配置缺少 models-dir：{source}')
    for engine, value in paths.items():
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = models_dir / path
        # Compatibility with the original bundle's absolute paths, even if the
        # old installation still exists. Explicit external model paths remain valid.
        elif path.parent.name == 'mineru-models' and path.name == engine:
            path = models_dir / engine
        path = path.resolve()
        if not path.is_dir():
            raise FileNotFoundError(f'MinerU {engine} 本地模型目录不存在：{path}')
        paths[engine] = str(path)
    return {**config, 'models-dir': paths}


def write_mineru_config(models_dir: Path, target: Path) -> Path:
    config = mineru_config(models_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return target
