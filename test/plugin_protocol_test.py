"""Protocol conformance test for the bridge, using only the standard library.

This mirrors exactly what the MaiBot plugin does on the wire, so it proves the
Python side of the contract (handshake frame, request framing, reply shape)
without needing the MaiBot SDK or a container.

Usage:  python3 test/plugin_protocol_test.py
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "bridge" / "dsh-bridge.mjs"
TOKEN = "protocol-test-token-0123456789"

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(name)


class BridgeClient:
    """The same wire dance the plugin performs."""

    def __init__(self, host: str, port: int, token: str, timeout: float = 30.0) -> None:
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._file = self.sock.makefile("rwb")
        self.token = token

    def handshake(self) -> dict:
        self._file.write((json.dumps({"token": self.token}) + "\n").encode())
        self._file.flush()
        return json.loads(self._file.readline().decode())

    def call(self, op: str, args: dict | None = None) -> dict:
        request_id = uuid.uuid4().hex
        payload = {"id": request_id, "op": op, "args": args or {}}
        self._file.write((json.dumps(payload) + "\n").encode())
        self._file.flush()
        return json.loads(self._file.readline().decode())

    def close(self) -> None:
        self._file.close()
        self.sock.close()


def main() -> int:
    env = {
        **os.environ,
        "DSH_BRIDGE_TOKEN": TOKEN,
        "DSH_BRIDGE_HOST": "127.0.0.1",
        "DSH_BRIDGE_PORT": "0",
    }
    # Bind an ephemeral port; read the real one back from the log line.
    host = "127.0.0.1"
    probe = socket.socket()
    probe.bind((host, 0))
    port = probe.getsockname()[1]
    probe.close()

    env["DSH_BRIDGE_PORT"] = str(port)
    proc = subprocess.Popen(
        ["node", str(BRIDGE)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        # Wait for the listener.
        deadline = time.time() + 15
        ready = False
        while time.time() < deadline:
            try:
                socket.create_connection((host, port), timeout=0.5).close()
                ready = True
                break
            except OSError:
                time.sleep(0.2)
        check("bridge starts and listens", ready)
        if not ready:
            return 1

        # 1. Wrong token is rejected.
        bad = BridgeClient(host, port, "wrong-token-value")
        reply = bad.handshake()
        check("wrong token rejected", reply.get("ok") is False and reply.get("error", {}).get("code") == "unauthorized")
        bad.close()

        # 2. Correct token is accepted, and then ping works.
        good = BridgeClient(host, port, TOKEN)
        reply = good.handshake()
        check("correct token accepted", reply.get("ok") is True)

        reply = good.call("ping")
        check("ping returns ok", reply.get("ok") is True, json.dumps(reply))
        check("ping echoes the agent command", "agentCommand" in (reply.get("value") or {}))

        # 3. Unknown op reports a stable code.
        reply = good.call("does_not_exist")
        check("unknown op rejected", reply.get("error", {}).get("code") == "unknown-op")

        # 4. Reply ids are echoed so concurrent work can be correlated.
        reply = good.call("ping")
        check("reply carries an id", isinstance(reply.get("id"), str))

        # 5. A session listing reaches the real agent (read-only; cheap enough).
        reply = good.call("sessions_list", {"cwd": "/tmp", "source": "agent"})
        if reply.get("ok"):
            sessions = reply["value"].get("sessions", [])
            check("sessions_list returns a list", isinstance(sessions, list), json.dumps(reply)[:200])
            check("sessions_list entries carry sessionId", all("sessionId" in s for s in sessions))
            check("sessions_list finds the dsh session store non-empty", len(sessions) > 0)
        else:
            check("sessions_list returns a list", False, json.dumps(reply)[:300])

        good.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        err = proc.stderr.read()
        if err.strip():
            print("bridge stderr:", err.strip()[:500])

    print()
    if failures:
        print(f"{len(failures)} 项失败: {', '.join(failures)}")
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
