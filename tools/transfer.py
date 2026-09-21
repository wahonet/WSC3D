"""Sequential USB handover: database + changed resources, with conflict detection."""
from __future__ import annotations
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'src/backend'))
from app.workspace_lock import workspace_lock
from app.resource_archives import (MANIFEST_REL, archive_entry, archived_entries,
                                   extract_resource, forget_archived)

FORMAT = 'wsc-handover-1'
STATE = 'data/handover.json'
DB = 'data/stonelab.db'

def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',',':'),
                      default=lambda v: {'$bytes':bytes(v).hex()}).encode('utf-8')

def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.tmp')
    temp.write_bytes(encoded(value)); os.replace(temp,path)

def database_digest(path):
    result=hashlib.sha256()
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        for name,sql in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name").fetchall():
            result.update(encoded([name,sql]))
            quoted='"'+name.replace('"','""')+'"'
            columns=len(db.execute('SELECT * FROM '+quoted+' LIMIT 0').description)
            for row in db.execute('SELECT * FROM '+quoted+' ORDER BY '+','.join(str(i+1) for i in range(columns))):
                result.update(encoded(row)); result.update(b'\n')
    return result.hexdigest()

def allowed(name):
    if not isinstance(name,str) or '\\' in name or ':' in name: return False
    parts=name.split('/')
    if any(p in ('','..','.') for p in parts): return False
    return name in (DB, 'data/creative.sqlite3', 'data/library-quality.json', 'config/resource-aliases.json') or any(name.startswith(p) for p in ('resources/','data/layouts/','data/library/','data/creative/','data/video_jobs/','config/catalogue/'))

def contained(root, name):
    path=(root/name).resolve()
    if not path.is_relative_to(root.resolve()): raise ValueError('交接包路径越界')
    return path

def file_list(root):
    # A packed original retains its research identity and handover path. The
    # storage packs themselves are outside these research-resource directories.
    result=[contained(root,name) for name in archived_entries(root)]
    for name in ('resources','data/layouts','data/library','data/creative','data/video_jobs','config/catalogue'):
        directory=root/name
        if directory.is_dir(): result.extend(p for p in directory.rglob('*') if p.is_file())
    for name in ('data/creative.sqlite3','data/library-quality.json','config/resource-aliases.json'):
        if (root/name).is_file(): result.append(root/name)
    return sorted(set(result))

def software_digest(root):
    h=hashlib.sha256()
    for folder in ('src/backend','src/frontend','config/models.json','config/project.json'):
        path=root/folder
        files=sorted(path.rglob('*')) if path.is_dir() else [path]
        for p in files:
            if p.is_file() and '__pycache__' not in p.parts and p.suffix not in ('.pyc','.tsbuildinfo'):
                h.update(p.relative_to(root).as_posix().encode()); h.update(bytes.fromhex(digest(p)))
    return h.hexdigest()

def capture(root):
    key=hashlib.sha256(str(root).casefold().encode()).hexdigest()[:20]
    cache=Path(os.environ.get('LOCALAPPDATA',tempfile.gettempdir()))/'WSC-Unified/transfer'/f'{key}.json'
    previous=json.loads(cache.read_text(encoding='utf-8')) if cache.is_file() else {}
    files={}; stamps={}
    for path in file_list(root):
        name=path.relative_to(root).as_posix()
        if not allowed(name): raise ValueError(f'不支持的资源路径：{name}')
        if not path.is_file():
            entry=archive_entry(path,root)
            if entry is None: raise FileNotFoundError(f'归档资源不可用：{name}')
            files[name]={'sha256':entry['sha256'],'bytes':entry['bytes']}
            continue
        stat=path.stat(); old=previous.get(name,{})
        sha=old.get('sha256') if old.get('mtime_ns')==stat.st_mtime_ns and old.get('bytes')==stat.st_size else digest(path)
        files[name]={'sha256':sha,'bytes':stat.st_size}
        stamps[name]={**files[name],'mtime_ns':stat.st_mtime_ns}
    write_json(cache,stamps)
    database=database_digest(root/DB)
    return {'files':files,'database':database,'fingerprint':hashlib.sha256(encoded([database,files])).hexdigest()}

