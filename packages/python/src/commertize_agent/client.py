"""Read-only client for the public Commertize agent surface.

    MCP  POST {base_url}/mcp/public   work_board, work_task, passport_lookup, docs_search
    HTTP GET  {base_url}/work/v1/tasks

No key is needed. Taking or submitting a job is not open; those methods
refuse locally and never call the network. Standard library only.
"""

from __future__ import annotations

import itertools
import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable

DEFAULT_BASE_URL = "https://api.commertize.com"
MCP_PROTOCOL_VERSION = "2025-06-18"
READ_TOOLS = ("work_board", "work_task", "passport_lookup", "docs_search")
NOT_OPEN_MESSAGE = "Claiming tasks is not open."
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_BASE = re.compile(r"^(https://.+|http://(localhost|127\.0\.0\.1)(:\d+)?)$")

# (method, url, headers, body bytes or None, timeout) -> (status, body bytes)
Transport = Callable[[str, str, dict, "bytes | None", float], "tuple[int, bytes]"]


class CommertizeError(Exception):
    def __init__(self, message: str, status: int | None = None, code: int | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class NotOpenError(CommertizeError):
    def __init__(self) -> None:
        super().__init__(NOT_OPEN_MESSAGE)


def _urllib_transport(method, url, headers, body, timeout):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class CommertizeClient:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        transport: Transport | None = None,
        timeout: float = 15.0,
        user_agent: str = "commertize-agent-python",
    ) -> None:
        base = base_url.rstrip("/")
        if not _BASE.match(base):
            raise CommertizeError("base_url must be https (or http on localhost)")
        self.base_url = base
        self._t = transport or _urllib_transport
        self._timeout = timeout
        self._ua = user_agent
        self._ids = itertools.count(1)

    def _request(self, method: str, path: str, headers: dict | None = None, body: Any = None) -> Any:
        h = {"user-agent": self._ua, **(headers or {})}
        data = json.dumps(body).encode() if body is not None else None
        status, raw = self._t(method, self.base_url + path, h, data, self._timeout)
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            raise CommertizeError(f"non-JSON response (HTTP {status})", status) from None
        if not 200 <= status < 300:
            err = parsed.get("error") if isinstance(parsed, dict) else None
            msg = err.get("message") if isinstance(err, dict) else err
            raise CommertizeError(msg or f"HTTP {status}", status)
        return parsed

    def rpc(self, method: str, params: dict | None = None) -> Any:
        rid = next(self._ids)
        msg: dict = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        body = self._request(
            "POST",
            "/mcp/public",
            {
                "content-type": "application/json",
                "accept": "application/json, text/event-stream",
                "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            },
            msg,
        )
        if isinstance(body, dict) and body.get("error"):
            e = body["error"]
            raise CommertizeError(e.get("message", "error"), code=e.get("code"))
        if not isinstance(body, dict) or body.get("id") != rid:
            raise CommertizeError("response id does not match request")
        return body.get("result")

    def initialize(self) -> Any:
        return self.rpc(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "commertize-agent-python", "version": "0.1.0"},
            },
        )

    def list_tools(self) -> list[dict]:
        return self.rpc("tools/list")["tools"]

    def call_tool(self, name: str, arguments: dict | None = None) -> Any:
        if name not in READ_TOOLS:
            raise CommertizeError(f"not a read tool: {name}")
        r = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})
        if r.get("isError"):
            content = r.get("content") or [{}]
            raise CommertizeError(content[0].get("text", "tool error"))
        if "structuredContent" in r:
            return r["structuredContent"]
        for c in r.get("content") or []:
            if c.get("type") == "text":
                return json.loads(c["text"])
        return None

    def work_board(self) -> dict:
        return self._request("GET", "/work/v1/tasks")

    def work_task(self, task_id: str) -> dict:
        return self.call_tool("work_task", {"task_id": task_id})["task"]

    def passport_lookup(self, agent_address: str) -> dict:
        if not isinstance(agent_address, str) or not _ADDRESS.match(agent_address):
            raise CommertizeError("agent address must be 0x + 40 hex")
        return self.call_tool("passport_lookup", {"agent_address": agent_address})

    def docs_search(self, query: str) -> Any:
        return self.call_tool("docs_search", {"query": query})["results"]

    def take_job(self, task_id: str) -> None:
        """Not open. Refuses without a network call."""
        raise NotOpenError()

    def submit_job(self, task_id: str, submission: Any) -> None:
        """Not open. Refuses without a network call."""
        raise NotOpenError()
