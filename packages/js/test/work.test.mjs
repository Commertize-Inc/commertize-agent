import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	CommertizeClient,
	NotOpenError,
	TEMPLATES,
	WorkInputError,
	buildSpec,
	checkTeam,
	declareTeamCalldata,
	invite,
	postTeamBondCalldata,
	recoverAddress,
	signTeamAcceptance,
	signWorkRequest,
	teamDigest,
	templates,
	workMessage,
} from "../dist/index.js";

const V = JSON.parse(readFileSync(new URL("../../../spec/vectors/work.json", import.meta.url), "utf8"));
const BANNED = (
	await import(new URL("../../../scripts/copy_guard.mjs", import.meta.url).href)
).BANNED;
const keyOf = (seed) => "0x" + createHash("sha256").update(seed, "utf8").digest("hex");
const KEY = keyOf(V.privateKeySeed);
const bodyOf = (r) =>
	r.deliverableSeed ? { ...r.body, deliverable_sha256: "0x" + createHash("sha256").update(r.deliverableSeed, "utf8").digest("hex") } : r.body;
const fields = (r) => ({ action: r.action, chainId: r.chainId, bodySha256: createHash("sha256").update(JSON.stringify(sortKeys(bodyOf(r))), "utf8").digest("hex"), nonce: r.nonce, issuedAt: r.issuedAt });

function fakeFetch(handler) {
	const calls = [];
	const f = async (url, init) => {
		calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
		const [status, body] = handler(calls.at(-1).body);
		return new Response(JSON.stringify(body), { status });
	};
	return { f, calls };
}
const answer = (result) => (b) => [200, { jsonrpc: "2.0", id: b.id, result }];

test("Work request signatures match the backend's vectors byte for byte", () => {
	for (const r of V.workRequests) {
		const s = signWorkRequest(KEY, {
			action: r.action,
			chainId: r.chainId,
			body: bodyOf(r),
			nonce: r.nonce,
			issuedAt: r.issuedAt,
		});
		assert.equal(s.signature, r.signature, r.tool);
		assert.equal(recoverAddress(workMessage(fields(r)), s.signature), V.address);
	}
	const m = V.workRequests[0];
	assert.equal(
		workMessage(fields(m)),
		"Commertize Work request v0\n" + JSON.stringify(sortKeys(fields(m)))
	);
});

test("hire builds exactly the backend vector's job_post body from template T4", async () => {
	const post = V.workRequests.find((r) => r.tool === "job_post");
	const { f, calls } = fakeFetch(answer({ structuredContent: post.result }));
	const c = new CommertizeClient({ fetch: f });
	const out = await c.hire(KEY, {
		parentJobId: 41,
		template: "T4",
		inputs: { question: post.body.spec.inputs.question },
		title: post.body.spec.title,
		usdcUnits: 5_000_000n,
		clientId: 7,
		providerId: "9",
		expiresAt: post.body.expires_at,
		reviewWindow: 3600,
	});
	assert.deepEqual(out, post.result);
	const args = calls[0].body.params.arguments;
	assert.equal(calls[0].body.params.name, "job_post");
	assert.deepEqual(args.body, post.body);
	assert.equal(recoverAddress(
		workMessage({ action: "job.post", chainId: 84532, bodySha256: createHash("sha256").update(JSON.stringify(sortKeys(args.body))).digest("hex"), nonce: args.nonce, issuedAt: args.issued_at }),
		args.signature
	), V.address);
});

function sortKeys(v) {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
	return v;
}

test("jobTake and jobSubmit send the tool name and body the backend vectors use", async () => {
	for (const r of V.workRequests.filter((x) => x.tool !== "job_post")) {
		const { f, calls } = fakeFetch(answer({ structuredContent: r.result }));
		const c = new CommertizeClient({ fetch: f });
		const out =
			r.tool === "job_take"
				? await c.jobTake(KEY, 12n, "5000000")
				: await c.jobSubmit(KEY, 3, bodyOf(r).deliverable_sha256.toUpperCase().replace("0X", "0x"));
		assert.deepEqual(out, r.result);
		assert.equal(calls[0].body.params.name, r.tool);
		assert.deepEqual(calls[0].body.params.arguments.body, bodyOf(r));
	}
});

test("a chain other than Base Sepolia is refused before any network call", async () => {
	const { f, calls } = fakeFetch(answer({}));
	const c = new CommertizeClient({ fetch: f });
	for (const chain of [8453, 1, 0])
		await assert.rejects(c.jobTake(KEY, 1, 1, chain), WorkInputError);
	assert.throws(() => signWorkRequest(KEY, { action: "job.take", chainId: 8453, body: {} }), WorkInputError);
	assert.throws(() => invite(1, 8453), WorkInputError);
	assert.equal(calls.length, 0);
});

test("a server with write tools off (Unknown tool) gives NotOpenError", async () => {
	const { f } = fakeFetch((b) => [200, { jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "Unknown tool: job_take" } }]);
	await assert.rejects(new CommertizeClient({ fetch: f }).jobTake(KEY, 1, 1), NotOpenError);
});

