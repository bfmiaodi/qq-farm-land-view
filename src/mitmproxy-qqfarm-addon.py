from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

from mitmproxy import ctx, websocket

TARGET_WS_HOST = "gate-obt.nqf.qq.com"
TARGET_WS_PATH = "/prod/ws"
POST_URL = os.environ.get("QQFARM_POST_URL", "http://127.0.0.1:18088/mitm/ws-frame")
TIMEOUT_SEC = float(os.environ.get("QQFARM_POST_TIMEOUT_SEC", "1.5"))
NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _frame_type(opcode: int) -> str:
    if opcode == websocket.Opcode.BINARY:
        return "binary"
    if opcode == websocket.Opcode.TEXT:
        return "text"
    return f"opcode-{opcode}"


def _direction(message: websocket.WebSocketMessage) -> str:
    if bool(getattr(message, "from_client", False)):
        return "client_to_server"
    return "server_to_client"


def _build_payload(flow, message: websocket.WebSocketMessage) -> dict:
    content = message.content or b""
    is_binary = message.type == websocket.Opcode.BINARY

    payload = {
        "url": flow.request.pretty_url,
        "direction": _direction(message),
        "opcode": int(message.type),
        "messageType": _frame_type(int(message.type)),
        "dropped": bool(message.dropped),
        "injected": bool(message.injected),
    }

    if is_binary:
        payload["base64"] = base64.b64encode(content).decode("ascii")
        payload["text"] = ""
    else:
        try:
            payload["text"] = content.decode("utf-8", errors="replace")
        except Exception:
            payload["text"] = ""
        payload["base64"] = ""

    return payload


def _is_target_flow(flow) -> bool:
    request = getattr(flow, "request", None)
    if not request:
        return False

    host = str(getattr(request, "host", "") or "")
    path = str(getattr(request, "path", "") or "")
    if host == TARGET_WS_HOST and path.startswith(TARGET_WS_PATH):
        return True
    # Windows side may tunnel the farm WSS by direct IP while keeping the same path/query.
    return path.startswith(TARGET_WS_PATH)


def _post_json(payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        POST_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # Do not inherit system proxy settings here, otherwise the local callback
    # request may be routed back into mitmproxy and deadlock on Windows.
    with NO_PROXY_OPENER.open(req, timeout=TIMEOUT_SEC) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"receiver returned HTTP {resp.status}")


def websocket_message(flow):
    if not flow.websocket:
        return

    url = flow.request.pretty_url
    if not _is_target_flow(flow):
        return

    message = flow.websocket.messages[-1]
    payload = _build_payload(flow, message)

    try:
        ctx.log.info(
            f"matched target ws host={flow.request.host} path={flow.request.path} "
            f"direction={_direction(message)} type={_frame_type(int(message.type))}"
        )
        _post_json(payload)
        ctx.log.info(
            f"forwarded {_direction(message)} {_frame_type(int(message.type))} "
            f"len={len(message.content or b'')} url={url}"
        )
    except (urllib.error.URLError, TimeoutError, RuntimeError) as error:
        ctx.log.warn(f"forward failed: {error}")
