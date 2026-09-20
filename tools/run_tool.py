"""Run a maintained Python/Node tool using the verified machine cache."""
from pathlib import Path
import os
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]

def main():
    if len(sys.argv)<2: raise SystemExit('Usage: tools/run.ps1 tools/transfer.py status')
    script=(ROOT/sys.argv[1]).resolve()
    if not script.is_relative_to(ROOT) or not script.is_file(): raise ValueError('请选择项目中的工具或测试脚本')
    env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'}
    if script.suffix=='.mjs' or script.parent.name=='authoring':
        from build_frontend import prepare
        node,work=prepare()
        env.update(WSC_NODE_BINARY=str(node),WSC_NODE_MODULES=str(work/'node_modules'))
        env['PATH']=str(node.parent)+os.pathsep+env.get('PATH','')
    if script.suffix=='.py': command=[sys.executable,'-X','utf8','-B']
    elif script.suffix=='.mjs':command=[str(node)]
    else:raise ValueError('仅支持 Python 和 Node 脚本')
    return subprocess.call([*command,str(script),*sys.argv[2:]],cwd=ROOT,env=env)

if __name__=='__main__':raise SystemExit(main())
