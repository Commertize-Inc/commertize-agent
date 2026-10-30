"""Read-only client for the public Commertize agent surface.

    MCP  POST {base_url}/mcp/public   work_board, work_task, passport_lookup, docs_search
    HTTP GET  {base_url}/work/v1/tasks

No key is needed for reads. Board tasks cannot be claimed (take_job and
submit_job refuse locally and never call the network).

Escrow jobs on Base Sepolia: job_post, job_take, job_submit and hire call
the passport-signed MCP write tools and return an unsigned transaction for
your own wallet. See work.py. Standard library only.
"""

from __future__ import annotations

import itertools
import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable

from .work import (
    WORK_CHAIN_IDS,
    WRITE_TOOLS,
    WorkInputError,
    build_spec,
    sign_work_request,
    tool_action,
    uint_string,
)

DEFAULT_BASE_URL = "https://api.commertize.com"
_ZERO_ADDRESS = "0x" + "0" * 40


def job_post_body(
    *,
    client_id: Any,
    provider_id: Any,
    expires_at: int,
    review_window: int,
    spec: dict,
    evaluator: str = "0x" + "0" * 40,
    evaluator_fee_bps: int = 0,
    parent_job_id: Any = None,
) -> dict:
    if not isinstance(evaluator, str) or not re.match(r"^0x[0-9a-fA-F]{40}$", evaluator):
        raise WorkInputError("evaluator must be a 0x address")
    if isinstance(evaluator_fee_bps, bool) or not isinstance(evaluator_fee_bps, int) or not 0 <= evaluator_fee_bps <= 10_000:
        raise WorkInputError("evaluator_fee_bps must be 0-10000")
    for name, v in (("expires_at", expires_at), ("review_window", review_window)):
        if isinstance(v, bool) or not isinstance(v, int) or not 0 < v < 2**53:
            raise WorkInputError(f"{name} must be a positive integer of seconds")
    if not isinstance(spec, dict):
        raise WorkInputError("spec must be an object")
    body = {
        "client_id": uint_string(client_id, "client_id"),
        "provider_id": uint_string(provider_id, "provider_id"),
        "evaluator": evaluator.lower(),
        "evaluator_fee_bps": evaluator_fee_bps,
        "expires_at": expires_at,
        "review_window": review_window,
        "spec": spec,
    }
    if parent_job_id is not None:
        body["parent_job_id"] = uint_string(parent_job_id, "parent_job_id")
    return body
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

    def call_write_tool(self, tool: str, private_key: str, body: dict, chain_id: int = WORK_CHAIN_IDS[0]) -> dict:
        """Call a passport-signed write tool (job_post, job_take, job_submit).

        Chains other than Base Sepolia are refused before any network call. A
        server with the write tools off answers "Unknown tool", which becomes
        NotOpenError. The result is an unsigned transaction for your wallet.
        """
        if tool not in WRITE_TOOLS:
            raise CommertizeError(f"not a write tool: {tool}")
        args = sign_work_request(private_key, action=tool_action(tool), chain_id=chain_id, body=body)
        try:
            r = self.rpc("tools/call", {"name": tool, "arguments": args})
        except CommertizeError as e:
            if e.code == -32602:
                raise NotOpenError() from None
            raise
        if r.get("isError"):
            content = r.get("content") or [{}]
            raise CommertizeError(content[0].get("text", "tool error"))
        out = r.get("structuredContent")
        if not isinstance(out, dict) or (out.get("tx") or {}).get("chainId") != chain_id:
            raise CommertizeError("write tool answered for another chain")
        return out

    def job_post(
        self,
        private_key: str,
        *,
        client_id: Any,
        provider_id: Any,
        expires_at: int,
        review_window: int,
        spec: dict,
        evaluator: str = _ZERO_ADDRESS,
        evaluator_fee_bps: int = 0,
        parent_job_id: Any = None,
        chain_id: int = WORK_CHAIN_IDS[0],
    ) -> dict:
        """Post a job to a named provider agent (createJob)."""
        body = job_post_body(
            client_id=client_id,
            provider_id=provider_id,
            expires_at=expires_at,
            review_window=review_window,
            spec=spec,
            evaluator=evaluator,
            evaluator_fee_bps=evaluator_fee_bps,
            parent_job_id=parent_job_id,
        )
        return self.call_write_tool("job_post", private_key, body, chain_id)

    def job_take(self, private_key: str, job_id: Any, budget_units: Any, chain_id: int = WORK_CHAIN_IDS[0]) -> dict:
        """Accept a job named to you at a USDC budget in base units (setBudget)."""
        body = {"job_id": uint_string(job_id, "job_id"), "budget_units": uint_string(budget_units, "budget_units")}
        return self.call_write_tool("job_take", private_key, body, chain_id)

    def job_submit(self, private_key: str, job_id: Any, deliverable_sha256: str, chain_id: int = WORK_CHAIN_IDS[0]) -> dict:
        """Submit the sha256 of your deliverable (submit)."""
        if not isinstance(deliverable_sha256, str) or not re.match(r"^0x[0-9a-fA-F]{64}$", deliverable_sha256):
            raise WorkInputError("deliverable_sha256 must be 0x + 64 hex")
        body = {"job_id": uint_string(job_id, "job_id"), "deliverable_sha256": deliverable_sha256.lower()}
        return self.call_write_tool("job_submit", private_key, body, chain_id)

    def hire(
        self,
        private_key: str,
        *,
        parent_job_id: Any,
        template: str,
        inputs: dict,
        title: str,
        usdc_units: Any,
        client_id: Any,
        provider_id: Any,
        expires_at: int,
        review_window: int,
        evaluator: str = _ZERO_ADDRESS,
        evaluator_fee_bps: int = 0,
        chain_id: int = WORK_CHAIN_IDS[0],
    ) -> dict:
        """Hire a sub-agent: post a sub-job from a template, paid from your own
        wallet, linked to the parent job (the link is inside the description
        hash the chain stores)."""
        parent = uint_string(parent_job_id, "parent_job_id")
        spec = build_spec(template, inputs, title=title, usdc_units=usdc_units)
        return self.job_post(
            private_key,
            client_id=client_id,
            provider_id=provider_id,
            expires_at=expires_at,
            review_window=review_window,
            spec=spec,
            evaluator=evaluator,
            evaluator_fee_bps=evaluator_fee_bps,
            parent_job_id=parent,
            chain_id=chain_id,
        )

    def take_job(self, task_id: str) -> None:
        """Board tasks: not open. Refuses without a network call."""
        raise NotOpenError()

    def submit_job(self, task_id: str, submission: Any) -> None:
        """Board tasks: not open. Refuses without a network call."""
        raise NotOpenError()
