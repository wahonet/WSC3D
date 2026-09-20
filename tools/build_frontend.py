"""Build the frontend offline; keep Node and dependencies in the machine cache."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]

def prepare() -> tuple[Path, Path]:
    bundle = ROOT / 'runtime/development.zip'
    receipt = json.loads(bundle.with_suffix('.receipt.json').read_text(encoding='utf-8'))
    cache = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'WSC-Unified/development' / receipt['sha256'][:20]
    work = cache / 'workspace'
    node = cache / 'node/node.exe'
    marker = cache / '.ready'
    if not marker.is_file():
        with bundle.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != receipt['sha256']:
                raise RuntimeError('开发工具包校验失败，请恢复完整副本')
        members = {v['path']: v for v in receipt['members']}
        with zipfile.ZipFile(bundle) as archive:
            for member in archive.infolist():
                name = member.filename
                if name.startswith('node/'):
                    target = cache / name
                elif name.startswith('node_modules/'):
                    target = work / name
                else: raise ValueError('Invalid toolkit member')
                if not target.resolve().is_relative_to(cache.resolve()):
                    raise ValueError('Invalid toolkit path')
                if member.is_dir(): continue
                content = archive.read(member)
                if hashlib.sha256(content).hexdigest() != members[name]['sha256']:
                    raise RuntimeError(f'工具包文件校验失败: {name}')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
        marker.write_text(receipt['sha256'], encoding='ascii')
    if not node.is_file() or not (work/'node_modules/typescript/bin/tsc').is_file():
        marker.unlink(missing_ok=True)
        raise RuntimeError('开发环境缓存不完整；请再次运行构建以修复')
    return node, work

def main() -> int:
    node, work = prepare()
    # Fresh source trees prevent deleted modules surviving in the build cache.
    for name in ('src', 'public', 'tools', 'dist'):
        path = (work/name).resolve()
        if path.exists():
            if not path.is_relative_to(work.resolve()): raise ValueError('Invalid build cache')
            shutil.rmtree(path)
    shutil.copytree(ROOT/'src/frontend', work, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('node_modules','dist','*.tsbuildinfo'))
    env = {**os.environ, 'PATH': str(node.parent)+os.pathsep+os.environ.get('PATH','')}
    subprocess.run([str(node),str(node.parent/'node_modules/npm/bin/npm-cli.js'),'run','build'],cwd=work,env=env,check=True)
    target = ROOT/'build/web'
    target.parent.mkdir(parents=True,exist_ok=True)
    staging = target.with_name('web-next')
    if staging.exists():
        if staging.resolve().parent != (ROOT/'build').resolve(): raise ValueError('Invalid staging path')
        shutil.rmtree(staging)
    shutil.copytree(work/'dist',staging)
    if target.exists():
        if target.resolve().parent != (ROOT/'build').resolve(): raise ValueError('Invalid build path')
        shutil.rmtree(target)
    staging.rename(target)
    print(f'Frontend built: {target}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
