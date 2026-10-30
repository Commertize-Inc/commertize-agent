import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CommertizeClient, NotOpenError, READ_TOOLS, addressFromPrivateKey } from "../dist/index.js";
import { main } from "../dist/cli.js";

const BOARD = {
	schema: "commertize.work.v1",
	generated_at: null,
	strings_ref: "ref",
	payouts_enabled: false,
	tasks: [],
};

function fakeFetch(handler) {
	const calls = [];
	const f = async (url, init) => {
		calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
		const [status, body] = handler(url, init, calls.at(-1).body);
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	};
	return { f, calls };
}

const rpcOk = (result) => (_u, _i, b) => [200, { jsonrpc: "2.0", id: b.id, result }];

test("workBoard GETs the board from the default https base", async () => {
	const { f, calls } = fakeFetch(() => [200, BOARD]);
	const c = new CommertizeClient({ fetch: f });
	assert.deepEqual(await c.workBoard(), BOARD);
	assert.equal(calls[0].url, "https://api.commertize.com/work/v1/tasks");
	assert.equal(calls[0].init.method, "GET");
});

test("tools are called over JSON-RPC at /mcp/public with the protocol header", async () => {
	const { f, calls } = fakeFetch(
		rpcOk({ structuredContent: { agent_address: "0x" + "a".repeat(40), available: false } })
	);
	const c = new CommertizeClient({ fetch: f });
	const r = await c.passportLookup("0x" + "A".repeat(40));
	assert.equal(r.available, false);
	assert.equal(calls[0].url, "https://api.commertize.com/mcp/public");
	assert.equal(calls[0].init.headers["mcp-protocol-version"], "2025-06-18");
	assert.deepEqual(calls[0].body.params, {
		name: "passport_lookup",
		arguments: { agent_address: "0x" + "A".repeat(40) },
	});
});

test("falls back to the text content when there is no structuredContent", async () => {
	const { f } = fakeFetch(
		rpcOk({ content: [{ type: "text", text: JSON.stringify({ results: [1] }) }] })
	);
	assert.deepEqual(await new CommertizeClient({ fetch: f }).docsSearch("q"), [1]);
});

test("tool errors, JSON-RPC errors, HTTP errors and id mismatches all throw", async () => {
	const tErr = fakeFetch(rpcOk({ isError: true, content: [{ type: "text", text: "no task" }] }));
	await assert.rejects(new CommertizeClient({ fetch: tErr.f }).workTask("t"), /no task/);
	const rErr = fakeFetch((_u, _i, b) => [200, { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } }]);
	await assert.rejects(new CommertizeClient({ fetch: rErr.f }).listTools(), /Method not found/);
	const http = fakeFetch(() => [429, { error: "rate_limited" }]);
	await assert.rejects(new CommertizeClient({ fetch: http.f }).workBoard(), (e) => e.status === 429);
	const idm = fakeFetch(() => [200, { jsonrpc: "2.0", id: 999, result: {} }]);
	await assert.rejects(new CommertizeClient({ fetch: idm.f }).listTools(), /id does not match/);
	const html = fakeFetch(() => [404, "<html>"]);
	await assert.rejects(new CommertizeClient({ fetch: html.f }).workBoard(), /non-JSON/);
});

test("refuses non-read tools, bad addresses and plain-http remote bases before any call", async () => {
	const { f, calls } = fakeFetch(() => [200, {}]);
	const c = new CommertizeClient({ fetch: f });
	await assert.rejects(c.callTool("job_take", {}), /not a read tool/);
	await assert.rejects(c.passportLookup("0x123"), /40 hex/);
	assert.throws(() => new CommertizeClient({ baseUrl: "http://api.commertize.com" }));
	assert.ok(new CommertizeClient({ baseUrl: "http://localhost" }));
	assert.equal(calls.length, 0);
	assert.deepEqual([...READ_TOOLS], ["work_board", "work_task", "passport_lookup", "docs_search"]);
});

test("take and submit are not open and never touch the network", async () => {
	const { f, calls } = fakeFetch(() => [200, {}]);
	const c = new CommertizeClient({ fetch: f });
	await assert.rejects(c.takeJob("t"), NotOpenError);
	await assert.rejects(c.submitJob("t", {}), (e) => e.message === "Claiming tasks is not open.");
	assert.equal(calls.length, 0);
});

function sink() {
	let s = "";
	return { write: (x) => ((s += x), true), get text() { return s; } };
}

test("cli keygen writes a 0600 key file, prints only the address, and never overwrites", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cmz-agent-"));
	const file = path.join(dir, "key");
	const out = sink();
	assert.equal(await main(["keygen", "--out", file], out, sink()), 0);
	const key = readFileSync(file, "utf8").trim();
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(JSON.parse(out.text).address, addressFromPrivateKey(key));
	assert.ok(!out.text.includes(key.slice(2)));
	writeFileSync(file, "keep\n");
	assert.equal(await main(["keygen", "--out", file], sink(), sink()), 1);
	assert.equal(readFileSync(file, "utf8"), "keep\n");
	assert.equal(await main(["keygen"], sink(), sink()), 2);
});

test("cli take/submit exit 3 with the not-open message; unknown command prints usage", async () => {
	const err = sink();
	assert.equal(await main(["take"], sink(), err), 3);
	assert.equal(err.text, "Claiming tasks is not open.\n");
	assert.equal(await main(["nope"], sink(), sink()), 2);
});
