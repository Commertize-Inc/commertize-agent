import hashlib
import json
import pathlib
import re
import unittest

from commertize_agent import (
    TEMPLATES,
    CommertizeClient,
    NotOpenError,
    WorkInputError,
    body_digest,
    work_message,
    build_spec,
    check_team,
    declare_team_calldata,
    invite,
    post_team_bond_calldata,
    recover_address,
    sign_team_acceptance,
    sign_work_request,
    team_digest,
    templates_get,
    templates_list,
    uint_string,
    write_calldata,
    WORK_ESCROWS,
)

ROOT = pathlib.Path(__file__).resolve().parents[3]
V = json.loads((ROOT / "spec" / "vectors" / "work.json").read_text("utf-8"))
_guard = (ROOT / "scripts" / "copy_guard.mjs").read_text("utf-8")
# The JS regex, minus its JS-only lookbehind syntax differences (Python supports both).
BANNED = re.compile(re.search(r"export const BANNED =\s*/(.*)/i;", _guard).group(1), re.I)


def key_of(seed):
    return "0x" + hashlib.sha256(seed.encode("utf-8")).hexdigest()


KEY = key_of(V["privateKeySeed"])
PIN = {84532: V["escrow"]}


def body_of(r):
    if r.get("deliverableSeed"):
        return {**r["body"], "deliverable_sha256": "0x" + hashlib.sha256(r["deliverableSeed"].encode("utf-8")).hexdigest()}
    return r["body"]


class Fake:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        b = json.loads(body) if body else None
        self.calls.append(b)
        status, out = self.handler(b)
        return status, json.dumps(out).encode()


def answer(result):
    return lambda b: (200, {"jsonrpc": "2.0", "id": b["id"], "result": result})


class WorkSigning(unittest.TestCase):
    def test_vectors_byte_for_byte(self):
        for r in V["workRequests"]:
            s = sign_work_request(KEY, action=r["action"], chain_id=r["chainId"], body=body_of(r), nonce=r["nonce"], issued_at=r["issuedAt"])
            self.assertEqual(s["signature"], r["signature"], r["tool"])
            self.assertEqual(recover_address(work_message({"action": r["action"], "chainId": r["chainId"], "bodySha256": body_digest(body_of(r)), "nonce": r["nonce"], "issuedAt": r["issuedAt"]}), s["signature"]), V["address"])

    def test_other_chain_refused_without_network(self):
        t = Fake(answer({}))
        c = CommertizeClient(transport=t)
        for chain in (8453, 1, 0, True):
            with self.assertRaises(WorkInputError):
                c.job_take(KEY, 1, 1, chain)
        with self.assertRaises(WorkInputError):
            sign_work_request(KEY, action="job.take", chain_id=8453, body={})
        with self.assertRaises(WorkInputError):
            invite(1, 8453)
        self.assertEqual(t.calls, [])


class WorkClient(unittest.TestCase):
    def test_hire_builds_the_vector_body(self):
        post = next(r for r in V["workRequests"] if r["tool"] == "job_post")
        t = Fake(answer({"structuredContent": post["result"]}))
        out = CommertizeClient(transport=t, escrows=PIN).hire(
            KEY,
            parent_job_id=41,
            template="T4",
            inputs={"question": post["body"]["spec"]["inputs"]["question"]},
            title=post["body"]["spec"]["title"],
            usdc_units=5_000_000,
            client_id=7,
            provider_id="9",
            expires_at=post["body"]["expires_at"],
            review_window=259200,
        )
        self.assertEqual(out, post["result"])
        p = t.calls[0]["params"]
        self.assertEqual(p["name"], "job_post")
        self.assertEqual(p["arguments"]["body"], post["body"])

    def test_take_and_submit_bodies(self):
        for r in V["workRequests"]:
            if r["tool"] == "job_post":
                continue
            t = Fake(answer({"structuredContent": r["result"]}))
            c = CommertizeClient(transport=t, escrows=PIN)
            if r["tool"] == "job_take":
                out = c.job_take(KEY, 12, "5000000")
            else:
                out = c.job_submit(KEY, 3, "0x" + body_of(r)["deliverable_sha256"][2:].upper())
            self.assertEqual(out, r["result"])
            self.assertEqual(t.calls[0]["params"]["arguments"]["body"], body_of(r))

    def test_unknown_tool_is_not_open(self):
        t = Fake(lambda b: (200, {"jsonrpc": "2.0", "id": b["id"], "error": {"code": -32602, "message": "Unknown tool"}}))
        with self.assertRaises(NotOpenError):
            CommertizeClient(transport=t, escrows=PIN).job_take(KEY, 1, 1)

    def test_tool_error_and_other_chain_reply(self):
        t = Fake(answer({"isError": True, "content": [{"type": "text", "text": "no active agent passport"}]}))
        with self.assertRaisesRegex(Exception, "passport"):
            CommertizeClient(transport=t, escrows=PIN).job_take(KEY, 1, 1)
        other = dict(V["workRequests"][0]["result"])
        other["tx"] = dict(other["tx"], chainId=8453)
        t2 = Fake(answer({"structuredContent": other}))
        with self.assertRaisesRegex(Exception, "another chain"):
            CommertizeClient(transport=t2, escrows=PIN).job_take(KEY, 1, 1)

    def test_bad_inputs_refused_locally(self):
        t = Fake(answer({}))
        c = CommertizeClient(transport=t)
        for jid, amt in ((0, 1), (1, 0), ("1.5", 1), (-1, 1), (1, "abc"), (1.5, 1), (True, 1)):
            with self.assertRaises(WorkInputError):
                c.job_take(KEY, jid, amt)
        with self.assertRaises(WorkInputError):
            c.job_submit(KEY, 1, "0x12")
        base = dict(template="T4", inputs={"question": "q"}, title="t", usdc_units=1, client_id=1, provider_id=2, expires_at=2_000_000_000, review_window=3600)
        with self.assertRaises(WorkInputError):
            c.hire(KEY, parent_job_id=None, **base)
        with self.assertRaisesRegex(WorkInputError, "hire"):
            c.hire(KEY, parent_job_id=5, **dict(base, template="T6"))
        self.assertEqual(t.calls, [])


