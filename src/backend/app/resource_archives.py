"""Lossless resource packs with verified, disposable local read caches.

The manifest describes logical original files. Packs travel with the project;
the cache does not. Physical originals always override their archived versions.
"""
from __future__ import annotations

from contextlib import contextmanager
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import threading
import time
import uuid
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[3]
PACKS_REL = 'runtime/resource-packs'
MANIFEST_REL = PACKS_REL + '/manifest.json'
FORMAT = 'wsc-resource-packs-1'
_locks = [threading.Lock() for _ in range(32)]


def _relative(value: str) -> str:
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ValueError('Invalid packed resource path')
    parts = value.split('/')
    if any(part in ('', '.', '..') for part in parts) or PurePosixPath(value).is_absolute():
        raise ValueError('Invalid packed resource path')
    return value


@lru_cache(maxsize=8)
def _load(path: str, stamp: int, size: int) -> dict:
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    if value.get('format') != FORMAT or not isinstance(value.get('files'), dict) or not isinstance(value.get('packs'), dict):
        raise ValueError('Unsupported resource pack manifest')
    seen = set()
    for name, entry in value['files'].items():
        _relative(name)
        if not name.startswith('resources/') or name.casefold() in seen:
            raise ValueError('Invalid or duplicate packed resource name')
        seen.add(name.casefold())
        pack = _relative(entry['pack'])
        if '/' in pack or not pack.endswith('.zip') or pack not in value['packs']:
            raise ValueError('Invalid resource pack name')
        _relative(entry['member'])
        if not isinstance(entry.get('bytes'), int) or entry['bytes'] < 0:
            raise ValueError('Invalid packed resource size')
        if not isinstance(entry.get('mtime_ns'), int) or entry['mtime_ns'] < 0:
            raise ValueError('Invalid packed resource timestamp')
        sha = entry.get('sha256', '')
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
            raise ValueError('Invalid packed resource digest')
    return value


def manifest(root: Path = ROOT) -> dict:
    path = Path(root).resolve() / MANIFEST_REL
    if not path.is_file():
        return {'format': FORMAT, 'files': {}, 'packs': {}}
    stat = path.stat()
    return _load(str(path), stat.st_mtime_ns, stat.st_size)


def archived_entries(root: Path = ROOT) -> dict:
    # Return independent dictionaries so callers cannot modify the cached view.
    return {name: dict(entry) for name, entry in manifest(root)['files'].items()}


def _pack_path(entry: dict, root: Path) -> Path:
    folder = (root / PACKS_REL).resolve()
    path = (folder / entry['pack']).resolve()
    if path.parent != folder or not path.is_file():
        raise FileNotFoundError(f"Resource pack is missing: {entry['pack']}")
    expected = manifest(root)['packs'][entry['pack']].get('bytes')
    if expected is not None and path.stat().st_size != expected:
        raise OSError(f"Resource pack size does not match: {entry['pack']}")
    return path


def archive_entry(path: Path, root: Path = ROOT) -> dict | None:
    root, path = Path(root).resolve(), Path(path).resolve()
    if not path.is_relative_to(root / 'resources') or path.is_file():
        return None
    name = path.relative_to(root).as_posix()
    entries = manifest(root)['files']
    entry = entries.get(name)
    if entry is None:
        match = next((key for key in entries if key.casefold() == name.casefold()), None)
        if match is None:
            return None
        name, entry = match, entries[match]
    _pack_path(entry, root)
    return {**entry, 'path': name}


def verify_archives(paths, root: Path = ROOT) -> None:
    """Hash each compressed pack once during a full resource check."""
    root = Path(root).resolve()
    checked = set()
    for path in paths:
        entry = archive_entry(path, root)
        if entry is None or entry['pack'] in checked:
            continue
        pack = _pack_path(entry, root)
        expected = manifest(root)['packs'][entry['pack']].get('sha256')
        with pack.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected:
            raise ValueError(f"Resource pack failed SHA-256 verification: {entry['pack']}")
        checked.add(entry['pack'])


