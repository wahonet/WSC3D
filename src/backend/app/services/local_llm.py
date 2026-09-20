"""Manage the project-owned Ollama process on its own port."""
import json, os, subprocess, time, urllib.request
from .model_gateway import load_config
from ..config import settings
from pathlib import Path
BASE=settings.root

def start():
    cfg=load_config()
    if not cfg.get('managed_ollama'): return None
    host='127.0.0.1:11436'
    def ready():
        try:
            with urllib.request.urlopen('http://'+host+'/api/tags',timeout=1) as r:
                return isinstance(json.load(r).get('models'), list)
        except (OSError,ValueError): return False
    if ready(): return None
    binary=settings.ollama_binary
    if not binary.exists(): raise RuntimeError('缺少项目内 runtime/ollama/ollama.exe')
    log_dir=settings.logs_dir;log_dir.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy()
    env.update(OLLAMA_HOST=host,OLLAMA_MODELS=str(settings.ollama_models),
               OLLAMA_NOHISTORY='1',OLLAMA_KEEP_ALIVE='5m',OLLAMA_NUM_PARALLEL='1',OLLAMA_MAX_LOADED_MODELS='1',
               OLLAMA_CONTEXT_LENGTH=str(max(8192,int(cfg.get('chat_context_length',16384)))))
    with (log_dir/'ollama.log').open('ab') as log:
        proc=subprocess.Popen([str(binary),'serve'],cwd=str(BASE),env=env,
            stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(80):
        if ready(): return proc
        if proc.poll() is not None: raise RuntimeError(f'项目内AI服务启动失败，详情见 {log_dir / "ollama.log"}')
        time.sleep(.25)
    proc.terminate()
    raise RuntimeError(f'项目内AI服务未就绪，详情见 {log_dir / "ollama.log"}')

def stop(proc):
    # A restarted backend may have adopted its own existing Ollama server.
    # Resolve that listener before stopping, and leave other installations alone.
    import psutil
    owned=[]
    binary=(settings.ollama_binary).resolve()
    for connection in psutil.net_connections(kind='tcp'):
        if connection.status!='LISTEN' or not connection.laddr or connection.laddr.port!=11436 or not connection.pid:
            continue
        try:
            process=psutil.Process(connection.pid)
            if Path(process.exe()).resolve()!=binary:continue
            for child in process.children(recursive=True):
                if binary.parent in Path(child.exe()).resolve().parents:owned.append(child)
            owned.append(process)
        except (psutil.NoSuchProcess,psutil.AccessDenied):pass
    for process in owned:
        try:process.terminate()
        except psutil.NoSuchProcess:pass
    psutil.wait_procs(owned,timeout=5)
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill()