test("a tool error and a reply for another chain both throw", async () => {
	const e = fakeFetch(answer({ isError: true, content: [{ type: "text", text: "no active agent passport" }] }));
	await assert.rejects(new CommertizeClient({ fetch: e.f }).jobTake(KEY, 1, 1), /passport/);
	const other = { ...V.workRequests[0].result, tx: { ...V.workRequests[0].result.tx, chainId: 8453 } };
	const o = fakeFetch(answer({ structuredContent: other }));
	await assert.rejects(new CommertizeClient({ fetch: o.f }).jobTake(KEY, 1, 1), /another chain/);
});

test("bad ids, amounts and hashes are refused locally", async () => {
	const { f, calls } = fakeFetch(answer({}));
	const c = new CommertizeClient({ fetch: f });
	for (const [id, amt] of [[0, 1], [1, 0], ["1.5", 1], [-1, 1], [1, "abc"], [1.5, 1]])
		await assert.rejects(c.jobTake(KEY, id, amt), WorkInputError);
	await assert.rejects(c.jobSubmit(KEY, 1, "0x12"), WorkInputError);
	assert.equal(calls.length, 0);
});

test("templates: six presets plus T6 as hire; inputs are exact", () => {
	assert.deepEqual(templates.list().map((t) => t.id), ["T1", "T2", "T3", "T4", "T5", "T7"]);
	assert.deepEqual(
		Object.fromEntries(TEMPLATES.map((t) => [t.id, t.evaluator])),
		{ T1: "test_oracle", T2: "test_oracle", T3: "test_oracle", T4: "client", T5: "client", T7: "auto_delivery" }
	);
	assert.throws(() => templates.get("T6"), /hire/);
	assert.throws(() => templates.get("T9"), WorkInputError);
	assert.throws(() => buildSpec("T1", { sources: ["a"] }, { title: "x", usdcUnits: 1 }), /schema/);
	assert.throws(() => buildSpec("T4", { question: "q", extra: 1 }, { title: "x", usdcUnits: 1 }), /extra/);
	assert.throws(() => buildSpec("T4", { question: "q" }, { title: "", usdcUnits: 1 }), /title/);
	assert.throws(() => buildSpec("T4", { question: "q" }, { title: "x", usdcUnits: 0 }), /usdcUnits/);
	assert.ok(!TEMPLATES.some((t) => t.evaluator === "commertize"));
});

test("hire needs a parent job and a template other than T6", async () => {
	const { f, calls } = fakeFetch(answer({}));
	const c = new CommertizeClient({ fetch: f });
	const base = { template: "T4", inputs: { question: "q" }, title: "t", usdcUnits: 1, clientId: 1, providerId: 2, expiresAt: 2e9, reviewWindow: 3600 };
	await assert.rejects(c.hire(KEY, { ...base }), /parentJobId/);
	await assert.rejects(c.hire(KEY, { ...base, parentJobId: 5, template: "T6" }), /hire/);
	assert.equal(calls.length, 0);
});

test("invite carries only the job, the chain and install lines; copy guard clean", () => {
	const i = invite("12");
	assert.deepEqual(Object.keys(i).sort(), ["chain_id", "install", "job_id", "text"]);
	assert.deepEqual(Object.keys(i.install).sort(), ["npm", "pip"]);
	assert.equal(i.job_id, "12");
	assert.equal(i.chain_id, 84532);
	assert.doesNotMatch(JSON.stringify(i), BANNED);
	assert.doesNotMatch(JSON.stringify(i), /bonus|referr|credit|discount|rank|code/i);
	assert.throws(() => invite(0), WorkInputError);
});

test("team digest, member signatures and calldata match ethers and the backend vectors", () => {
	const t = V.team;
	const digest = teamDigest(t.domain, t.jobId, t.members);
	const sigs = t.memberKeySeeds.map((s) => signTeamAcceptance(keyOf(s), digest));
	assert.deepEqual(sigs, t.sigs);
	assert.equal(declareTeamCalldata(t.jobId, t.members, sigs), t.declareTeamCalldata);
	assert.equal(postTeamBondCalldata(t.jobId), t.postTeamBondCalldata);
});

test("checkTeam refuses what the contract refuses", () => {
	const m = (bps) => bps.map((b, i) => ({ agentId: i + 1, bps: b }));
	assert.doesNotThrow(() => checkTeam(m([5000, 5000])));
	assert.throws(() => checkTeam(m([10000])), /2-10/);
	assert.throws(() => checkTeam(m(Array(11).fill(0).map((_, i) => (i === 0 ? 10 : 999)))), /2-10/);
	assert.throws(() => checkTeam(m([5001, 4999])), /5000/);
	assert.throws(() => checkTeam(m([5000, 4999])), /sum/);
	assert.throws(() => checkTeam(m([5000, 5000, 0])), /bps/);
	assert.throws(() => checkTeam([{ agentId: 1, bps: 5000 }, { agentId: 1, bps: 5000 }]), /twice/);
	assert.throws(() => checkTeam(m([4000.5, 5999.5])), /bps/);
	const d = { ...V.team.domain, chainId: 8453 };
	assert.throws(() => teamDigest(d, 1, m([5000, 5000])), WorkInputError);
	assert.throws(() => declareTeamCalldata(1, m([5000, 5000]), ["0x" + "00".repeat(65)]), /one signature/);
});
