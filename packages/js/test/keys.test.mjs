import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	addressFromPrivateKey,
	agentMessage,
	bodyDigest,
	canonicalJson,
	generatePassportKey,
	recoverAddress,
	signAgentRequest,
	signMessage,
} from "../dist/index.js";

const V = JSON.parse(
	readFileSync(new URL("../../../spec/vectors/signing.json", import.meta.url), "utf8")
);

const KEY = "0x" + createHash("sha256").update(V.privateKeySeed, "utf8").digest("hex");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

test("address from the vector key matches the backend's", () => {
	assert.equal(addressFromPrivateKey(KEY), V.address);
});

test("canonical JSON and body digest match the backend byte for byte", () => {
	for (const c of V.canonical) {
		assert.equal(canonicalJson(c.input), c.json);
		assert.equal(bodyDigest(c.input), sha(c.json));
	}
});

test("EIP-191 signatures match ethers exactly (deterministic, low-s)", () => {
	for (const p of V.personalSign) {
		assert.equal(signMessage(KEY, p.message), p.signature);
		assert.equal(recoverAddress(p.message, p.signature), V.address);
	}
});

test("signed agent requests equal the backend's message and signature", () => {
	for (const r of V.agentRequests) {
		const s = signAgentRequest(KEY, {
			mandateId: r.mandateId,
			action: r.action,
			body: r.body,
			nonce: r.nonce,
			issuedAt: r.issuedAt,
		});
		// The backend's signature covers prefix + canonical request, which
		// covers the body digest: equal signatures pin all three.
		assert.equal(s.signature, r.signature);
		assert.equal(s.message, agentMessage(s.request));
		assert.ok(s.message.startsWith("Commertize Agent Mandate request v0\n{"));
		assert.equal(s.request.bodySha256, bodyDigest(r.body));
		assert.equal(recoverAddress(s.message, r.signature), V.address);
	}
});

test("a fresh key round-trips and differs each time", () => {
	const a = generatePassportKey();
	const b = generatePassportKey();
	assert.notEqual(a.privateKey, b.privateKey);
	assert.match(a.address, /^0x[0-9a-f]{40}$/);
	assert.equal(recoverAddress("x", signMessage(a.privateKey, "x")), a.address);
});

test("bad keys, actions, nonces and signatures are refused", () => {
	assert.throws(() => addressFromPrivateKey("0x1234"));
	assert.throws(() => addressFromPrivateKey("0x" + "0".repeat(64)));
	assert.throws(() => addressFromPrivateKey("0x" + "f".repeat(64)));
	const base = { mandateId: "m", body: {}, issuedAt: "2026-10-30T00:00:00.000Z" };
	assert.throws(() => signAgentRequest(KEY, { ...base, action: "transfer" }));
	assert.throws(() => signAgentRequest(KEY, { ...base, action: "log.read", nonce: "short" }));
	assert.throws(() => signAgentRequest(KEY, { ...base, action: "log.read", nonce: "x".repeat(15) }));
	assert.ok(signAgentRequest(KEY, { ...base, action: "log.read", nonce: "x".repeat(16) }));
	assert.match(signAgentRequest(KEY, { ...base, action: "log.read" }).request.nonce, /^[0-9a-f]{32}$/);
	assert.throws(() => recoverAddress("x", "0x" + "00".repeat(64)));
	const sig = signMessage(KEY, "x");
	assert.throws(() => recoverAddress("x", sig.slice(0, -2) + "1d"));
	assert.notEqual(recoverAddress("y", sig), V.address);
	assert.throws(() => canonicalJson({ a: Infinity }));
});
