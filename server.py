#!/usr/bin/env python3
"""Janela — servidor de sinalização (WebSocket) e arquivos estáticos.

O servidor apenas apresenta os dois lados um ao outro. O vídeo e o áudio
trafegam direto entre os navegadores (WebRTC, DTLS-SRTP) e o servidor
nunca tem acesso ao conteúdo. Mesmo que o servidor fosse malicioso, a
verificação por código (commit + SAS) feita no navegador detectaria a
interceptação.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import mimetypes
import os
import platform
import re
import secrets
import shutil
import socket
import sys
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path

import segno
from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
BIN = ROOT / "bin"

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # sem 0/O, 1/I/L
CODE_LEN = 6
MAX_VIEWERS = 8
MAX_ROOMS = 500
MAX_PENDING_PER_ROOM = 20
HOST_GRACE_SECONDS = 90
MAX_NAME = 32

DEFAULT_ICE = [
    {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
    {"urls": "stun:stun.cloudflare.com:3478"},
]

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; media-src 'self' blob: mediastream:; "
    "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)

# O registro do Windows às vezes mapeia .js como text/plain, o que quebra módulos ES.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")

log = logging.getLogger("janela")


# --------------------------------------------------------------------------- #
# Salas
# --------------------------------------------------------------------------- #


@dataclass
class Viewer:
    id: str
    ws: web.WebSocketResponse
    name: str
    approved: bool = False


@dataclass
class Room:
    code: str
    secret: str
    host: web.WebSocketResponse | None
    host_name: str
    viewers: dict[str, Viewer] = field(default_factory=dict)
    expiry: asyncio.TimerHandle | None = None


class Conn:
    __slots__ = ("ws", "role", "room", "viewer")

    def __init__(self, ws: web.WebSocketResponse):
        self.ws = ws
        self.role: str | None = None
        self.room: Room | None = None
        self.viewer: Viewer | None = None


async def send(ws: web.WebSocketResponse | None, payload: dict) -> None:
    if ws is None or ws.closed:
        return
    try:
        await ws.send_str(json.dumps(payload))
    except Exception:  # conexão caindo; o close handler resolve o resto
        pass


def clean_name(value, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    value = re.sub(r"[\x00-\x1f\x7f]", "", value).strip()
    return value[:MAX_NAME] or fallback


def normalize_code(value) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^A-Z0-9]", "", value.upper())[:CODE_LEN]


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    def _new_code(self) -> str:
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
            if code not in self.rooms:
                return code

    async def handle(self, conn: Conn, msg: dict) -> None:
        kind = msg.get("type")
        handler = getattr(self, f"on_{str(kind).replace('-', '_')}", None)
        if handler is None:
            return
        await handler(conn, msg)

    # ----- anfitrião -------------------------------------------------------- #

    async def on_create(self, conn: Conn, msg: dict) -> None:
        if conn.role:
            return
        if len(self.rooms) >= MAX_ROOMS:
            await send(conn.ws, {"type": "error", "code": "SERVER_FULL"})
            return
        room = Room(
            code=self._new_code(),
            secret=secrets.token_urlsafe(24),
            host=conn.ws,
            host_name=clean_name(msg.get("name"), "Anfitrião"),
        )
        self.rooms[room.code] = room
        conn.role, conn.room = "host", room
        log.info("sala %s criada", room.code)
        await send(conn.ws, {"type": "created", "code": room.code, "secret": room.secret})

    async def on_resume(self, conn: Conn, msg: dict) -> None:
        room = self.rooms.get(normalize_code(msg.get("code")))
        secret = msg.get("secret")
        if (
            conn.role
            or room is None
            or not isinstance(secret, str)
            or not secrets.compare_digest(secret, room.secret)
        ):
            await send(conn.ws, {"type": "resume-failed"})
            return
        if room.expiry:
            room.expiry.cancel()
            room.expiry = None
        old = room.host
        room.host = conn.ws
        conn.role, conn.room = "host", room
        if old is not None and old is not conn.ws and not old.closed:
            await old.close()
        await send(conn.ws, {"type": "resumed", "viewers": [v.id for v in room.viewers.values()]})
        # pedidos que chegaram enquanto o anfitrião estava fora
        for v in room.viewers.values():
            if not v.approved:
                await send(conn.ws, {"type": "join-request", "peerId": v.id, "name": v.name})

    def _host_room(self, conn: Conn) -> Room | None:
        if conn.role != "host" or conn.room is None or conn.room.host is not conn.ws:
            return None
        return conn.room

    async def on_approve(self, conn: Conn, msg: dict) -> None:
        room = self._host_room(conn)
        viewer = room and room.viewers.get(msg.get("peerId"))
        if viewer:
            viewer.approved = True
            await send(viewer.ws, {"type": "approved"})

    async def _drop_viewer(self, room: Room, peer_id, notice: str) -> None:
        viewer = room.viewers.pop(peer_id, None)
        if viewer:
            await send(viewer.ws, {"type": notice})
            await viewer.ws.close()

    async def on_reject(self, conn: Conn, msg: dict) -> None:
        room = self._host_room(conn)
        if room:
            await self._drop_viewer(room, msg.get("peerId"), "rejected")

    async def on_kick(self, conn: Conn, msg: dict) -> None:
        room = self._host_room(conn)
        if room:
            await self._drop_viewer(room, msg.get("peerId"), "kicked")

    async def on_close(self, conn: Conn, msg: dict) -> None:
        room = self._host_room(conn)
        if room:
            await self._close_room(room)
            conn.role, conn.room = None, None

    async def _close_room(self, room: Room) -> None:
        if self.rooms.get(room.code) is room:
            del self.rooms[room.code]
        if room.expiry:
            room.expiry.cancel()
        for viewer in list(room.viewers.values()):
            await send(viewer.ws, {"type": "room-closed"})
        room.viewers.clear()
        log.info("sala %s encerrada", room.code)

    # ----- espectador ------------------------------------------------------- #

    async def on_join(self, conn: Conn, msg: dict) -> None:
        if conn.role:
            return
        room = self.rooms.get(normalize_code(msg.get("code")))
        if room is None:
            await send(conn.ws, {"type": "error", "code": "ROOM_NOT_FOUND"})
            return
        if room.host is None:
            await send(conn.ws, {"type": "error", "code": "HOST_OFFLINE"})
            return
        approved = sum(1 for v in room.viewers.values() if v.approved)
        pending = len(room.viewers) - approved
        if approved >= MAX_VIEWERS or pending >= MAX_PENDING_PER_ROOM:
            await send(conn.ws, {"type": "error", "code": "ROOM_FULL"})
            return
        viewer = Viewer(id=secrets.token_hex(6), ws=conn.ws, name=clean_name(msg.get("name"), "Convidado"))
        room.viewers[viewer.id] = viewer
        conn.role, conn.room, conn.viewer = "viewer", room, viewer
        await send(conn.ws, {"type": "joined", "peerId": viewer.id, "hostName": room.host_name})
        await send(room.host, {"type": "join-request", "peerId": viewer.id, "name": viewer.name})

    # ----- repasse de sinalização (SDP / ICE) ------------------------------- #

    async def on_signal(self, conn: Conn, msg: dict) -> None:
        data = msg.get("data")
        if not isinstance(data, dict):
            return
        room = conn.room
        if room is None or self.rooms.get(room.code) is not room:
            return
        if conn.role == "host" and room.host is conn.ws:
            viewer = room.viewers.get(msg.get("to"))
            if viewer and viewer.approved:
                await send(viewer.ws, {"type": "signal", "from": "host", "data": data})
        elif conn.role == "viewer" and conn.viewer and conn.viewer.approved:
            if room.viewers.get(conn.viewer.id) is conn.viewer:
                await send(room.host, {"type": "signal", "from": conn.viewer.id, "data": data})

    # ----- desconexões ------------------------------------------------------ #

    async def disconnected(self, conn: Conn) -> None:
        room = conn.room
        if room is None or self.rooms.get(room.code) is not room:
            return
        if conn.role == "host" and room.host is conn.ws:
            room.host = None
            loop = asyncio.get_running_loop()
            room.expiry = loop.call_later(
                HOST_GRACE_SECONDS, lambda: asyncio.ensure_future(self._expire(room))
            )
        elif conn.role == "viewer" and conn.viewer:
            if room.viewers.get(conn.viewer.id) is conn.viewer:
                del room.viewers[conn.viewer.id]
                await send(room.host, {"type": "peer-left", "peerId": conn.viewer.id})

    async def _expire(self, room: Room) -> None:
        if room.host is None:
            await self._close_room(room)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


@dataclass
class State:
    port: int
    ice_servers: list
    lan_url: str
    public_url: str | None = None
    tunnel_status: str = "off"  # off | starting | ready | error


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=256 * 1024)
    await ws.prepare(request)
    hub: Hub = request.app["hub"]
    conn = Conn(ws)
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            if isinstance(data, dict):
                await hub.handle(conn, data)
    finally:
        await hub.disconnected(conn)
    return ws


async def api_config(request: web.Request) -> web.Response:
    st: State = request.app["state"]
    return web.json_response(
        {
            "iceServers": st.ice_servers,
            "publicUrl": st.public_url,
            "lanUrl": st.lan_url,
            "tunnel": st.tunnel_status,
            "maxViewers": MAX_VIEWERS,
        },
        headers={"Cache-Control": "no-store"},
    )


async def api_qr(request: web.Request) -> web.Response:
    text = request.query.get("text", "")
    if not text or len(text) > 300:
        raise web.HTTPBadRequest()
    svg = segno.make(text, error="m", micro=False).svg_inline(
        scale=8, border=2, dark="#0b0c10", light="#ffffff"
    )
    return web.Response(text=svg, content_type="image/svg+xml", headers={"Cache-Control": "no-store"})


async def static_handler(request: web.Request) -> web.StreamResponse:
    rel = request.match_info.get("path", "") or "index.html"
    target = (PUBLIC / rel).resolve()
    if not target.is_relative_to(PUBLIC) or not target.is_file():
        if "." in rel.rsplit("/", 1)[-1]:
            raise web.HTTPNotFound()
        target = PUBLIC / "index.html"
    return web.FileResponse(target, headers={"Cache-Control": "no-cache"})


@web.middleware
async def security_headers(request: web.Request, handler):
    resp = await handler(request)
    if not isinstance(resp, web.WebSocketResponse) and not resp.prepared:
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("Content-Security-Policy", CSP)
        resp.headers.setdefault(
            "Permissions-Policy", "display-capture=(self), fullscreen=(self), picture-in-picture=(self)"
        )
    return resp


# --------------------------------------------------------------------------- #
# Túnel público (Cloudflare Quick Tunnel — gratuito, sem conta)
# --------------------------------------------------------------------------- #


def cloudflared_asset() -> str | None:
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if sys.platform == "win32":
        return "cloudflared-windows-amd64.exe"
    if sys.platform.startswith("linux"):
        return "cloudflared-linux-arm64" if arm else "cloudflared-linux-amd64"
    return None  # macOS: brew install cloudflared


def find_cloudflared() -> Path | None:
    found = shutil.which("cloudflared")
    if found:
        return Path(found)
    local = BIN / ("cloudflared.exe" if sys.platform == "win32" else "cloudflared")
    return local if local.is_file() else None


def download_cloudflared() -> Path:
    asset = cloudflared_asset()
    if asset is None:
        raise RuntimeError("instale o cloudflared manualmente (ex.: brew install cloudflared)")
    BIN.mkdir(exist_ok=True)
    dest = BIN / ("cloudflared.exe" if sys.platform == "win32" else "cloudflared")
    part = dest.with_suffix(dest.suffix + ".part")
    url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}"
    print(f"  Baixando cloudflared (só na primeira vez)…\n  {url}")
    with urllib.request.urlopen(url, timeout=60) as resp, open(part, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(256 * 1024):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done * 100 // total:3d}%", end="", flush=True)
    print()
    part.replace(dest)
    if sys.platform != "win32":
        dest.chmod(0o755)
    return dest


async def run_tunnel(app: web.Application) -> None:
    st: State = app["state"]
    st.tunnel_status = "starting"
    proc = None
    try:
        exe = find_cloudflared() or await asyncio.to_thread(download_cloudflared)
        proc = await asyncio.create_subprocess_exec(
            str(exe), "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{st.port}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        app["tunnel_proc"] = proc
        pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode(errors="replace")
            m = pattern.search(line)
            if m and not st.public_url:
                st.public_url = m.group(0)
                st.tunnel_status = "ready"
                print(f"\n  Link público (internet):  {st.public_url}\n")
        await proc.wait()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # sem internet, download bloqueado etc.
        print(f"\n  [aviso] Túnel público indisponível: {exc}\n  Seguindo só na rede local.\n")
    finally:
        st.public_url = None
        st.tunnel_status = "error"
        if proc and proc.returncode is None:
            proc.terminate()


# --------------------------------------------------------------------------- #
# Inicialização
# --------------------------------------------------------------------------- #


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # não envia nada; só escolhe a interface
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def load_ice_servers() -> list:
    ice = list(DEFAULT_ICE)
    cfg = ROOT / "config.json"
    if cfg.is_file():
        try:
            extra = json.loads(cfg.read_text(encoding="utf-8")).get("iceServers", [])
            if isinstance(extra, list):
                ice.extend(extra)
                print(f"  config.json: {len(extra)} servidor(es) ICE/TURN adicionais")
        except (ValueError, OSError) as exc:
            print(f"  [aviso] config.json inválido: {exc}")
    return ice


def build_app(state: State, public: bool) -> web.Application:
    app = web.Application(middlewares=[security_headers])
    app["hub"] = Hub()
    app["state"] = state
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/config", api_config)
    app.router.add_get("/api/qr", api_qr)
    app.router.add_get("/{path:.*}", static_handler)

    if public:
        async def tunnel_ctx(app: web.Application):
            task = asyncio.create_task(run_tunnel(app))
            yield
            task.cancel()
            proc = app.get("tunnel_proc")
            if proc and proc.returncode is None:
                proc.terminate()

        app.cleanup_ctx.append(tunnel_ctx)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Janela — compartilhamento de tela P2P")
    parser.add_argument("--port", type=int, default=int(os.environ.get("JANELA_PORT", 8420)))
    parser.add_argument("--bind", default="0.0.0.0", help="interface de escuta (padrão: todas)")
    parser.add_argument("--public", action="store_true", help="cria um link público via Cloudflare Tunnel")
    parser.add_argument("--no-browser", action="store_true", help="não abrir o navegador")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="  %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)

    lan = f"http://{lan_ip()}:{args.port}"
    local = f"http://localhost:{args.port}"
    print("\n  ┌─────────────────────────────────────────────┐")
    print("  │  Janela — compartilhamento de tela          │")
    print("  └─────────────────────────────────────────────┘")
    state = State(port=args.port, ice_servers=load_ice_servers(), lan_url=lan)
    app = build_app(state, args.public)

    async def on_startup(_app: web.Application) -> None:
        print(f"  Abra para transmitir:     {local}")
        print(f"  Rede local (celular/PC):  {lan}")
        if args.public:
            print("  Gerando link público…")
        print("  Ctrl+C para encerrar.\n")
        if not args.no_browser:
            asyncio.get_running_loop().call_later(0.8, webbrowser.open, local)

    app.on_startup.append(on_startup)
    try:
        web.run_app(app, host=args.bind, port=args.port, print=None, access_log=None)
    except OSError as exc:
        print(f"\n  [erro] Não foi possível usar a porta {args.port}: {exc}")
        print("  Feche a outra instância ou use --port 8421.")
        sys.exit(1)


if __name__ == "__main__":
    main()
