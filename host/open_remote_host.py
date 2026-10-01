#!/usr/bin/env python3
"""Native messaging host for the Open Remote browser extension.

Chrome extensions cannot open raw TLS sockets, so this process speaks the
Android TV Remote protocol v2 (ports 6466/6467) on the extension's behalf.

Wire format (Chrome native messaging): each message is a 4-byte native-endian
length followed by UTF-8 JSON. Requests look like {"id": 1, "cmd": "...", ...}
and get a reply {"id": 1, "ok": true, "data": ...} or {"id": 1, "ok": false,
"error": "...", "code": "..."}. Unsolicited updates are {"event": "state", ...}.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import socket
import struct
import sys
import threading
from pathlib import Path
from typing import Any

from androidtvremote2 import AndroidTVRemote, CannotConnect, ConnectionClosed, InvalidAuth

SERVICE_TYPE = "_androidtvremote2._tcp.local."
SESSION_COMMANDS = {"connect", "disconnect", "pair_start", "pair_finish", "pair_cancel"}
CLIENT_NAME = f"Open Remote ({socket.gethostname().split('.')[0]})"


def data_dir() -> Path:
    system = platform.system()
    if override := os.environ.get("OPEN_REMOTE_DATA_DIR"):
        base = Path(override)
    elif system == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    elif system == "Windows":
        base = Path(os.environ.get("APPDATA", Path.home()))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    path = base / "OpenRemote"
    legacy = base / "ATVRemote"  # pre-rename folder; keeps existing pairings
    if not path.exists() and legacy.is_dir():
        legacy.rename(path)
    path.mkdir(parents=True, exist_ok=True)
    # Holds the client private key the TV trusts; keep it private to this user.
    if os.name == "posix":
        path.chmod(0o700)
    return path


DATA_DIR = data_dir()
CERT_FILE = str(DATA_DIR / "cert.pem")
KEY_FILE = str(DATA_DIR / "key.pem")

logging.basicConfig(
    filename=DATA_DIR / "host.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("open-remote")


async def ensure_cert(remote: AndroidTVRemote) -> bool:
    """Create the client certificate if needed; returns True if it was new."""
    created = await remote.async_generate_cert_if_missing()
    if os.name == "posix" and os.path.exists(KEY_FILE):
        os.chmod(KEY_FILE, 0o600)
    return created


class HostError(Exception):
    def __init__(self, message: str, code: str = "error") -> None:
        super().__init__(message)
        self.code = code


class NativeIO:
    """Blocking stdin reader on a thread, feeding an asyncio queue."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._write_lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self) -> None:
        stdin = sys.stdin.buffer
        while True:
            header = stdin.read(4)
            if len(header) < 4:
                break
            (length,) = struct.unpack("=I", header)
            body = stdin.read(length)
            try:
                msg = json.loads(body.decode("utf-8"))
            except ValueError:
                log.warning("Dropping malformed message")
                continue
            self.loop.call_soon_threadsafe(self.queue.put_nowait, msg)
        # Chrome closed the pipe: tell the main loop to exit.
        self.loop.call_soon_threadsafe(self.queue.put_nowait, None)

    def send(self, msg: dict[str, Any]) -> None:
        data = json.dumps(msg).encode("utf-8")
        with self._write_lock:
            sys.stdout.buffer.write(struct.pack("=I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()


class Host:
    def __init__(self, io: NativeIO) -> None:
        self.io = io
        self.remote: AndroidTVRemote | None = None
        self.pairing_remote: AndroidTVRemote | None = None
        self.available = False
        # connect / disconnect / pairing replace self.remote across awaits;
        # run them one at a time so a late connect can't revive a dropped session.
        self.session_lock = asyncio.Lock()

    # ---- state -----------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        r = self.remote
        return {
            "event": "state",
            "connected": bool(r and self.available),
            "host": r.host if r else None,
            "isOn": r.is_on if r else None,
            "currentApp": r.current_app if r else None,
            "volume": r.volume_info if r else None,
            "deviceInfo": r.device_info if r else None,
        }

    def push_state(self, *_: Any) -> None:
        self.io.send(self.snapshot())

    # ---- commands --------------------------------------------------------

    async def cmd_hello(self, _: dict[str, Any]) -> dict[str, Any]:
        return {"version": 1, "clientName": CLIENT_NAME, "dataDir": str(DATA_DIR)}

    async def cmd_discover(self, msg: dict[str, Any]) -> list[dict[str, Any]]:
        from zeroconf import ServiceStateChange
        from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

        timeout = float(msg.get("timeout", 3))
        found: dict[str, dict[str, Any]] = {}
        names: set[str] = set()

        def on_change(zeroconf: Any, service_type: str, name: str, state_change: Any) -> None:
            if state_change is ServiceStateChange.Added:
                names.add(name)

        azc = AsyncZeroconf()
        browser = AsyncServiceBrowser(azc.zeroconf, [SERVICE_TYPE], handlers=[on_change])
        try:
            await asyncio.sleep(timeout)
            for name in list(names):
                info = AsyncServiceInfo(SERVICE_TYPE, name)
                if not await info.async_request(azc.zeroconf, 1500):
                    continue
                addrs = info.parsed_addresses()
                ipv4 = [a for a in addrs if ":" not in a]
                if not (ipv4 or addrs):
                    continue
                host = (ipv4 or addrs)[0]
                label = name[: -len(SERVICE_TYPE) - 1] if name.endswith(SERVICE_TYPE) else name
                found[host] = {"name": label, "host": host, "port": info.port}
        finally:
            await browser.async_cancel()
            await azc.async_close()
        return list(found.values())

    def _new_remote(self, host: str) -> AndroidTVRemote:
        return AndroidTVRemote(CLIENT_NAME, CERT_FILE, KEY_FILE, host)

    async def cmd_pair_start(self, msg: dict[str, Any]) -> dict[str, Any]:
        host = _require(msg, "host")
        if self.pairing_remote:
            self.pairing_remote.disconnect()
        remote = self._new_remote(host)
        await ensure_cert(remote)
        try:
            name, mac = await asyncio.wait_for(remote.async_get_name_and_mac(), 6)
            await asyncio.wait_for(remote.async_start_pairing(), 10)
        except (CannotConnect, ConnectionClosed, asyncio.TimeoutError, OSError) as exc:
            remote.disconnect()
            raise HostError(f"Couldn't reach {host}. Is the TV on and on the same Wi-Fi?", "cannot_connect") from exc
        self.pairing_remote = remote
        return {"name": name, "mac": mac}

    async def cmd_pair_finish(self, msg: dict[str, Any]) -> dict[str, Any]:
        code = str(_require(msg, "code")).strip().upper()
        if not self.pairing_remote:
            raise HostError("Pairing session expired. Start again.", "pairing_expired")
        remote = self.pairing_remote
        try:
            await asyncio.wait_for(remote.async_finish_pairing(code), 10)
        except InvalidAuth as exc:
            # A wrong code leaves the session usable on most TVs, so keep it for a retry.
            raise HostError("Wrong code. Check the TV screen and try again.", "invalid_code") from exc
        except (ConnectionClosed, asyncio.TimeoutError) as exc:
            self.pairing_remote = None
            raise HostError("Pairing was cancelled on the TV or timed out.", "pairing_closed") from exc
        self.pairing_remote = None
        return {"paired": True}

    async def cmd_pair_cancel(self, _: dict[str, Any]) -> None:
        if self.pairing_remote:
            self.pairing_remote.disconnect()
            self.pairing_remote = None

    async def cmd_connect(self, msg: dict[str, Any]) -> dict[str, Any]:
        host = _require(msg, "host")
        if self.remote:
            self.remote.disconnect()
            self.remote = None
            self.available = False
        remote = self._new_remote(host)
        if await ensure_cert(remote):
            # A brand new certificate is never trusted by any TV yet.
            raise HostError("This TV needs to be paired first.", "needs_pairing")
        try:
            await asyncio.wait_for(remote.async_connect(), 10)
        except InvalidAuth as exc:
            remote.disconnect()
            raise HostError("This TV needs to be paired first.", "needs_pairing") from exc
        except (CannotConnect, ConnectionClosed, asyncio.TimeoutError, OSError) as exc:
            remote.disconnect()
            raise HostError(f"Couldn't connect to {host}. Is the TV on and on the same Wi-Fi?", "cannot_connect") from exc

        def on_available(available: bool) -> None:
            self.available = available
            self.push_state()

        def on_invalid_auth() -> None:
            self.available = False
            self.io.send({"event": "needs_pairing", "host": host})

        remote.add_is_on_updated_callback(self.push_state)
        remote.add_current_app_updated_callback(self.push_state)
        remote.add_volume_info_updated_callback(self.push_state)
        remote.add_is_available_updated_callback(on_available)
        remote.keep_reconnecting(on_invalid_auth)
        self.remote = remote
        self.available = True
        self.push_state()
        return self.snapshot()

    async def cmd_disconnect(self, _: dict[str, Any]) -> None:
        if self.remote:
            self.remote.disconnect()
            self.remote = None
        self.available = False
        self.push_state()

    async def cmd_state(self, _: dict[str, Any]) -> dict[str, Any]:
        return self.snapshot()

    def _connected(self) -> AndroidTVRemote:
        if not self.remote or not self.available:
            raise HostError("Not connected to a TV.", "not_connected")
        return self.remote

    async def cmd_key(self, msg: dict[str, Any]) -> None:
        remote = self._connected()
        try:
            remote.send_key_command(_require(msg, "key"), msg.get("direction", "SHORT"))
        except ValueError as exc:
            raise HostError(f"Unknown key: {msg.get('key')}", "bad_key") from exc
        except ConnectionClosed as exc:
            raise HostError("Connection to the TV was lost.", "not_connected") from exc

    async def cmd_text(self, msg: dict[str, Any]) -> None:
        remote = self._connected()
        text = str(msg.get("text", ""))
        try:
            if text:
                remote.send_text(text)
            else:
                remote.send_key_command("DEL")
        except ConnectionClosed as exc:
            raise HostError("Connection to the TV was lost.", "not_connected") from exc

    async def cmd_launch(self, msg: dict[str, Any]) -> None:
        remote = self._connected()
        try:
            remote.send_launch_app_command(_require(msg, "app"))
        except ConnectionClosed as exc:
            raise HostError("Connection to the TV was lost.", "not_connected") from exc

    # ---- dispatch --------------------------------------------------------

    async def handle(self, msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        cmd = msg.get("cmd", "")
        handler = getattr(self, f"cmd_{cmd}", None)
        try:
            if handler is None:
                raise HostError(f"Unknown command: {cmd}", "bad_command")
            if cmd in SESSION_COMMANDS:
                async with self.session_lock:
                    data = await handler(msg)
            else:
                data = await handler(msg)
            reply: dict[str, Any] = {"id": req_id, "ok": True, "data": data}
        except HostError as exc:
            reply = {"id": req_id, "ok": False, "error": str(exc), "code": exc.code}
        except Exception as exc:  # noqa: BLE001 - surface anything unexpected to the UI
            log.exception("Command %s failed", cmd)
            reply = {"id": req_id, "ok": False, "error": f"{type(exc).__name__}: {exc}", "code": "internal"}
        if req_id is not None:
            self.io.send(reply)

    def shutdown(self) -> None:
        for r in (self.remote, self.pairing_remote):
            if r:
                r.disconnect()


def _require(msg: dict[str, Any], key: str) -> Any:
    value = msg.get(key)
    if value in (None, ""):
        raise HostError(f"Missing '{key}'", "bad_request")
    return value


async def main() -> None:
    if sys.platform == "win32":
        import msvcrt

        # Native messaging frames are binary; stop Windows from rewriting \n.
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    loop = asyncio.get_running_loop()
    io = NativeIO(loop)
    host = Host(io)
    log.info("Host started, data dir %s", DATA_DIR)
    tasks: set[asyncio.Task[None]] = set()
    while True:
        msg = await io.queue.get()
        if msg is None:
            break
        task = loop.create_task(host.handle(msg))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    host.shutdown()
    log.info("Host exiting")


if __name__ == "__main__":
    asyncio.run(main())
