"""Frontend dev mode: Vite on http://127.0.0.1:5175 with hot reload, backed by the running platform.

Edits under src/frontend appear in the browser immediately; no rebuild is needed while
developing. The production page on :8030 keeps serving build/web until 构建前端.bat is run.
Uses the same offline Node toolkit as the build (runtime/development.zip, cached locally).
"""
from __future__ import annotations
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys

from build_frontend import ROOT, prepare

FRONTEND = ROOT / 'src/frontend'
DEV_URL = 'http://127.0.0.1:5175/'


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(.5)
        return probe.connect_ex(('127.0.0.1', port)) == 0


def link_modules(modules: Path) -> None:
    """Point src/frontend/node_modules at the cached toolkit (an NTFS junction needs no admin rights)."""
    link = FRONTEND / 'node_modules'
    if os.path.lexists(link):
        try:
            if link.resolve() == modules.resolve():
                return
        except OSError:
            pass
        reparse = getattr(os.lstat(link), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
        if not reparse and not os.path.islink(link):
            # A real folder (for example from a manual npm install) is left as it is.
            if (link / 'vite').is_dir():
                print('使用 src/frontend/node_modules 中已有的依赖。')
                return
            raise SystemExit('src/frontend/node_modules 是普通文件夹且缺少 vite，请移走后重试。')
        os.rmdir(link)  # removes only the junction, never the toolkit behind it
    subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(modules)], check=True, stdout=subprocess.DEVNULL)


def main() -> int:
    node, work = prepare()
    link_modules(work / 'node_modules')
    if port_open(5175):
        print(f'开发服务器已在运行：{DEV_URL}')
        import webbrowser
        webbrowser.open(DEV_URL)
        return 0
    # /api, /files, /models … are proxied to the platform; start it if needed (no browser tab).
    subprocess.run([sys.executable, '-X', 'utf8', '-B', str(ROOT / 'tools/launch_unified.py'), '--no-browser'], check=True)
    env = {**os.environ, 'PATH': str(node.parent) + os.pathsep + os.environ.get('PATH', '')}
    print(f'前端开发模式：{DEV_URL}\n修改 src/frontend 下的文件后浏览器会自动更新。关闭此窗口即停止开发服务器（平台本身继续运行）。', flush=True)
    try:
        return subprocess.call([str(node), str(FRONTEND / 'node_modules/vite/bin/vite.js'), '--open'], cwd=FRONTEND, env=env)
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
