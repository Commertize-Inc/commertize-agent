"""Passport keys and request signing.

A Commertize agent passport binds one signing address. The agent proves it
holds the key with an EIP-191 signature over a canonical request. The key
never leaves the agent's machine, and Commertize never holds it.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from . import _crypto

AGENT_ACTIONS = (
    "matches.list",
    "log.read",
    "execution.request",
    "execution.report_payment",
)
_PREFIX = "Commertize Agent Mandate request v0\n"
_HEX_KEY = re.compile(r"^(0x)?[0-9a-fA-F]{64}$")
_NONCE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_SIG = re.compile(r"^0x[0-9a-fA-F]{130}$")


def _normalize(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool) or isinstance(v, str):
        return v
    if isinstance(v, datetime):
        if v.tzinfo is None:
            raise ValueError("canonical_json: naive datetime")
        u = v.astimezone(timezone.utc)
        return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if not math.isfinite(v):
            raise ValueError("canonical_json: non-finite number")
        # JavaScript prints integral floats without ".0".
        return int(v) if v.is_integer() and abs(v) < 2**53 else v
    if isinstance(v, (list, tuple)):
        return [_normalize(x) for x in v]
    if isinstance(v, dict):
        out = {}
        for k in sorted(v.keys()):
            if not isinstance(k, str):
                raise ValueError("canonical_json: object keys must be strings")
            out[k] = _normalize(v[k])
        return out
    raise ValueError(f"canonical_json: unsupported {type(v).__name__}")


def canonical_json(v: Any) -> str:
    """Canonical JSON exactly as the Commertize backend computes it."""
    return json.dumps(_normalize(v), separators=(",", ":"), ensure_ascii=False)


def body_digest(body: Any) -> str:
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def _key_int(private_key: str) -> int:
    if not isinstance(private_key, str) or not _HEX_KEY.match(private_key):
        raise ValueError("private key must be 32 bytes of hex")
    d = int(private_key.removeprefix("0x"), 16)
    if not _crypto.valid_private_key(d):
        raise ValueError("private key is out of range")
    return d


@dataclass(frozen=True)
class PassportKey:
    private_key: str
    """0x-prefixed 32-byte hex. Store it like a password."""
    address: str
    """Lowercase 0x address; this is what a passport binds."""

    def __repr__(self) -> str:  # never print the key by accident
        return f"PassportKey(address={self.address!r})"


def address_from_private_key(private_key: str) -> str:
    return _crypto.address_of(_crypto.public_key(_key_int(private_key)))


def generate_passport_key() -> PassportKey:
    while True:
        d = secrets.randbits(256)
        if _crypto.valid_private_key(d):
            break
    pk = "0x" + d.to_bytes(32, "big").hex()
    return PassportKey(private_key=pk, address=address_from_private_key(pk))


def hash_message(message: str) -> bytes:
    m = message.encode("utf-8")
    return _crypto.keccak256(b"\x19Ethereum Signed Message:\n" + str(len(m)).encode() + m)


def sign_message(private_key: str, message: str) -> str:
    """EIP-191 signature: 0x + r + s + v (27/28), low-s, deterministic."""
    r, s, rec = _crypto.sign_digest(_key_int(private_key), hash_message(message))
    return "0x" + r.to_bytes(32, "big").hex() + s.to_bytes(32, "big").hex() + f"{27 + rec:02x}"


def recover_address(message: str, signature: str) -> str:
    if not isinstance(signature, str) or not _SIG.match(signature):
        raise ValueError("signature must be 65 bytes of hex")
    raw = bytes.fromhex(signature[2:])
    v = raw[64]
    if v not in (27, 28):
        raise ValueError("signature v must be 27 or 28")
    pub = _crypto.recover(
        hash_message(message), int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:64], "big"), v - 27
    )
    return _crypto.address_of(pub)


def agent_message(request: dict) -> str:
    return _PREFIX + canonical_json(request)


def new_nonce() -> str:
    return secrets.token_hex(16)


def _now_iso() -> str:
    return _normalize(datetime.now(timezone.utc))


def sign_agent_request(
    private_key: str,
    *,
    mandate_id: str,
    action: str,
    body: Any,
    nonce: str | None = None,
    issued_at: str | None = None,
) -> dict:
    """Build and sign one agent request. Returns request, message, signature.

    The backend refuses a request more than five minutes off its clock.
    """
    if action not in AGENT_ACTIONS:
        raise ValueError(f"unknown action {action!r}")
    nonce = new_nonce() if nonce is None else nonce
    if not _NONCE.match(nonce):
        raise ValueError("nonce must be 16-128 of [A-Za-z0-9_-]")
    request = {
        "mandateId": mandate_id,
        "action": action,
        "bodySha256": body_digest(body),
        "nonce": nonce,
        "issuedAt": issued_at or _now_iso(),
    }
    message = agent_message(request)
    return {"request": request, "message": message, "signature": sign_message(private_key, message)}
