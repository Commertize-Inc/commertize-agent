import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

type Canonical =
	| null
	| string
	| number
	| boolean
	| Canonical[]
	| { [k: string]: Canonical };

/**
 * Canonical JSON exactly as the Commertize backend computes it: object keys
 * sorted, undefined members dropped, Dates as ISO strings, bigints as decimal
 * strings, non-finite numbers refused. Pinned by spec/vectors/signing.json.
 */
export function canonicalJson(v: unknown): string {
	return JSON.stringify(normalize(v));
}

function normalize(v: unknown): Canonical {
	if (v === null || v === undefined) return null;
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "bigint") return v.toString();
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number");
		return v;
	}
	if (typeof v === "string" || typeof v === "boolean") return v;
	if (Array.isArray(v)) return v.map(normalize);
	if (typeof v === "object") {
		const o: { [k: string]: Canonical } = {};
		for (const k of Object.keys(v as object).sort()) {
			const x = (v as Record<string, unknown>)[k];
			if (x !== undefined) o[k] = normalize(x);
		}
		return o;
	}
	throw new Error(`canonicalJson: unsupported ${typeof v}`);
}

/** sha256 hex of the canonical JSON of a request body. */
export function bodyDigest(body: unknown): string {
	return bytesToHex(sha256(utf8ToBytes(canonicalJson(body))));
}
