"""Resumable project storage cleanup (2026-10-04 plan, tiers 1-6; tier7 added 2026-10-10).

Every tier re-plans from the current disk state, so an interrupted tier can be
re-run safely. Plans, deleted-file lists and progress are written to
data/reports/storage-cleanup-20261004/ (see RUNBOOK.md there).

    python tools/storage_cleanup.py status
    python tools/storage_cleanup.py tier1|tier2|tier3|tier4|tier5|tier6|tier7
    python tools/storage_cleanup.py rollback-tier2
Stop the platform before tier2 / rollback-tier2.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
from urllib.parse import unquote
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.resource_archives import extract_resource, forget_archived  # noqa: E402
from app.workspace_lock import workspace_lock  # noqa: E402

REPORT = ROOT / 'data/reports/storage-cleanup-20261004'
RESEARCH = ROOT / 'resources/authoring/research'
RUNS = ('multiversion-20261002', 'rear46-execution-20261003')
MANIFEST = ROOT / 'runtime/resource-packs/manifest.json'
TEXT = {'.json', '.md', '.csv', '.py', '.log', '.txt', '.jsonl'}
TMP_KEEP = {'wsc-check-backup', 'recovery'}
TIER6 = ('tmp/recovery/stonelab-after-tests-20260929.db',
         'data/backups/alignment-wu010-20261001', 'data/backups/multiversion-20261002')


def now():
    return datetime.now().isoformat(timespec='seconds')


def log(event, **data):
    REPORT.mkdir(parents=True, exist_ok=True)
    line = json.dumps({'time': now(), 'event': event, **data}, ensure_ascii=False)
    with (REPORT / 'log.jsonl').open('a', encoding='utf-8') as stream:
        stream.write(line + '\n')
    print(line, flush=True)


def progress(tier, **data):
    path = REPORT / 'progress.json'
    value = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    value[tier] = {**value.get(tier, {}), **data, 'updated_at': now()}
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def write_list(name, rows):
    with (REPORT / name).open('w', encoding='utf-8') as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')


def long(path: Path) -> str:
    text = str(path.resolve())
    return '\\\\?\\' + text if os.name == 'nt' and len(text) > 240 and not text.startswith('\\\\?\\') else text


def files_under(folder: Path):
    for dirpath, _, names in os.walk(folder):
        for name in names:
            yield Path(dirpath) / name


def measure(folder: Path = ROOT):
    count = size = 0
    for path in files_under(folder):
        try:
            size += os.path.getsize(long(path)); count += 1
        except OSError:
            pass
    return count, size


def sha256(path: Path) -> str:
    with open(long(path), 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def unlink(path: Path) -> int:
    try:
        size = os.path.getsize(long(path))
        os.unlink(long(path))
        return size
    except FileNotFoundError:
        return 0


def remove_tree(path: Path) -> tuple[int, int]:
    count = size = 0
    if path.is_file():
        return 1, unlink(path)
    for item in files_under(path):
        size += unlink(item); count += 1
    shutil.rmtree(long(path), ignore_errors=True)
    return count, size


def key(path) -> str:
    return str(Path(path).resolve()).casefold()


# ---------- reference sets (database evidence chain and Markdown links) ----------

def db_references() -> set[str]:
    refs = set()
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        for (raw,) in db.execute("SELECT geometry FROM annotations WHERE geometry LIKE '%image_version%'"):
            meta = json.loads(raw).get('image_version') or {}
            seg = meta.get('segmentation') or {}
            values = [seg.get('proposal'), seg.get('pixel_frame_record'), *(seg.get('review_evidence') or [])]
            for value in values:
                if not isinstance(value, str):
                    continue
                value = value.replace('\\', '/')
                if value.startswith('resources/'):
                    refs.add(key(ROOT / value)); continue
                runs = ([meta['research_run']] if meta.get('research_run') else []) + list(RUNS)
                for run in runs:
                    if (RESEARCH / run / value).exists():
                        refs.add(key(RESEARCH / run / value)); break
    return refs


def markdown_links() -> set[str]:
    linked = set()
    documents = [ROOT / 'README.md', *(p for p in files_under(RESEARCH) if p.suffix.lower() == '.md')]
    for document in documents:
        text = document.read_text(encoding='utf-8', errors='ignore')
        for link in re.findall(r'\]\(([^)#]+)', text):
            if link.startswith('http'):
                continue
            target = (document.parent / unquote(link)).resolve()
            if target.is_file():
                linked.add(key(target))
            elif target.is_dir():
                linked.update(key(p) for p in files_under(target))
    return linked


def committed_proposals() -> set[str]:
    names = set()
    for run in RUNS:
        path = RESEARCH / run / 'native-commits.json'
        if path.is_file():
            for row in json.loads(path.read_text(encoding='utf-8')).get('versions', []):
                if isinstance(row.get('proposal'), str):
                    names.add(key(RESEARCH / run / row['proposal'].replace('\\', '/')))
    return names


# ---------- tiers ----------

def tier1():
    rows = []
    for item in sorted((ROOT / 'tmp').iterdir()):
        if item.name in TMP_KEEP:
            continue
        count, size = remove_tree(item)
        rows.append({'path': item.relative_to(ROOT).as_posix(), 'files': count, 'bytes': size})
        log('tier1-removed', **rows[-1])
    for top in ('src', 'tools', 'tests', 'tmp', '.pytest_cache'):
        base = ROOT / top
        if top == '.pytest_cache' and base.exists():
            count, size = remove_tree(base)
            rows.append({'path': top, 'files': count, 'bytes': size}); continue
        for dirpath, dirnames, _ in os.walk(base):
            if '__pycache__' in dirnames:
                cache = Path(dirpath) / '__pycache__'
                count, size = remove_tree(cache)
                rows.append({'path': cache.relative_to(ROOT).as_posix(), 'files': count, 'bytes': size})
                dirnames.remove('__pycache__')
    write_list('tier1-removed.jsonl', rows)
    return rows


def read_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding='utf-8'))


def write_manifest(data: dict) -> None:
    temporary = MANIFEST.with_name('manifest-' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, MANIFEST)
    finally:
        temporary.unlink(missing_ok=True)


def tier2():
    """Register physical research-base snapshots as aliases of identical packed members."""
    with workspace_lock(ROOT / 'data'):
        backup = REPORT / 'manifest-before-tier2.json'
        if not backup.exists():
            shutil.copy2(MANIFEST, backup)
        manifest = read_manifest()
        names = {name.casefold() for name in manifest['files']}
        by_sha = {}
        for name, entry in manifest['files'].items():
            if '/versions/' not in name:
                by_sha.setdefault(entry['sha256'], entry)
        for name, entry in manifest['files'].items():
            by_sha.setdefault(entry['sha256'], entry)
        candidates = []
        for stone in sorted((ROOT / 'resources/stones').iterdir()):
            for path in files_under(stone / 'versions'):
                if path.parent.name in by_sha:
                    candidates.append(path)
        log('tier2-plan', candidates=len(candidates))
        pending, done, freed, skipped = [], 0, 0, []
        record = (REPORT / 'tier2-snapshots.jsonl').open('a', encoding='utf-8')

        def flush():
            nonlocal done, freed
            if not pending:
                return
            write_manifest(manifest)
            for path, stat in pending:
                after = os.stat(long(path))
                if (after.st_size, after.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
                    raise RuntimeError(f'Snapshot changed during tier2: {path}')
                freed += unlink(path); done += 1
            log('tier2-batch', removed=len(pending), total_removed=done, freed_bytes=freed)
            pending.clear()

        try:
            for path in candidates:
                name = path.relative_to(ROOT).as_posix()
                source = by_sha[path.parent.name]
                stat = os.stat(long(path))
                actual = sha256(path)
                if actual != source['sha256'] or stat.st_size != source['bytes']:
                    skipped.append({'path': name, 'reason': 'content differs from packed member'})
                    log('tier2-skip', **skipped[-1]); continue
                pack = ROOT / 'runtime/resource-packs' / source['pack']
                if pack.stat().st_size != manifest['packs'][source['pack']]['bytes']:
                    raise RuntimeError(f"Pack size mismatch: {source['pack']}")
                with zipfile.ZipFile(pack) as archive:
                    if archive.getinfo(source['member']).file_size != source['bytes']:
                        raise RuntimeError(f"Packed member size mismatch: {source['member']}")
                if name.casefold() not in names:
                    entry = {k: source[k] for k in ('pack', 'member', 'sha256', 'bytes', 'width', 'height', 'fmt') if k in source}
                    entry['mtime_ns'] = stat.st_mtime_ns
                    manifest['files'][name] = entry
                    names.add(name.casefold())
                    record.write(json.dumps({'name': name, **entry}, ensure_ascii=False) + '\n'); record.flush()
                pending.append((path, stat))
                if len(pending) >= 20:
                    flush()
            flush()
        finally:
            record.close()
        write_list('tier2-skipped.jsonl', skipped)
        return {'removed': done, 'freed_bytes': freed, 'skipped': len(skipped)}


def rollback_tier2():
    with workspace_lock(ROOT / 'data'):
        rows = [json.loads(line) for line in (REPORT / 'tier2-snapshots.jsonl').read_text(encoding='utf-8').splitlines() if line]
        restored = []
        for row in rows:
            target = ROOT / row['name']
            if not target.is_file():
                cached = extract_resource(target, ROOT)
                temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.restore-tmp')
                shutil.copyfile(cached, temporary)
                if sha256(temporary) != row['sha256']:
                    temporary.unlink(); raise RuntimeError(f"Restore digest mismatch: {row['name']}")
                os.utime(temporary, ns=(row['mtime_ns'], row['mtime_ns']))
                os.replace(temporary, target)
            restored.append(row['name'])
            log('tier2-restored', path=row['name'])
        forget_archived(restored, ROOT)
        return {'restored': len(restored)}


def research_images():
    refs, linked = db_references(), markdown_links()
    keep = refs | linked
    tier3, tier4 = [], []
    for path in files_under(RESEARCH):
        if path.suffix.lower() in TEXT or key(path) in keep:
            continue
        rel = path.relative_to(ROOT).as_posix()
        size = os.path.getsize(long(path))
        if '/object-extraction/cutouts/' in rel or '/object-extraction/masks/' in rel:
            tier4.append({'path': rel, 'bytes': size})
        else:
            tier3.append({'path': rel, 'bytes': size})
    return tier3, tier4


def delete_listed(tier, rows):
    write_list(f'{tier}-deleted.jsonl', rows)
    freed = 0
    for index, row in enumerate(rows, 1):
        freed += unlink(ROOT / row['path'])
        if index % 2000 == 0:
            log(f'{tier}-progress', deleted=index, of=len(rows), freed_bytes=freed)
    return {'deleted': len(rows), 'freed_bytes': freed}


def tier5():
    refs = db_references() | committed_proposals() | markdown_links()
    result = {}
    for run in RUNS:
        folder = RESEARCH / run / 'native-proposals'
        if not folder.is_dir():
            continue
        files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == '.json' and key(p) not in refs)
        if not files:
            continue
        number = 1
        while (RESEARCH / run / f'native-proposals-unreferenced-{number}.zip').exists():
            number += 1
        final = RESEARCH / run / f'native-proposals-unreferenced-{number}.zip'
        partial = final.with_suffix('.zip.part')
        partial.unlink(missing_ok=True)
        digests = {}
        with zipfile.ZipFile(partial, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for path in files:
                member = path.relative_to(RESEARCH / run).as_posix()
                data = Path(long(path)).read_bytes()
                digests[member] = hashlib.sha256(data).hexdigest()
                archive.writestr(zipfile.ZipInfo.from_file(long(path), member), data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
        with zipfile.ZipFile(partial) as archive:
            for member, digest in digests.items():
                if hashlib.sha256(archive.read(member)).hexdigest() != digest:
                    raise RuntimeError(f'Zip verification failed: {member}')
        os.replace(partial, final)
        write_list(f'tier5-{run}-{number}-members.jsonl', ({'member': m, 'sha256': d} for m, d in digests.items()))
        freed = sum(unlink(path) for path in files)
        result[run] = {'zip': final.relative_to(ROOT).as_posix(), 'files': len(files), 'freed_bytes': freed,
                       'zip_bytes': final.stat().st_size}
        log('tier5-packed', run=run, **result[run])
    return result


RUN_STATE = {'native-commits.json', 'native-decisions.json', 'alignment-commits.json', 'alignment-decisions.json',
             'alignment-review-plan.json', 'baseline.json', 'inventory.json', 'progress-audit.json'}
RUN_STATE_PREFIXES = ('native-batch-', 'native-review-queue-', 'native-decisions-', 'pilot-decisions-', 'native-jobs')


def pack_files(run, files, stem):
    """Verified ZIP of run-relative files; loose copies are removed only after every digest matches."""
    number = 1
    while (RESEARCH / run / f'{stem}-{number}.zip').exists():
        number += 1
    final = RESEARCH / run / f'{stem}-{number}.zip'
    partial = final.with_suffix('.zip.part')
    partial.unlink(missing_ok=True)
    digests = {}
    with zipfile.ZipFile(partial, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for path in files:
            member = path.relative_to(RESEARCH / run).as_posix()
            data = Path(long(path)).read_bytes()
            digests[member] = hashlib.sha256(data).hexdigest()
            archive.writestr(zipfile.ZipInfo.from_file(long(path), member), data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
    with zipfile.ZipFile(partial) as archive:
        for member, digest in digests.items():
            if hashlib.sha256(archive.read(member)).hexdigest() != digest:
                raise RuntimeError(f'Zip verification failed: {member}')
    os.replace(partial, final)
    write_list(f'{stem}-{run}-{number}-members.jsonl', ({'member': m, 'sha256': d} for m, d in digests.items()))
    freed = sum(unlink(path) for path in files)
    return {'zip': final.relative_to(ROOT).as_posix(), 'files': len(files), 'freed_bytes': freed, 'zip_bytes': final.stat().st_size}


def tier7():
    """Pack unreferenced review records at each run root; tool state files stay loose."""
    refs = db_references() | committed_proposals() | markdown_links()
    result = {}
    for run in RUNS:
        folder = RESEARCH / run
        if not folder.is_dir():
            continue
        files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == '.json' and key(p) not in refs
                       and p.name not in RUN_STATE and not p.name.startswith(RUN_STATE_PREFIXES))
        if files:
            result[run] = pack_files(run, files, 'review-records-unreferenced')
            log('tier7-packed', run=run, **result[run])
    return result


def tier6():
    rows = []
    for name in TIER6:
        path = ROOT / name
        if path.exists():
            count, size = remove_tree(path)
            rows.append({'path': name, 'files': count, 'bytes': size})
            log('tier6-removed', **rows[-1])
    write_list('tier6-removed.jsonl', rows)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['status', 'tier1', 'tier2', 'tier3', 'tier4', 'tier5', 'tier6', 'tier7', 'rollback-tier2'])
    command = parser.parse_args().command
    REPORT.mkdir(parents=True, exist_ok=True)
    if command == 'status':
        count, size = measure()
        print(json.dumps({'project_files': count, 'project_gib': round(size / 1024 ** 3, 2)}, ensure_ascii=False))
        path = REPORT / 'progress.json'
        print(path.read_text(encoding='utf-8') if path.is_file() else '{}')
        return
    before = measure()
    progress(command, status='running', started_at=now(), before_files=before[0], before_bytes=before[1])
    log(f'{command}-start', project_files=before[0], project_bytes=before[1])
    if command in ('tier3', 'tier4'):
        tier3_rows, tier4_rows = research_images()
        result = delete_listed(command, tier3_rows if command == 'tier3' else tier4_rows)
    else:
        result = {'tier1': tier1, 'tier2': tier2, 'tier5': tier5, 'tier6': tier6, 'tier7': tier7, 'rollback-tier2': rollback_tier2}[command]()
    after = measure()
    summary = {'after_files': after[0], 'after_bytes': after[1],
               'files_reduced': before[0] - after[0], 'gib_reduced': round((before[1] - after[1]) / 1024 ** 3, 2)}
    progress(command, status='done', finished_at=now(), **summary)
    log(f'{command}-done', **summary, result=result if isinstance(result, dict) else {'entries': len(result)})


if __name__ == '__main__':
    main()
