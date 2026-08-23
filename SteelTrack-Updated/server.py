#!/usr/bin/env python3
"""
SteelTrack Server — shared-server backend for FACTORY_TRACK_AND_STOCK.html

Run this on ONE computer on your network (ideally one that stays on).

WHAT THIS DOES NOW:
  1. Sync server (WebSocket, default port 8765) — unchanged from before.
     Desktop app instances connect here via the Connection & Sync page.
  2. Web server (HTTP, default port 8080) — NEW. Lets phones/tablets/any
     browser on the same Wi-Fi open the app directly by visiting this
     computer's address, with live sync already turned on automatically
     (no address/key to type on the phone).

Requirements (one-time):
    pip install websockets --break-system-packages

Run:
    python3 server.py
    (or double-click run_server.bat on Windows)

On your phone (same Wi-Fi as this computer):
    Open a browser and go to the "Open on phone" address printed below.

Data is stored in steeltrack_data.json next to this script, so your data
survives restarts of this script/computer.
"""

import argparse
import asyncio
import json
import secrets
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import websockets
except ImportError:
    print("Missing dependency. Install it with:\n")
    print("    pip install websockets --break-system-packages\n")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_FILE = SCRIPT_DIR / "steeltrack_data.json"
TOKEN_FILE = SCRIPT_DIR / "steeltrack_server_key.txt"
CONFIG_PLACEHOLDER = "<!--LAN_SYNC_SERVER_CONFIG-->"


def find_app_html() -> Path:
    """Locate the app's HTML file next to this script."""
    preferred = ["app.html", "index.html"]
    for name in preferred:
        p = SCRIPT_DIR / name
        if p.exists():
            return p
    candidates = sorted(SCRIPT_DIR.glob("*.html"))
    for p in candidates:
        if "FACTORY_TRACK" in p.name.upper() or "STEELTRACK" in p.name.upper():
            return p
    if candidates:
        return candidates[0]
    print(f"Could not find an .html file next to server.py in {SCRIPT_DIR}")
    print("Place the SteelTrack .html file in the same folder as server.py.")
    sys.exit(1)


def load_store() -> dict:
    if DATA_FILE.exists():
        try:
            return json.loads(DATA_FILE.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"Warning: could not read {DATA_FILE.name} ({e}); starting empty.")
    return {}


def save_store(store: dict) -> None:
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(store), encoding="utf-8")
    tmp.replace(DATA_FILE)


def load_or_create_token() -> str:
    if TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if tok:
            return tok
    tok = secrets.token_urlsafe(16)
    TOKEN_FILE.write_text(tok, encoding="utf-8")
    return tok


def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class SyncServer:
    def __init__(self, token: str):
        self.token = token
        self.store = load_store()
        self.clients = set()

    async def handler(self, ws):
        authed = False
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue

                mtype = msg.get("type")

                if mtype == "auth":
                    if msg.get("token") == self.token:
                        authed = True
                        self.clients.add(ws)
                        await ws.send(json.dumps({"type": "auth_ok"}))
                        await ws.send(json.dumps({"type": "hello", "store": self.store}))
                    else:
                        await ws.send(json.dumps({"type": "auth_fail"}))
                    continue

                if not authed:
                    continue

                if mtype == "set":
                    key = msg.get("key")
                    value = msg.get("value")
                    if key is None:
                        continue
                    self.store[key] = value
                    save_store(self.store)
                    await self.broadcast(msg, exclude=ws)

                elif mtype == "remove":
                    key = msg.get("key")
                    if key in self.store:
                        del self.store[key]
                        save_store(self.store)
                    await self.broadcast(msg, exclude=ws)
        finally:
            self.clients.discard(ws)

    async def broadcast(self, msg: dict, exclude=None):
        if not self.clients:
            return
        data = json.dumps(msg)
        dead = []
        for c in self.clients:
            if c is exclude:
                continue
            try:
                await c.send(data)
            except Exception:
                dead.append(c)
        for c in dead:
            self.clients.discard(c)


def make_http_handler(html_path: Path, ip: str, ws_port: int, token: str):
    injected_config = (
        "<script>window.__LAN_SYNC_CONFIG__ = "
        + json.dumps({"host": ip, "port": ws_port, "token": token})
        + ";</script>"
    )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _serve_html(self):
            try:
                html = html_path.read_text(encoding="utf-8")
            except Exception as e:
                self.send_error(500, f"Could not read app file: {e}")
                return
            html = html.replace(CONFIG_PLACEHOLDER, injected_config, 1)
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _serve_sw(self):
            body = b"// no-op service worker\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _serve_manifest(self):
            manifest = {
                "name": "SteelTrack",
                "short_name": "SteelTrack",
                "start_url": "/",
                "display": "standalone",
                "background_color": "#0a0e17",
                "theme_color": "#0d1424",
            }
            body = json.dumps(manifest).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/manifest+json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html", "/app.html"):
                self._serve_html()
            elif path == "/sw.js":
                self._serve_sw()
            elif path == "/manifest.json":
                self._serve_manifest()
            else:
                self.send_error(404, "Not found")

    return Handler


def start_http_server(html_path: Path, ip: str, http_port: int, ws_port: int, token: str):
    handler = make_http_handler(html_path, ip, ws_port, token)
    httpd = ThreadingHTTPServer(("0.0.0.0", http_port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


async def main():
    parser = argparse.ArgumentParser(description="SteelTrack shared-server sync backend")
    parser.add_argument("--port", type=int, default=8765, help="Sync (WebSocket) port, default 8765")
    parser.add_argument("--http-port", type=int, default=8080, help="Web page port for phones/browsers, default 8080")
    args = parser.parse_args()

    token = load_or_create_token()
    ip = local_ip()
    html_path = find_app_html()

    sync = SyncServer(token)
    start_http_server(html_path, ip, args.http_port, args.port, token)

    async with websockets.serve(sync.handler, "0.0.0.0", args.port):
        print("=" * 64)
        print(" SteelTrack Server is running")
        print("=" * 64)
        print(f" Desktop app  -> Server Address: http://{ip}:{args.port}")
        print(f"                 Server Key    : {token}")
        print()
        print(f" Phone/tablet -> Open in a browser: http://{ip}:{args.http_port}/")
        print("                 (connects automatically, nothing to type)")
        print("=" * 64)
        print(f" Serving app file : {html_path.name}")
        print(f" Data file        : {DATA_FILE.name}")
        print(" Keep this window open. Press Ctrl+C to stop.\n")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
