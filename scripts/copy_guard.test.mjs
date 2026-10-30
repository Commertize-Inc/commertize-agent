import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BANNED, scan } from "./copy_guard.mjs";

test("the banned list catches each word and spares neighbours", () => {
	for (const s of ["CTZ", "an Airdrop", "the price", "Listings", "value", "earn", "earning", "yield"])
		assert.match(s, BANNED, s);
	for (const s of ["value_kind", "learn", "yearn", "ctzx", "spice"]) assert.doesNotMatch(s, BANNED, s);
});

test("launch-wording terms are caught as words, never inside code identifiers", () => {
	for (const s of [
		"not yet open",
		"Not Yet",
		"coming",
		"soon",
		"TGE",
		"early access",
		"points",
		"a point",
		"token",
		"Tokens",
		"rewards",
		"reward",
		"genesis",
		"currently",
		"accumulate",
		"accumulating",
		"pre-launch",
		"Pre-Launch",
		"tradable",
		"tradeable",
		"Add to wallet",
	])
		assert.match(s, BANNED, s);
	for (const s of [
		"accessToken",
		"token_id",
		"tokenize",
		"earlyExit",
		"comingSoon",
		"endpoints",
		"checkpoint",
		"yetAnother",
		"genesisBlock",
		"rewardsUrl",
		"id-token: write",
		"pre-genesis",
		"currentlyOpen",
		"accumulator",
		"prelaunchCheck",
		"tradableAssets",
	])
		assert.doesNotMatch(s, BANNED, s);
});

test("a planted word in any text file is reported, node_modules is skipped", () => {
	const d = mkdtempSync(path.join(tmpdir(), "guard-"));
	writeFileSync(path.join(d, "README.md"), "ok\nsee the price\n");
	mkdirSync(path.join(d, "node_modules"));
	writeFileSync(path.join(d, "node_modules", "x.md"), "airdrop\n");
	assert.deepEqual(scan(d), ["README.md:2: see the price"]);
});

test("this repository is clean", () => {
	assert.deepEqual(scan(), []);
});
