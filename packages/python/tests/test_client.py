import io
import json
import os
import stat
import tempfile
import unittest

from commertize_agent import READ_TOOLS, CommertizeClient, CommertizeError, NotOpenError, address_from_private_key
from commertize_agent.cli import main

BOARD = {"schema": "commertize.work.v1", "generated_at": None, "strings_ref": "r", "payouts_enabled": False, "tasks": []}


class Fake:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        b = json.loads(body) if body else None
        self.calls.append((method, url, headers, b))
        status, out = self.handler(b)
        return status, out if isinstance(out, bytes) else json.dumps(out).encode()


def rpc_ok(result):
    return lambda b: (200, {"jsonrpc": "2.0", "id": b["id"], "result": result})


class ClientTests(unittest.TestCase):
    def test_board_get(self):
        t = Fake(lambda b: (200, BOARD))
        self.assertEqual(CommertizeClient(transport=t).work_board(), BOARD)
        self.assertEqual(t.calls[0][:2], ("GET", "https://api.commertize.com/work/v1/tasks"))

    def test_tool_call_shape(self):
        t = Fake(rpc_ok({"structuredContent": {"available": False}}))
        CommertizeClient(transport=t).passport_lookup("0x" + "A" * 40)
        m, url, h, b = t.calls[0]
        self.assertEqual((m, url), ("POST", "https://api.commertize.com/mcp/public"))
        self.assertEqual(h["mcp-protocol-version"], "2025-06-18")
        self.assertEqual(b["params"], {"name": "passport_lookup", "arguments": {"agent_address": "0x" + "A" * 40}})

    def test_text_fallback(self):
        t = Fake(rpc_ok({"content": [{"type": "text", "text": json.dumps({"results": [1]})}]}))
        self.assertEqual(CommertizeClient(transport=t).docs_search("q"), [1])

    def test_errors(self):
        c = CommertizeClient(transport=Fake(rpc_ok({"isError": True, "content": [{"type": "text", "text": "no task"}]})))
        with self.assertRaisesRegex(CommertizeError, "no task"):
            c.work_task("t")
        c = CommertizeClient(transport=Fake(lambda b: (200, {"jsonrpc": "2.0", "id": b["id"], "error": {"code": -32601, "message": "Method not found"}})))
        with self.assertRaisesRegex(CommertizeError, "Method not found"):
            c.list_tools()
        c = CommertizeClient(transport=Fake(lambda b: (429, {"error": "rate_limited"})))
        with self.assertRaises(CommertizeError) as e:
            c.work_board()
        self.assertEqual(e.exception.status, 429)
        c = CommertizeClient(transport=Fake(lambda b: (200, {"jsonrpc": "2.0", "id": 999, "result": {}})))
        with self.assertRaisesRegex(CommertizeError, "id does not match"):
            c.list_tools()
        c = CommertizeClient(transport=Fake(lambda b: (404, b"<html>")))
        with self.assertRaisesRegex(CommertizeError, "non-JSON"):
            c.work_board()

    def test_local_refusals_make_no_calls(self):
        t = Fake(lambda b: (200, {}))
        c = CommertizeClient(transport=t)
        with self.assertRaisesRegex(CommertizeError, "not a read tool"):
            c.call_tool("job_take")
        with self.assertRaises(CommertizeError):
            c.passport_lookup("0x123")
        with self.assertRaises(NotOpenError):
            c.take_job("t")
        with self.assertRaisesRegex(NotOpenError, "Claiming tasks is not open."):
            c.submit_job("t", {})
        with self.assertRaises(CommertizeError):
            CommertizeClient("http://api.commertize.com")
        self.assertTrue(CommertizeClient("http://localhost"))
        self.assertEqual(t.calls, [])
        self.assertEqual(READ_TOOLS, ("work_board", "work_task", "passport_lookup", "docs_search"))


class CliTests(unittest.TestCase):
    def test_keygen_file_mode_no_print_no_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "key")
            out = io.StringIO()
            self.assertEqual(main(["keygen", "--out", p], out, io.StringIO()), 0)
            key = open(p).read().strip()
            self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
            self.assertEqual(json.loads(out.getvalue())["address"], address_from_private_key(key))
            self.assertNotIn(key[2:], out.getvalue())
            with open(p, "w") as f:
                f.write("keep\n")
            self.assertEqual(main(["keygen", "--out", p], io.StringIO(), io.StringIO()), 1)
            self.assertEqual(open(p).read(), "keep\n")
            self.assertEqual(main(["keygen"], io.StringIO(), io.StringIO()), 2)

    def test_take_submit_and_usage(self):
        err = io.StringIO()
        self.assertEqual(main(["submit"], io.StringIO(), err), 3)
        self.assertEqual(err.getvalue(), "Claiming tasks is not open.\n")
        self.assertEqual(main(["nope"], io.StringIO(), io.StringIO()), 2)


if __name__ == "__main__":
    unittest.main()