def _cache_base(root: Path, cache_root: Path | None = None) -> Path:
    if cache_root is not None:
        base = Path(cache_root)
    elif os.environ.get('WSC_CACHE_ROOT'):
        base = Path(os.environ['WSC_CACHE_ROOT'])
    elif os.environ.get('STONELAB_DATA'):
        base = Path(os.environ['STONELAB_DATA']) / 'cache'
    else:
        base = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir())) / 'WSC-Unified/cache'
        base /= hashlib.sha256(str(root).casefold().encode()).hexdigest()[:16]
    return base.resolve() / 'resource-packs'


def _cache_path(name: str, entry: dict, root: Path, cache_root: Path | None = None) -> Path:
    identity = hashlib.sha256(name.casefold().encode('utf-8')).hexdigest()[:20]
    return _cache_base(root, cache_root) / entry['sha256'][:24] / identity / PurePosixPath(name).name


def _stamp(path: Path) -> dict:
    stat = path.stat()
    return {'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns, 'ctime_ns': stat.st_ctime_ns}


@contextmanager
def _process_lock(target: Path):
    """The platform and authoring tools may populate the same Windows cache."""
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.with_name(target.name + '.lock').open('a+b') as stream:
        # A Windows byte lock prevents reads too; inspect length without reading.
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b'0')
            stream.flush()
        deadline = time.monotonic() + 180
        while True:
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Another process is still preparing this original')
                time.sleep(0.05)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def extract_resource(path: Path, root: Path = ROOT, cache_root: Path | None = None) -> Path:
    root, path = Path(root).resolve(), Path(path).resolve()
    entry = archive_entry(path, root)
    if entry is None:
        return path
    target = _cache_path(entry['path'], entry, root, cache_root)
    marker = target.with_name(target.name + '.verified.json')
    lock = _locks[int(entry['sha256'][:8], 16) % len(_locks)]
    with lock, _process_lock(target):
        pack = _pack_path(entry, root)
        pack_stamp = _stamp(pack)
        try:
            saved = json.loads(marker.read_text(encoding='utf-8'))
            if (target.is_file() and saved.get('sha256') == entry['sha256']
                    and saved.get('pack') == pack_stamp and saved.get('file') == _stamp(target)):
                return target
        except (OSError, ValueError):
            pass
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            sha, size = hashlib.sha256(), 0
            with zipfile.ZipFile(pack) as archive:
                info = archive.getinfo(entry['member'])
                if info.is_dir() or info.file_size != entry['bytes']:
                    raise ValueError('Packed original size does not match its manifest')
                with archive.open(info) as source, temporary.open('xb') as output:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        size += len(chunk)
                        if size > entry['bytes']:
                            raise ValueError('Packed original exceeds its declared size')
                        sha.update(chunk)
                        output.write(chunk)
            if size != entry['bytes'] or sha.hexdigest() != entry['sha256']:
                raise ValueError('Packed original failed SHA-256 verification')
            os.utime(temporary, ns=(entry['mtime_ns'], entry['mtime_ns']))
            os.replace(temporary, target)
            record = {'sha256': entry['sha256'], 'file': _stamp(target), 'pack': pack_stamp}
            temp_marker = marker.with_name(marker.name + '.' + uuid.uuid4().hex + '.tmp')
            try:
                temp_marker.write_text(json.dumps(record), encoding='utf-8')
                os.replace(temp_marker, marker)
            finally:
                temp_marker.unlink(missing_ok=True)
            return target
        except (zipfile.BadZipFile, zlib.error, KeyError, RuntimeError) as error:
            raise ValueError('Packed original could not be read or verified') from error
        finally:
            temporary.unlink(missing_ok=True)


def logical_resource_path(path: Path, root: Path = ROOT, cache_root: Path | None = None) -> Path:
    root, path = Path(root).resolve(), Path(path).resolve()
    if not path.is_relative_to(_cache_base(root, cache_root)):
        return path
    for name, entry in manifest(root)['files'].items():
        if _cache_path(name, entry, root, cache_root) == path:
            return root / name
    return path


def forget_archived(names, root: Path = ROOT) -> None:
    root = Path(root).resolve()
    current = manifest(root)
    removed = {str(name).replace('\\', '/').casefold() for name in names}
    files = {name: entry for name, entry in current['files'].items() if name.casefold() not in removed}
    if len(files) == len(current['files']):
        return
    value = {**current, 'files': files}
    path = root / MANIFEST_REL
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