def read_state(root):
    path=root/STATE
    if not path.is_file(): raise RuntimeError('缺少交接基线。请先从同一完整项目副本开始，执行 init 后再复制到其他电脑。')
    state=json.loads(path.read_text(encoding='utf-8'))
    if state.get('format')!=FORMAT: raise ValueError('不支持的交接状态版本')
    return state

def initialize(root):
    if (root/STATE).exists(): raise RuntimeError('交接基线已经存在，不会覆盖。')
    state={'format':FORMAT,'dataset':uuid.uuid4().hex,**capture(root)}
    write_json(root/STATE,state)
    return {'initialized':True,'files':len(state['files']),'dataset':state['dataset']}

def export_package(root, output):
    state=read_state(root); current=capture(root)
    output=output.resolve()
    if output.is_relative_to(root): raise ValueError('请将交接包保存到 U 盘或工作目录之外。')
    if output.exists(): raise FileExistsError('交接包已存在，请使用新文件名。')
    changes={p:v for p,v in current['files'].items() if state['files'].get(p)!=v}
    removed=sorted(set(state['files'])-set(current['files']))
    manifest={'format':FORMAT,'dataset':state['dataset'],'software':software_digest(root),
              'parent':state['fingerprint'],'result':current['fingerprint'],'database':current['database'],
              'files':changes,'removed':removed,'created':datetime.now(timezone.utc).isoformat()}
    output.parent.mkdir(parents=True,exist_ok=True)
    staging=output.with_name(output.name+'.partial')
    with tempfile.TemporaryDirectory(prefix='wsc-export-') as temporary:
        database=Path(temporary)/'stonelab.db'
        with closing(sqlite3.connect(root/DB)) as src, closing(sqlite3.connect(database)) as dst: src.backup(dst)
        manifest['files'][DB]={'sha256':digest(database),'bytes':database.stat().st_size}
        try:
            with zipfile.ZipFile(staging,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as archive:
                archive.writestr('handover.json',encoded(manifest))
                archive.write(database,DB)
                for name in changes:
                    if name!=DB:
                        path=contained(root,name)
                        archive.write(path if path.is_file() else extract_resource(path,root),name)
            with zipfile.ZipFile(staging) as archive:
                for name,item in manifest['files'].items():
                    with archive.open(name) as stream:
                        if hashlib.file_digest(stream,'sha256').hexdigest()!=item['sha256']: raise RuntimeError('交接包校验失败')
            os.replace(staging,output)
        finally:
            if staging.exists(): staging.unlink()
    # A successfully handed-over loose replacement supersedes its old packed
    # original on the sender as well as the recipient. Keep the immutable pack,
    # but stop resolving a later deletion back to stale content.
    packed=archived_entries(root)
    replaced=[name for name in changes if name in packed and contained(root,name).is_file()]
    if replaced: forget_archived(replaced,root)
    write_json(root/STATE,{'format':FORMAT,'dataset':state['dataset'],**current})
    return {'package':str(output),'bytes':output.stat().st_size,'changed_files':len(changes)-1,'removed_files':len(removed)}

def import_package(root, package):
    state=read_state(root)
    with zipfile.ZipFile(package) as archive:
        manifest=json.loads(archive.read('handover.json'))
        if manifest.get('format')!=FORMAT or manifest.get('dataset')!=state['dataset']: raise ValueError('交接包来自不同的项目基线。')
        if manifest.get('software')!=software_digest(root): raise ValueError('两端程序版本不同，请先同步程序版本。')
        files=manifest['files']; removed=manifest['removed']
        if set(files)&set(removed) or DB not in files or DB in removed: raise ValueError('交接包文件清单冲突')
        if not all(allowed(n) for n in [*files,*removed]): raise ValueError('交接包包含不允许的路径')
        if len(archive.namelist())!=len(set(archive.namelist())) or set(archive.namelist())!={'handover.json',*files}: raise ValueError('交接包成员清单不一致')
        current=capture(root)
        if current['fingerprint']==manifest['result']: return {'already_imported':True}
        if current['fingerprint']!=manifest['parent']: raise RuntimeError('检测到两台电脑独立修改或缺少上一份交接包；已停止导入，现有成果未覆盖。')
        with tempfile.TemporaryDirectory(prefix='wsc-import-') as temporary:
            staged=Path(temporary)
            for name,info in files.items():
                target=contained(staged,name); target.parent.mkdir(parents=True,exist_ok=True)
                if archive.getinfo(name).file_size!=info['bytes']: raise ValueError('交接包文件长度不一致')
                with archive.open(name) as source,target.open('wb') as destination: shutil.copyfileobj(source,destination)
                if digest(target)!=info['sha256']: raise ValueError('交接包文件校验失败')
            with closing(sqlite3.connect(staged/DB)) as database:
                if database.execute('PRAGMA integrity_check').fetchone()[0]!='ok': raise ValueError('交接数据库校验失败')
            if database_digest(staged/DB)!=manifest['database']: raise ValueError('交接数据库内容校验失败')
            expected=dict(current['files'])
            expected.update({p:v for p,v in files.items() if p!=DB})
            for name in removed: expected.pop(name,None)
            if hashlib.sha256(encoded([manifest['database'],expected])).hexdigest()!=manifest['result']: raise ValueError('交接包结果指纹不一致')
            backup=root/'data/backups'/('handover-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
            backup.mkdir(parents=True)
            packed=archived_entries(root)
            forgotten=[name for name in [*files,*removed] if name in packed]
            touched=[*files,*removed,STATE]
            if forgotten: touched.append(MANIFEST_REL)
            existing=[]; archived_saved=[]
            for name in touched:
                original=contained(root,name)
                if original.is_file():
                    saved=backup/name; saved.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(original,saved); existing.append(name)
                elif name in packed:
                    # A recovery backup must remain complete after unused packs
                    # are collected. Preserve the affected original's bytes, not
                    # just a manifest pointing back into the live workspace.
                    saved=backup/name; saved.parent.mkdir(parents=True,exist_ok=True)
                    shutil.copy2(extract_resource(original,root),saved)
                    if digest(saved)!=current['files'][name]['sha256']:
                        raise RuntimeError(f'归档原件的交接备份校验失败：{name}')
                    archived_saved.append(name)
            write_json(backup/'receipt.json',{'files':existing,'archived_files':archived_saved,
                                             'touched':touched,'package':str(package)})
            try:
                # Both deletions and replacements retire the old packed entry.
                # Otherwise deleting a later loose override would resurrect it.
                if forgotten: forget_archived(forgotten,root)
                for name in removed: contained(root,name).unlink(missing_ok=True)
                # A stopped SQLite connection may leave empty WAL/SHM sidecars.
                for suffix in ('-wal','-shm'): (root/(DB+suffix)).unlink(missing_ok=True)
                for name in files:
                    target=contained(root,name); target.parent.mkdir(parents=True,exist_ok=True)
                    temporary_target=target.with_name(target.name+'.handover-tmp')
                    shutil.copy2(staged/name,temporary_target); os.replace(temporary_target,target)
                write_json(root/STATE,{'format':FORMAT,'dataset':state['dataset'],'files':expected,'database':manifest['database'],'fingerprint':manifest['result']})
            except BaseException:
                for name in touched:
                    target=contained(root,name)
                    if name in existing: shutil.copy2(backup/name,target)
                    else: target.unlink(missing_ok=True)
                raise
            finally:
                for name in files:
                    target=contained(root,name)
                    target.with_name(target.name+'.handover-tmp').unlink(missing_ok=True)
    return {'imported':True,'changed_files':len(files)-1,'backup':str(backup)}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('init'); sub.add_parser('status')
    sub.add_parser('export').add_argument('package',type=Path)
    sub.add_parser('import').add_argument('package',type=Path)
    args=parser.parse_args(); root=args.root.resolve()
    if not (root/'config/project.json').is_file() or not (root/DB).is_file(): raise ValueError('这不是完整的项目目录')
    with workspace_lock(root/'data'):
        if args.command=='init': result=initialize(root)
        elif args.command=='export': result=export_package(root,args.package)
        elif args.command=='import': result=import_package(root,args.package)
        else:
            state=read_state(root); current=capture(root)
            result={'dataset':state['dataset'],'changed':current['fingerprint']!=state['fingerprint'],'files':len(current['files'])}
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':
    try: main()
    except (RuntimeError,ValueError,OSError,zipfile.BadZipFile) as error:
        print(str(error),file=sys.stderr)
        raise SystemExit(1)
