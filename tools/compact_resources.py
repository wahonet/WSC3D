"""Losslessly pack original TIFF resources; retain their logical paths and bytes.

Run without arguments to inspect the plan. Stop the platform before --apply or
--restore. ZIP64 archives remain readable with ordinary ZIP extraction tools.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.resource_archives import archived_entries, extract_resource, forget_archived
from app.workspace_lock import workspace_lock

PACKS_REL = 'runtime/resource-packs'
MANIFEST_REL = PACKS_REL + '/manifest.json'
FORMAT = 'wsc-resource-packs-1'
BLOCK = 4 * 1024 * 1024


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def contained(root: Path, name: str) -> Path:
    path = (root / name).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError(f'项目路径越界：{name}')
    return path


def read_manifest(root: Path) -> dict:
    path = contained(root, MANIFEST_REL)
    if not path.is_file():
        return {'format': FORMAT, 'files': {}, 'packs': {}}
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('format') != FORMAT or not isinstance(data.get('files'), dict) or not isinstance(data.get('packs'), dict):
        raise ValueError('不支持的资源压缩清单')
    archived_entries(root)  # Apply the same validation as the runtime reader.
    return data


def write_manifest(root: Path, data: dict) -> None:
    path = contained(root, MANIFEST_REL)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('manifest-' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def originals(root: Path) -> list[Path]:
    folder = contained(root, 'resources/stones')
    if not folder.is_dir():
        raise ValueError('未找到 resources/stones 目录')
    return sorted(p for p in folder.rglob('*')
                  if p.is_file() and p.suffix.lower() in {'.tif', '.tiff'}
                  and len(p.relative_to(folder).parts) > 2
                  and p.relative_to(folder).parts[1] in {'images', 'versions'}
                  and contained(root, p.relative_to(root).as_posix()) == p)


def plan(root: Path) -> dict:
    files = originals(root)
    entries = archived_entries(root)
    manifest = read_manifest(root)
    return {'mode': 'plan', 'original_files': len(files),
            'original_bytes': sum(p.stat().st_size for p in files),
            'stones': len({p.relative_to(root / 'resources/stones').parts[0] for p in files}),
            'archived_files': len(entries), 'archived_original_bytes': sum(e['bytes'] for e in entries.values()),
            'pack_bytes': sum(e['bytes'] for e in manifest['packs'].values()),
            'method': 'ZIP64 / DEFLATE level 1; original bytes and logical paths retained'}


def verify_member(pack: Path, member: str, expected: dict) -> None:
    with zipfile.ZipFile(pack) as archive:
        info = archive.getinfo(member)
        if info.file_size != expected['bytes']:
            raise ValueError(f'压缩成员长度不符：{member}')
        with archive.open(info) as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected['sha256']:
            raise ValueError(f'压缩成员校验失败：{member}')


def unchanged(path: Path, entry: dict) -> bool:
    try:
        before = path.stat()
        if (before.st_size, before.st_mtime_ns) != (entry['bytes'], entry['mtime_ns']):
            return False
        actual = digest(path)
        after = path.stat()
        return actual == entry['sha256'] and (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)
    except FileNotFoundError:
        return False


def pack_stone(root: Path, files: list[Path]) -> tuple[str, dict, dict]:
    from PIL import Image
    # These are trusted local scan originals; only headers are read, not pixels.
    Image.MAX_IMAGE_PIXELS = None
    # UUIDs avoid overwriting archives referenced by a previous successful run.
    name = 'stones-' + uuid.uuid4().hex + '.zip'
    final = contained(root, PACKS_REL + '/' + name)
    final.parent.mkdir(parents=True, exist_ok=True)
    temporary = final.with_suffix('.zip.part')
    entries = {}
    try:
        with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_DEFLATED,
                             compresslevel=1, allowZip64=True) as archive:
            for path in files:
                logical = path.relative_to(root).as_posix()
                if contained(root, logical) != path:
                    raise ValueError(f'资源路径发生变化：{logical}')
                before = path.stat()
                with Image.open(path) as image:
                    width, height, fmt = image.width, image.height, image.format
                sha = hashlib.sha256()
                with path.open('rb') as source, archive.open(logical, 'w', force_zip64=True) as target:
                    while chunk := source.read(BLOCK):
                        sha.update(chunk)
                        target.write(chunk)
                after = path.stat()
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise RuntimeError(f'压缩期间原件被修改，未删除：{logical}')
                entries[logical] = {'pack': name, 'member': logical, 'sha256': sha.hexdigest(),
                                    'bytes': before.st_size, 'mtime_ns': before.st_mtime_ns,
                                    'width': width, 'height': height, 'fmt': fmt or 'TIFF'}
        # Full decompression verifies both CRC and SHA before publishing any entry.
        for logical, entry in entries.items():
            verify_member(temporary, logical, entry)
        info = {'sha256': digest(temporary), 'bytes': temporary.stat().st_size}
        os.replace(temporary, final)
        return name, info, entries
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def remove_unreferenced(root: Path) -> int:
    """Only delete ZIP files named by a validated manifest, never walk a directory."""
    manifest = read_manifest(root)
    referenced = {entry['pack'] for entry in manifest['files'].values()}
    unused = {name: info for name, info in manifest['packs'].items() if name not in referenced}
    removed = 0
    for name, info in unused.items():
        if Path(name).name != name or not name.endswith('.zip'):
            raise ValueError('压缩包路径不合法')
        path = contained(root, PACKS_REL + '/' + name)
        if path.is_file():
            # Refuse to remove externally replaced files, even when unreferenced.
            if path.stat().st_size != info['bytes'] or digest(path) != info['sha256']:
                continue
            path.unlink()
        manifest['packs'].pop(name)
        removed += 1
    if removed:
        write_manifest(root, manifest)
    return removed


def compact(root: Path, workers: int = 4) -> dict:
    root = root.resolve()
    with workspace_lock(contained(root, 'data')):
        files = originals(root)
        manifest = read_manifest(root)
        deleted = 0
        freed = 0
        pending = []
        # Resume an interrupted run that published its manifest before unlinking.
        for path in files:
            logical = path.relative_to(root).as_posix()
            entry = manifest['files'].get(logical)
            if entry and unchanged(path, entry):
                verify_member(contained(root, PACKS_REL + '/' + entry['pack']), entry['member'], entry)
                if unchanged(path, entry):
                    path.unlink()
                    deleted += 1
                    freed += entry['bytes']
                    continue
            pending.append(path)
        grouped = {}
        for path in pending:
            stone = path.relative_to(root / 'resources/stones').parts[0]
            grouped.setdefault(stone, []).append(path)
        # Resolve/create the common directory before parallel Windows path
        # resolution, rather than racing to create a previously missing parent.
        pack_directory = contained(root, PACKS_REL)
        pack_directory.mkdir(parents=True, exist_ok=True)
        contained(root, PACKS_REL)
        new_pack_bytes = 0
        kept = []
        failures = []
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(pack_stone, root, group): stone for stone, group in grouped.items()}
            for future in as_completed(futures):
                try:
                    name, info, entries = future.result()
                except Exception as error:
                    failures.append(f'{futures[future]}: {error}')
                    continue
                manifest = read_manifest(root)
                manifest['packs'][name] = info
                manifest['files'].update(entries)
                write_manifest(root, manifest)
                new_pack_bytes += info['bytes']
                for logical, entry in entries.items():
                    path = contained(root, logical)
                    if unchanged(path, entry):
                        path.unlink()
                        deleted += 1
                        freed += entry['bytes']
                    else:
                        kept.append(logical)
                print(json.dumps({'stone': futures[future], 'files': len(entries),
                                  'original_bytes': sum(e['bytes'] for e in entries.values()),
                                  'packed_bytes': info['bytes'], 'verified': True}, ensure_ascii=False), flush=True)
        removed_packs = remove_unreferenced(root)
        if failures:
            raise RuntimeError('以下资料未压缩，原件仍保留；已完成的资料可继续使用：' + '; '.join(failures))
        return {'mode': 'apply', 'removed_original_files': deleted, 'removed_original_bytes': freed,
                'new_pack_bytes': new_pack_bytes, 'net_bytes_saved_this_run': freed - new_pack_bytes,
                'changed_originals_kept': kept, 'unreferenced_packs_removed': removed_packs}


def restore(root: Path) -> dict:
    root = root.resolve()
    with workspace_lock(contained(root, 'data')):
        entries = archived_entries(root)
        restored = []
        try:
            for logical, entry in entries.items():
                target = contained(root, logical)
                if target.exists():
                    if not target.is_file() or digest(target) != entry['sha256']:
                        raise RuntimeError(f'散文件与归档原件不同，保留现场并停止恢复：{logical}')
                    restored.append(logical)
                    continue
                cached = extract_resource(target, root)
                if not cached.is_file() or digest(cached) != entry['sha256']:
                    raise RuntimeError(f'归档解压校验失败：{logical}')
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.restore-tmp')
                try:
                    shutil.copyfile(cached, temporary)
                    if digest(temporary) != entry['sha256']:
                        raise RuntimeError(f'恢复文件校验失败：{logical}')
                    os.utime(temporary, ns=(entry['mtime_ns'], entry['mtime_ns']))
                    if target.exists():
                        raise RuntimeError(f'恢复过程中目标出现新文件，未覆盖：{logical}')
                    os.replace(temporary, target)
                    restored.append(logical)
                finally:
                    temporary.unlink(missing_ok=True)
        finally:
            if restored:
                forget_archived(restored, root)
        removed_packs = remove_unreferenced(root)
        return {'mode': 'restore', 'restored_files': len(restored),
                'restored_bytes': sum(entries[name]['bytes'] for name in restored),
                'unreferenced_packs_removed': removed_packs}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true', help='校验压缩包后删除对应散文件')
    mode.add_argument('--restore', action='store_true', help='校验并恢复原始散文件')
    parser.add_argument('--workers', type=int, choices=range(1, 9), default=4)
    args = parser.parse_args()
    root = args.root.resolve()
    result = compact(root, args.workers) if args.apply else restore(root) if args.restore else plan(root)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile, KeyError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
