import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "./parity.mjs";

test("spec, JS and Python agree", () => {
	assert.deepEqual(check(), []);
});
