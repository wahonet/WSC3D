"""Serve the legacy viewer and its sibling media folders on one local origin.

The viewer at /武氏祠三维模型.html requests ../02-三维扫描模型 and
../03-盘点记录/盘点照片. Serving only its HTML directory makes both return 404.
This server maps the required folders explicitly and keeps the existing URL valid.
"""
from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import threading
from urllib.parse import unquote, urlsplit
import webbrowser
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/backend'))
from app.resource_paths import resolve_resource


PROJECT = Path(__file__).resolve().parents[1] / 'resources/reference/viewers'
VIEWER = "武氏祠三维模型.html"
LEGACY = PROJECT / "04-旧版三维模型"
ROUTES = {
    "/02-三维扫描模型/": PROJECT / "02-三维扫描模型",
    "/03-盘点记录/盘点照片/": PROJECT / "03-盘点记录" / "盘点照片",
    "/04-旧版三维模型/": LEGACY,
}


def resolve_asset(url: str) -> Path | None:
    request_path = unquote(urlsplit(url).path)
    if request_path in ("/", "/" + VIEWER):
        return LEGACY / VIEWER
    for prefix, root in ROUTES.items():
        if request_path.startswith(prefix):
            resolved_root = root.resolve()
            candidate = (root / request_path[len(prefix):]).resolve()
            if candidate.is_relative_to(resolved_root):
                return resolve_resource(candidate)
    return None


class ViewerHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".gltf": "model/gltf+json",
        ".glb": "model/gltf-binary",
    }

    def translate_path(self, path: str) -> str:
        return str(resolve_asset(path) or LEGACY / ".unmapped-preview-resource")

    def list_directory(self, path: str):
        self.send_error(404, "Viewer resource not found")
        return None

    def end_headers(self):
        self.send_header("X-Wushici-Viewer", "1")
        if unquote(urlsplit(self.path).path) in ("/", "/" + VIEWER) or self.path.endswith(".html"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


class ViewerServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR permits two servers to bind the same port, which makes
    # a second double-click look successful while requests go to either process.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8040)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    url = f"http://localhost:{args.port}/"
    try:
        server = ViewerServer((args.bind, args.port), ViewerHandler)
    except OSError as exc:
        # A second double-click can reuse an already running copy of this viewer.
        from urllib.request import Request, urlopen
        try:
            with urlopen(Request(url, method="HEAD"), timeout=2) as response:
                existing = response.headers.get("X-Wushici-Viewer") == "1"
        except OSError:
            existing = False
        if existing:
            if args.open_browser:
                webbrowser.open(url)
            return
        if getattr(exc, 'winerror', None) == 10013:
            # Hyper-V/WSL may reserve the configured port on another computer.
            # Let Windows assign an available local port without changing OS rules.
            server = ViewerServer((args.bind, 0), ViewerHandler)
        else:
            raise SystemExit(f"Cannot start viewer on port {args.port}: {exc}") from exc
    url = f'http://localhost:{server.server_address[1]}/'
    print(f"Wushici viewer ready: {url}", flush=True)
    if args.open_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
