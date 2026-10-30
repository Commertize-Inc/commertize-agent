import hashlib
import json
import pathlib
import unittest
from datetime import datetime, timezone

from commertize_agent import (
    address_from_private_key,
    agent_message,
    body_digest,
    canonical_json,
    generate_passport_key,
    recover_address,
    sign_agent_request,
    sign_message,
)
from commertize_agent._crypto import keccak256

ROOT = pathlib.Path(__file__).resolve().parents[3]
V = json.loads((ROOT / "spec" / "vectors" / "signing.json").read_text())
KEY = "0x" + hashlib.sha256(V["privateKeySeed"].encode()).hexdigest()


class Vectors(unittest.TestCase):
    def test_keccak_known_answers(self):
        self.assertEqual(keccak256(b"").hex(), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(keccak256(b"abc").hex(), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
        # Exactly one rate block (136 bytes) forces a second, padding-only block.
        self.assertEqual(len(keccak256(b"a" * 136)), 32)
        self.assertNotEqual(keccak256(b"a" * 135), keccak256(b"a" * 136))

    def test_address_matches_backend(self):
        self.assertEqual(address_from_private_key(KEY), V["address"])

    def test_canonical_json_and_digest_match_backend(self):
        for c in V["canonical"]:
            self.assertEqual(canonical_json(c["input"]), c["json"])
            self.assertEqual(body_digest(c["input"]), hashlib.sha256(c["json"].encode()).hexdigest())

    def test_personal_sign_matches_ethers_exactly(self):
        for p in V["personalSign"]:
            self.assertEqual(sign_message(KEY, p["message"]), p["signature"])
            self.assertEqual(recover_address(p["message"], p["signature"]), V["address"])

    def test_agent_requests_match_backend(self):
        for r in V["agentRequests"]:
            s = sign_agent_request(
                KEY,
                mandate_id=r["mandateId"],
                action=r["action"],
                body=r["body"],
                nonce=r["nonce"],
                issued_at=r["issuedAt"],
            )
            # Equal signatures pin message, canonical request and body digest.
            self.assertEqual(s["signature"], r["signature"])
            self.assertEqual(s["message"], agent_message(s["request"]))
            self.assertTrue(s["message"].startswith("Commertize Agent Mandate request v0\n{"))
            self.assertEqual(s["request"]["bodySha256"], body_digest(r["body"]))
            self.assertEqual(recover_address(s["message"], r["signature"]), V["address"])


class Behaviour(unittest.TestCase):
    def test_fresh_key_round_trip_and_repr_hides_key(self):
        a, b = generate_passport_key(), generate_passport_key()
        self.assertNotEqual(a.private_key, b.private_key)
        self.assertRegex(a.address, r"^0x[0-9a-f]{40}$")
        self.assertEqual(recover_address("x", sign_message(a.private_key, "x")), a.address)
        self.assertNotIn(a.private_key[2:], repr(a))

    def test_canonical_matches_js_number_and_date_rules(self):
        self.assertEqual(canonical_json({"b": 1.0, "a": 2.5}), '{"a":2.5,"b":1}')
        d = datetime(2026, 10, 30, 16, 0, 0, 123456, tzinfo=timezone.utc)
        self.assertEqual(canonical_json(d), '"2026-10-30T16:00:00.123Z"')
        for bad in (float("inf"), float("nan"), datetime(2026, 1, 1), {1: "x"}, object()):
            with self.assertRaises(ValueError):
                canonical_json(bad)

    def test_refusals(self):
        for k in ("0x1234", "0x" + "0" * 64, "0x" + "f" * 64, 7):
            with self.assertRaises(ValueError):
                address_from_private_key(k)
        base = dict(mandate_id="m", body={}, issued_at="2026-10-30T00:00:00.000Z")
        with self.assertRaises(ValueError):
            sign_agent_request(KEY, action="transfer", **base)
        with self.assertRaises(ValueError):
            sign_agent_request(KEY, action="log.read", nonce="x" * 15, **base)
        self.assertTrue(sign_agent_request(KEY, action="log.read", nonce="x" * 16, **base))
        self.assertRegex(sign_agent_request(KEY, action="log.read", **base)["request"]["nonce"], r"^[0-9a-f]{32}$")
        sig = sign_message(KEY, "x")
        with self.assertRaises(ValueError):
            recover_address("x", sig[:-2] + "1d")
        with self.assertRaises(ValueError):
            recover_address("x", "0x" + "00" * 65)
        self.assertNotEqual(recover_address("y", sig), V["address"])

    def test_signatures_are_low_s(self):
        n_half = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 // 2
        for i in range(20):
            s = int(sign_message(KEY, f"m{i}")[66:130], 16)
            self.assertLessEqual(s, n_half)


if __name__ == "__main__":
    unittest.main()