class Templates(unittest.TestCase):
    def test_presets(self):
        self.assertEqual([t["id"] for t in templates_list()], ["T1", "T2", "T3", "T4", "T5", "T7"])
        self.assertEqual(
            {t["id"]: t["evaluator"] for t in TEMPLATES},
            {"T1": "test_oracle", "T2": "test_oracle", "T3": "test_oracle", "T4": "client", "T5": "client", "T7": "auto_delivery"},
        )
        with self.assertRaisesRegex(WorkInputError, "hire"):
            templates_get("T6")
        with self.assertRaises(WorkInputError):
            templates_get("T9")
        with self.assertRaisesRegex(WorkInputError, "schema"):
            build_spec("T1", {"sources": ["a"]}, title="x", usdc_units=1)
        with self.assertRaisesRegex(WorkInputError, "extra"):
            build_spec("T4", {"question": "q", "extra": 1}, title="x", usdc_units=1)
        with self.assertRaisesRegex(WorkInputError, "title"):
            build_spec("T4", {"question": "q"}, title="", usdc_units=1)
        with self.assertRaisesRegex(WorkInputError, "usdc_units"):
            build_spec("T4", {"question": "q"}, title="x", usdc_units=0)

    def test_invite_has_no_reward(self):
        i = invite("12")
        self.assertEqual(sorted(i), ["chain_id", "install", "job_id", "text"])
        self.assertEqual(sorted(i["install"]), ["npm", "pip"])
        s = json.dumps(i)
        self.assertIsNone(BANNED.search(s))
        self.assertIsNone(re.search(r"bonus|referr|credit|discount|rank|code", s, re.I))
        self.assertEqual(i, {**i, "job_id": "12", "chain_id": 84532})


class Teams(unittest.TestCase):
    def test_vectors(self):
        t = V["team"]
        members = [{"agent_id": m["agentId"], "bps": m["bps"]} for m in t["members"]]
        digest = team_digest(t["domain"], t["jobId"], members)
        sigs = [sign_team_acceptance(key_of(s), digest) for s in t["memberKeySeeds"]]
        self.assertEqual(sigs, t["sigs"])
        self.assertEqual(declare_team_calldata(t["jobId"], members, sigs), t["declareTeamCalldata"])
        self.assertEqual(post_team_bond_calldata(t["jobId"]), t["postTeamBondCalldata"])

    def test_refusals(self):
        def m(bps):
            return [{"agent_id": i + 1, "bps": b} for i, b in enumerate(bps)]

        check_team(m([5000, 5000]))
        for bad, pat in (
            (m([10000]), "2-10"),
            (m([10] + [999] * 10), "2-10"),
            (m([5001, 4999]), "5000"),
            (m([5000, 4999]), "sum"),
            (m([5000, 5000, 0]), "bps"),
            ([{"agent_id": 1, "bps": 5000}, {"agent_id": 1, "bps": 5000}], "twice"),
            (m([4000.5, 5999.5]), "bps"),
        ):
            with self.assertRaisesRegex(WorkInputError, pat):
                check_team(bad)
        with self.assertRaises(WorkInputError):
            team_digest(dict(V["team"]["domain"], chainId=8453), 1, m([5000, 5000]))
        with self.assertRaisesRegex(WorkInputError, "one signature"):
            declare_team_calldata(1, m([5000, 5000]), ["0x" + "00" * 65])


