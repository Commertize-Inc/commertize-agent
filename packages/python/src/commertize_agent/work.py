"""Work: post a job, take it, submit, hire a sub-agent, form a team.

Nothing here holds funds. Every write goes through the passport-signed MCP
tools (job_post, job_take, job_submit). The server answers with an unsigned
transaction, and the agent's own wallet signs and sends it. Base Sepolia
(84532) only. Any other chain is refused locally, before any network call,
and the server refuses it as well. Mirrors packages/js/src/work.ts.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from . import _crypto
from .keys import _key_int, _normalize, body_digest, canonical_json, new_nonce, sign_message

WORK_CHAIN_IDS = (84532,)
WRITE_TOOLS = ("job_post", "job_take", "job_submit")
WORK_ACTIONS = ("job.post", "job.take", "job.submit")
_TOOL_ACTION = dict(zip(WRITE_TOOLS, WORK_ACTIONS))
_PREFIX = "Commertize Work request v0\n"
_UINT = re.compile(r"^[1-9][0-9]{0,77}$")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_B32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
_NONCE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_MAX_U256 = (1 << 256) - 1


class WorkInputError(ValueError):
    pass


def tool_action(tool: str) -> str:
    return _TOOL_ACTION[tool]


def assert_work_chain(chain_id: Any) -> None:
    if chain_id not in WORK_CHAIN_IDS:
        raise WorkInputError(f"chain {chain_id} is not open for Work writes (Base Sepolia 84532 only)")


def uint_string(v: Any, field: str) -> str:
    s = str(v) if isinstance(v, int) else v
    if not isinstance(s, str) or not _UINT.match(s) or int(s) > _MAX_U256:
        raise WorkInputError(f"{field} must be a positive integer")
    return s


def work_message(request: dict) -> str:
    return _PREFIX + canonical_json(request)


def sign_work_request(
    private_key: str,
    *,
    action: str,
    chain_id: int,
    body: dict,
    nonce: str | None = None,
    issued_at: str | None = None,
) -> dict:
    """Sign one Work request with the passport key: the arguments for a write tool."""
    if action not in WORK_ACTIONS:
        raise WorkInputError(f"unknown action {action!r}")
    assert_work_chain(chain_id)
    nonce = new_nonce() if nonce is None else nonce
    if not _NONCE.match(nonce):
        raise WorkInputError("nonce must be 16-128 of [A-Za-z0-9_-]")
    issued_at = issued_at or _normalize(datetime.now(timezone.utc))
    message = work_message(
        {
            "action": action,
            "chainId": chain_id,
            "bodySha256": body_digest(body),
            "nonce": nonce,
            "issuedAt": issued_at,
        }
    )
    return {"body": body, "nonce": nonce, "issued_at": issued_at, "signature": sign_message(private_key, message)}


# ----------------------------------------------------------------- templates

# T6 (delegation) is not a separate shape: it is hire(), a parent job posting
# one of these from its own wallet.
TEMPLATES = (
    {"id": "T1", "name": "Data collection", "evaluator": "test_oracle", "check": "schema and URL-200 checks", "inputs": ("sources", "schema"), "output": "CSV with citations"},
    {"id": "T2", "name": "Benchmark", "evaluator": "test_oracle", "check": "rerun of a 10% sample", "inputs": ("endpoint", "script_sha256"), "output": "signed results"},
    {"id": "T3", "name": "Code QA", "evaluator": "test_oracle", "check": "CI green", "inputs": ("repo", "commit"), "output": "pull request with tests"},
    {"id": "T4", "name": "Research brief", "evaluator": "client", "check": "client review", "inputs": ("question",), "output": "at most 800 words with sources"},
    {"id": "T5", "name": "Content cleanup", "evaluator": "client", "check": "client review", "inputs": ("file_url",), "output": "edited text"},
    {"id": "T7", "name": "Monitoring", "evaluator": "auto_delivery", "check": "delivery on schedule", "inputs": ("urls", "cadence"), "output": "diff log"},
)
DELEGATION_TEMPLATE_ID = "T6"


def templates_list() -> tuple:
    return TEMPLATES


def templates_get(template_id: str) -> dict:
    if template_id == DELEGATION_TEMPLATE_ID:
        raise WorkInputError("T6 is delegation: use hire() with one of T1-T5 or T7")
    for t in TEMPLATES:
        if t["id"] == template_id:
            return t
    raise WorkInputError(f"unknown template {template_id}")


def build_spec(template_id: str, inputs: dict, *, title: str, usdc_units: Any) -> dict:
    """A job spec from a template: every declared input is required, nothing else is accepted."""
    t = templates_get(template_id)
    for k in t["inputs"]:
        if inputs.get(k) in (None, ""):
            raise WorkInputError(f"{t['id']} needs {k}")
    for k in inputs:
        if k not in t["inputs"]:
            raise WorkInputError(f"{t['id']} does not take {k}")
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        raise WorkInputError("title must be 1-200 characters")
    return {
        "template": t["id"],
        "title": title,
        "evaluator_mode": t["evaluator"],
        "usdc_units": uint_string(usdc_units, "usdc_units"),
        "inputs": inputs,
    }


# -------------------------------------------------------------------- invite


def invite(job_id: Any, chain_id: int = WORK_CHAIN_IDS[0]) -> dict:
    """An invite for an agent that is not on Commertize yet.

    It names the job and how to install the SDK. It carries nothing else: no
    code, no referrer, nothing paid or counted for sending it.
    """
    jid = uint_string(job_id, "job_id")
    assert_work_chain(chain_id)
    return {
        "job_id": jid,
        "chain_id": chain_id,
        "install": {"npm": "npm install @commertize/agent", "pip": "pip install commertize-agent"},
        "text": (
            f"A paid USDC task is open for your agent: job {jid} on Base Sepolia (chain {chain_id}). "
            "Install the Commertize agent SDK, get an agent passport, then take the job with job_take."
        ),
    }


# --------------------------------------------------------------------- teams

TEAM_MAX_SIZE = 10
TEAM_LEAD_MAX_BPS = 5000
TEAM_TOTAL_BPS = 10_000
_TEAM_TYPE = b"TeamAcceptance(uint256 jobId,bytes32 membersHash,bytes32 splitHash,bytes32 statement)"
_TEAM_STATEMENT = "the same split applies to the job's USDC payment".encode()
_DOMAIN_TYPE = b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
_k = _crypto.keccak256


def _word(n: int) -> bytes:
    return n.to_bytes(32, "big")


def check_team(members: list) -> tuple[list[int], list[int]]:
    """Validate a team the way the contract does (see the JS twin)."""
    if not isinstance(members, (list, tuple)) or not 2 <= len(members) <= TEAM_MAX_SIZE:
        raise WorkInputError(f"a team has 2-{TEAM_MAX_SIZE} members")
    ids = [int(uint_string(m["agent_id"], f"members[{i}].agent_id")) for i, m in enumerate(members)]
    bps = []
    for i, m in enumerate(members):
        b = m["bps"]
        if isinstance(b, bool) or not isinstance(b, int) or not 0 < b <= TEAM_TOTAL_BPS:
            raise WorkInputError(f"members[{i}].bps must be an integer 1-10000")
        bps.append(b)
    if len(set(ids)) != len(ids):
        raise WorkInputError("a member appears twice")
    if bps[0] > TEAM_LEAD_MAX_BPS:
        raise WorkInputError("the lead's share is at most 5000 bps")
    if sum(bps) != TEAM_TOTAL_BPS:
        raise WorkInputError("shares must sum to 10000 bps")
    return ids, bps


def team_digest(domain: dict, job_id: Any, members: list) -> str:
    """The EIP-712 digest every member signs (the contract's teamDigest)."""
    if not isinstance(domain, dict) or not isinstance(domain.get("name"), str) or not isinstance(domain.get("version"), str) or not _ADDRESS.match(str(domain.get("verifyingContract", ""))):
        raise WorkInputError("domain needs name, version, chainId and verifyingContract")
    assert_work_chain(domain.get("chainId"))
    job = int(uint_string(job_id, "job_id"))
    ids, bps = check_team(members)
    struct = _k(
        _k(_TEAM_TYPE)
        + _word(job)
        + _k(b"".join(_word(i) for i in ids))
        + _k(b"".join(_word(b) for b in bps))
        + _k(_TEAM_STATEMENT)
    )
    sep = _k(
        _k(_DOMAIN_TYPE)
        + _k(domain["name"].encode())
        + _k(domain["version"].encode())
        + _word(domain["chainId"])
        + bytes(12)
        + bytes.fromhex(domain["verifyingContract"][2:])
    )
    return "0x" + _k(b"\x19\x01" + sep + struct).hex()


def sign_team_acceptance(private_key: str, digest: str) -> str:
    """One member's acceptance: a 65-byte signature over the team digest (no EIP-191 prefix)."""
    if not isinstance(digest, str) or not _B32.match(digest):
        raise WorkInputError("digest must be 32 bytes of hex")
    try:
        d = _key_int(private_key)
    except ValueError as e:
        raise WorkInputError(str(e)) from None
    r, s, rec = _crypto.sign_digest(d, bytes.fromhex(digest[2:]))
    return "0x" + r.to_bytes(32, "big").hex() + s.to_bytes(32, "big").hex() + f"{27 + rec:02x}"


def _selector(sig: str) -> bytes:
    return _k(sig.encode())[:4]


def declare_team_calldata(job_id: Any, members: list, sigs: list) -> str:
    """declareTeam(jobId, memberIds, splitBps, sigs), sent by the lead (the job's provider)."""
    job = int(uint_string(job_id, "job_id"))
    ids, bps = check_team(members)
    if not isinstance(sigs, (list, tuple)) or len(sigs) != len(ids):
        raise WorkInputError("one signature per member")
    raw = []
    for i, s in enumerate(sigs):
        if not isinstance(s, str) or not re.match(r"^0x[0-9a-fA-F]{130}$", s):
            raise WorkInputError(f"sigs[{i}] must be 65 bytes of hex")
        raw.append(bytes.fromhex(s[2:]))
    n = len(ids)
    a1 = _word(n) + b"".join(_word(i) for i in ids)
    a2 = _word(n) + b"".join(_word(b) for b in bps)
    items = [_word(len(b)) + b + bytes((32 - len(b) % 32) % 32) for b in raw]
    offs, at = [], 32 * n
    for it in items:
        offs.append(_word(at))
        at += len(it)
    a3 = _word(n) + b"".join(offs) + b"".join(items)
    o1 = 32 * 4
    o2 = o1 + len(a1)
    o3 = o2 + len(a2)
    out = _selector("declareTeam(uint256,uint256[],uint16[],bytes[])") + _word(job) + _word(o1) + _word(o2) + _word(o3) + a1 + a2 + a3
    return "0x" + out.hex()


def post_team_bond_calldata(job_id: Any) -> str:
    job = int(uint_string(job_id, "job_id"))
    return "0x" + (_selector("postTeamBond(uint256)") + _word(job)).hex()
