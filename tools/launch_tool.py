"""Launch retained tools with the unified interpreter and configured ports."""
import argparse
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.config import settings, UNIFIED


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tool', choices=['legacy', 'xcl', 'rear'])
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if args.tool == 'legacy':
        command = [str(settings.python), '-X', 'utf8', '-B',
                   str(ROOT / 'tools/viewer.py'),
                   '--port', str(UNIFIED.get('viewer_port', 8040))]
        if not args.no_browser:
            command.append('--open-browser')
        return subprocess.call(command, cwd=ROOT)
    subprocess.run([str(settings.python), '-X', 'utf8', '-B', str(ROOT / 'tools/launch_unified.py'), '--no-browser'], check=True)
    url = f'http://127.0.0.1:{settings.port}/tools/{args.tool}-placement.html'
    if not args.no_browser:
        webbrowser.open(url)
    print(url)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
