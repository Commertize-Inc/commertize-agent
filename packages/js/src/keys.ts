import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
	bytesToHex,
	concatBytes,
	hexToBytes,
	randomBytes,
	utf8ToBytes,
} from "@noble/hashes/utils";
import { bodyDigest, canonicalJson } from "./canonical.js";

/**
 * Passport keys. A Commertize agent passport binds one signing address; the
 * agent proves it holds the key with an EIP-191 signature over a canonical
 * request. The key never leaves the agent's machine and Commertize never
 * holds it.
 */

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

function keyBytes(privateKey: string): Uint8Array {
	if (!HEX_KEY.test(privateKey)) throw new Error("private key must be 32 bytes of hex");
	const b = hexToBytes(privateKey.replace(/^0x/, ""));
	if (!secp256k1.utils.isValidPrivateKey(b)) throw new Error("private key is out of range");
	return b;
}

export interface PassportKey {
	/** 0x-prefixed 32-byte hex. Store it like a password. */
	privateKey: string;
	/** Lowercase 0x address; this is what a passport binds. */
	address: string;
}

/** A fresh key from the platform's secure random source. */
export function generatePassportKey(): PassportKey {
	const sk = secp256k1.utils.randomPrivateKey();
	const privateKey = "0x" + bytesToHex(sk);
	return { privateKey, address: addressFromPrivateKey(privateKey) };
}

export function addressFromPrivateKey(privateKey: string): string {
	const pub = secp256k1.getPublicKey(keyBytes(privateKey), false);
	return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

/** EIP-191 personal_sign digest of a UTF-8 message. */
export function hashMessage(message: string): Uint8Array {
	const m = utf8ToBytes(message);
	return keccak_256(
		concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${m.length}`), m)
	);
}

/** EIP-191 signature, 0x + r(32) + s(32) + v(27|28), low-s. */
export function signMessage(privateKey: string, message: string): string {
	const sig = secp256k1.sign(hashMessage(message), keyBytes(privateKey), {
		lowS: true,
	});
	return "0x" + sig.toCompactHex() + (27 + sig.recovery).toString(16).padStart(2, "0");
}

/** Lowercase address that produced `signature` over `message`. */
export function recoverAddress(message: string, signature: string): string {
	if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("signature must be 65 bytes of hex");
	const raw = hexToBytes(signature.slice(2));
	const v = raw[64];
	if (v !== 27 && v !== 28) throw new Error("signature v must be 27 or 28");
	const sig = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(v - 27);
	const pub = sig.recoverPublicKey(hashMessage(message)).toRawBytes(false);
	return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

/** The request actions the backend accepts from an agent key. */
export const AGENT_ACTIONS = [
	"matches.list",
	"log.read",
	"execution.request",
	"execution.report_payment",
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export interface AgentRequest {
	mandateId: string;
	action: AgentAction;
	bodySha256: string;
	nonce: string;
	issuedAt: string;
}

const PREFIX = "Commertize Agent Mandate request v0\n";

export function agentMessage(req: AgentRequest): string {
	return PREFIX + canonicalJson(req);
}

/** A random nonce in the backend's accepted alphabet and length. */
export function newNonce(): string {
	return bytesToHex(randomBytes(16));
}

/**
 * Builds and signs one agent request. `issuedAt` defaults to now; the
 * backend refuses requests more than five minutes off its clock.
 */
export function signAgentRequest(
	privateKey: string,
	input: {
		mandateId: string;
		action: AgentAction;
		body: unknown;
		nonce?: string;
		issuedAt?: string;
	}
): { request: AgentRequest; message: string; signature: string } {
	if (!(AGENT_ACTIONS as readonly string[]).includes(input.action))
		throw new Error(`unknown action ${String(input.action)}`);
	const nonce = input.nonce ?? newNonce();
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error("nonce must be 16-128 of [A-Za-z0-9_-]");
	const request: AgentRequest = {
		mandateId: input.mandateId,
		action: input.action,
		bodySha256: bodyDigest(input.body),
		nonce,
		issuedAt: input.issuedAt ?? new Date().toISOString(),
	};
	const message = agentMessage(request);
	return { request, message, signature: signMessage(privateKey, message) };
}