if __name__ == "__main__":
    unittest.main()


def _reply(r, **over):
    return {**r["result"], "tx": {**r["result"]["tx"], **over}}


def _call(c, r):
    b = r["body"]
    if r["tool"] == "job_take":
        return c.job_take(KEY, b["job_id"], b["budget_units"])
    if r["tool"] == "job_submit":
        return c.job_submit(KEY, b["job_id"], body_of(r)["deliverable_sha256"])
    return c.job_post(
        KEY,
        client_id=b["client_id"],
        provider_id=b["provider_id"],
        evaluator=b["evaluator"],
        evaluator_fee_bps=b["evaluator_fee_bps"],
        expires_at=b["expires_at"],
        review_window=b["review_window"],
        spec=b["spec"],
        parent_job_id=b["parent_job_id"],
    )


class ReplyCheck(unittest.TestCase):
    """the reply is re-encoded locally and must match."""

    def test_local_calldata_equals_vectors(self):
        for r in V["workRequests"]:
            self.assertEqual(write_calldata(r["tool"], body_of(r)), r["result"]["tx"]["data"], r["tool"])

    def test_no_pin_refuses_before_network(self):
        self.assertIsNone(WORK_ESCROWS[84532])
        t = Fake(answer({"structuredContent": V["workRequests"][0]["result"]}))
        with self.assertRaisesRegex(WorkInputError, "escrow"):
            CommertizeClient(transport=t).job_take(KEY, 12, 5000000)
        with self.assertRaisesRegex(WorkInputError, "escrow"):
            CommertizeClient(transport=t, escrows={84532: "0x12"}).job_take(KEY, 12, 5000000)
        with self.assertRaisesRegex(WorkInputError, "escrow"):
            CommertizeClient(transport=t, escrows={84532: "0x" + "0" * 40}).job_take(KEY, 12, 5000000)
        self.assertEqual(t.calls, [])

    def test_wrong_to_refused_every_tool(self):
        for r in V["workRequests"]:
            t = Fake(answer({"structuredContent": _reply(r, to="0x" + "e6" * 20)}))
            with self.assertRaisesRegex(Exception, "does not match"):
                _call(CommertizeClient(transport=t, escrows=PIN), r)
            ok = Fake(answer({"structuredContent": _reply(r, to="0x" + r["result"]["tx"]["to"][2:].upper())}))
            self.assertTrue(_call(CommertizeClient(transport=ok, escrows=PIN), r))

    def test_wrong_data_refused_every_tool(self):
        approve = "0x095ea7b3" + V["escrow"][2:].rjust(64, "0") + "f" * 64
        for r in V["workRequests"]:
            d = r["result"]["tx"]["data"]
            for data in (approve, d[:-2] + "00", d + "00"):
                t = Fake(answer({"structuredContent": _reply(r, data=data)}))
                with self.assertRaisesRegex(Exception, "does not match"):
                    _call(CommertizeClient(transport=t, escrows=PIN), r)

    def test_description_hash_must_match(self):
        post = next(r for r in V["workRequests"] if r["tool"] == "job_post")
        bad = {**post["result"], "description_hash": "0x" + "00" * 32}
        t = Fake(answer({"structuredContent": bad}))
        with self.assertRaisesRegex(Exception, "does not match"):
            _call(CommertizeClient(transport=t, escrows=PIN), post)


class Uint256Bound(unittest.TestCase):
    """The uint256 upper bound."""

    def test_upper_bound(self):
        m = (1 << 256) - 1
        self.assertEqual(uint_string(m, "x"), str(m))
        self.assertEqual(uint_string(str(m), "x"), str(m))
        with self.assertRaises(WorkInputError):
            uint_string(m + 1, "x")
        with self.assertRaises(WorkInputError):
            uint_string(str(m + 1), "x")


class InviteCopy(unittest.TestCase):
    """The invite text is certified copy: pinned verbatim, same as the JS test."""

    def test_invite_text_verbatim(self):
        self.assertEqual(
            invite("12")["text"],
            "A test task is open for your agent: job 12 on Base Sepolia (chain 84532), a test network. "
            "Any USDC on it is test USDC, not real money. Install the Commertize agent SDK, get an agent "
            "passport, then take the job with job_take.",
        )
