"""Keccak-256 and secp256k1 (RFC 6979, low-s, recoverable) in pure Python.

No third-party dependency, so ``pip install commertize-agent`` pulls nothing
else. Every output is pinned against the backend's own signatures in
spec/vectors/signing.json.

This code is NOT constant-time. It is fine for an agent signing its own
requests on its own machine. Do not run it where an attacker can time
signing operations on a shared host; use a hardware or OS key store there.
"""

from __future__ import annotations

import hashlib
import hmac

# ---------------------------------------------------------------- keccak-256

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
_M64 = (1 << 64) - 1


def _rol(x: int, n: int) -> int:
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _M64 if n else x


def _keccak_f(a: list[list[int]]) -> None:
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        a[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    """Ethereum Keccak-256 (original padding 0x01, not SHA3-256)."""
    rate = 136
    msg = bytearray(data)
    msg.append(0x01)
    while len(msg) % rate:
        msg.append(0)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off : off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i : 8 * i + 8], "little")
        _keccak_f(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


# ---------------------------------------------------------------- secp256k1

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        lam = 3 * x1 * x1 * pow(2 * y1, -1, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def _mul(k: int, pt=G):
    acc = None
    while k:
        if k & 1:
            acc = _add(acc, pt)
        pt = _add(pt, pt)
        k >>= 1
    return acc


def valid_private_key(d: int) -> bool:
    return 0 < d < N


def public_key(d: int) -> tuple[int, int]:
    if not valid_private_key(d):
        raise ValueError("private key is out of range")
    q = _mul(d)
    assert q is not None
    return q


def address_of(pub: tuple[int, int]) -> str:
    raw = pub[0].to_bytes(32, "big") + pub[1].to_bytes(32, "big")
    return "0x" + keccak256(raw)[-20:].hex()


class _Rfc6979:
    """RFC 6979 section 3.2 nonce source with HMAC-SHA256."""

    def __init__(self, d: int, h1: bytes) -> None:
        x = d.to_bytes(32, "big")
        h = (int.from_bytes(h1, "big") % N).to_bytes(32, "big")
        self.v = b"\x01" * 32
        self.k = b"\x00" * 32
        self.k = self._mac(self.v + b"\x00" + x + h)
        self.v = self._mac(self.v)
        self.k = self._mac(self.v + b"\x01" + x + h)
        self.v = self._mac(self.v)
        self.started = False

    def _mac(self, data: bytes) -> bytes:
        return hmac.new(self.k, data, hashlib.sha256).digest()

    def next_k(self) -> int:
        while True:
            if self.started:
                self.k = self._mac(self.v + b"\x00")
                self.v = self._mac(self.v)
            self.started = True
            self.v = self._mac(self.v)
            cand = int.from_bytes(self.v, "big")
            if 0 < cand < N:
                return cand


def sign_digest(d: int, digest: bytes) -> tuple[int, int, int]:
    """(r, s, recovery) with low-s, deterministic."""
    if len(digest) != 32:
        raise ValueError("digest must be 32 bytes")
    if not valid_private_key(d):
        raise ValueError("private key is out of range")
    e = int.from_bytes(digest, "big") % N
    nonces = _Rfc6979(d, digest)
    for _ in range(64):
        k = nonces.next_k()
        rp = _mul(k)
        assert rp is not None
        r = rp[0] % N
        if r == 0:
            continue
        s = pow(k, -1, N) * (e + r * d) % N
        if s == 0:
            continue
        rec = (rp[1] & 1) | (2 if rp[0] >= N else 0)
        if s > N // 2:
            s = N - s
            rec ^= 1
        return r, s, rec
    raise RuntimeError("no valid nonce in 64 attempts")


def recover(digest: bytes, r: int, s: int, rec: int) -> tuple[int, int]:
    if not (0 < r < N and 0 < s < N) or rec not in (0, 1):
        raise ValueError("invalid signature")
    x = r
    alpha = (pow(x, 3, P) + 7) % P
    beta = pow(alpha, (P + 1) // 4, P)
    if beta * beta % P != alpha:
        raise ValueError("invalid signature")
    y = beta if (beta & 1) == rec else P - beta
    e = int.from_bytes(digest, "big") % N
    rinv = pow(r, -1, N)
    q = _add(_mul(s * rinv % N, (x, y)), _mul((-e * rinv) % N))
    if q is None:
        raise ValueError("invalid signature")
    return q
