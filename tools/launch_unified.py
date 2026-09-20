"""Double-click entry: independent runtime, one backend and one local model server."""
from pathlib import Path
import argparse
import os
import json
import subprocess
import sys
import time
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / 'config/project.json').read_text(encoding='utf-8'))
URL = 'http://127.0.0.1:' + str(CONFIG.get('port', 8030))
# 配置中的路径相对于项目根目录；整个目录复制到别处后无需修改即可启动。
PYTHON = Path(os.environ.get('WSC_RUNTIME_ROOT', ROOT / 'runtime')) / 'python/python.exe'
parser = argparse.ArgumentParser()
parser.add_argument('--no-browser', action='store_true')
parser.add_argument('--stop', action='store_true')
parser.add_argument('--lan', action='store_true', help='监听 0.0.0.0，允许同一局域网内的设备访问')
options = parser.parse_args()

if not PYTHON.is_file():
    raise SystemExit(f'找不到项目自带的 Python：{PYTHON}\n请确认整个 wsc-unified 目录（含 runtime 文件夹）已完整复制。')

def health():
    try:
        with urlopen(URL + '/api/health', timeout=2) as response:
            return json.load(response)
    except OSError:
        return None

if options.stop:
    running = health()
    if running and Path(running.get('assets_root','')).resolve() != (ROOT/'resources/stones').resolve():
        raise RuntimeError('端口上的平台属于另一个工作目录，未停止。')
    if running:
        session = build_opener(HTTPCookieProcessor())
        credentials = json.dumps({'username': 'admin', 'password': os.environ.get('WSC_WORKSPACE_PASSWORD', '123456')}).encode()
        with session.open(Request(URL + '/api/workspace/login', data=credentials, headers={'Content-Type': 'application/json'}), timeout=10) as response:
            response.read()
        with session.open(Request(URL + '/api/runtime/stop', data=b'{}', headers={'Content-Type': 'application/json'}), timeout=10) as response:
            response.read()
        for _ in range(60):
            if not health():
                break
            time.sleep(.5)
    sys.exit(0)

existing = health()
if existing and (existing.get('version') != '2.0.0' or Path(existing.get('assets_root','')).resolve() != (ROOT/'resources/stones').resolve()):
    raise RuntimeError('8030 端口已有其他服务，请检查 config/project.json')
folder = ROOT / 'data/launcher'
if existing and options.lan:
    saved = json.loads((folder/'pid.json').read_text()) if (folder/'pid.json').exists() else {}
    if saved.get('listen_host') != '0.0.0.0':
        subprocess.run([str(PYTHON),'-X','utf8','-B',__file__,'--stop'],check=True)
        existing = None
if not existing:
    folder = ROOT / 'data/launcher'
    folder.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    listen_host = '0.0.0.0' if options.lan else '127.0.0.1'
    environment['STONELAB_HOST'] = listen_host
    logs = ROOT / 'logs'
    logs.mkdir(parents=True,exist_ok=True)
    with (logs / 'platform.log').open('a', encoding='utf-8') as output:
        process = subprocess.Popen([str(PYTHON), '-X', 'utf8', '-B', str(ROOT / 'tools/serve_unified.py')],
                                   cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                   creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    (folder / 'pid.json').write_text(json.dumps({'pid':process.pid,'url':URL,'listen_host':listen_host}),encoding='utf-8')
    for _ in range(120):
        if health():
            break
        if process.poll() is not None:
            raise RuntimeError('服务启动失败，请查看 logs/platform.log')
        time.sleep(.5)
    else:
        raise RuntimeError('启动超过一分钟，请查看启动日志')
if not options.no_browser:
    webbrowser.open(URL)
print(URL)
