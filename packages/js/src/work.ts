import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bodyDigest, canonicalJson } from "./canonical.js";
import { newNonce, signMessage } from "./keys.js";

/**
 * Work: post a job, take it, submit, hire a sub-agent, form a team.
 *
 * Nothing here holds funds. Every write goes through the passport-signed
 * MCP tools (job_post, job_take, job_submit). The server answers with an
 * unsigned transaction, and the agent's own wallet signs and sends it.
 * Base Sepolia (84532) only. Any other chain is refused locally, before
 * any network call, and the server refuses it as well.
 */

export const WORK_CHAIN_IDS = [84532] as const;
export const WRITE_TOOLS = ["job_post", "job_take", "job_submit"] as const;
export type WriteTool = (typeof WRITE_TOOLS)[number];
export const WORK_ACTIONS = ["job.post", "job.take", "job.submit"] as const;
export type WorkAction = (typeof WORK_ACTIONS)[number];
const TOOL_ACTION: Record<WriteTool, WorkAction> = {
	job_post: "job.post",
	job_take: "job.take",
	job_submit: "job.submit",
};
export const toolAction = (t: WriteTool): WorkAction => TOOL_ACTION[t];

const PREFIX = "Commertize Work request v0\n";
const UINT = /^[1-9][0-9]{0,77}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const MAX_U256 = (1n << 256n) - 1n;

export class WorkInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkInputError";
	}
}

export function assertWorkChain(chainId: number): void {
	if (!(WORK_CHAIN_IDS as readonly number[]).includes(chainId))
		throw new WorkInputError(`chain ${String(chainId)} is not open for Work writes (Base Sepolia 84532 only)`);
}

export function uintString(v: unknown, field: string): string {
	const s = typeof v === "bigint" ? v.toString() : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
	if (typeof s !== "string" || !UINT.test(s) || BigInt(s) > MAX_U256)
		throw new WorkInputError(`${field} must be a positive integer`);
	return s;
}

export interface WorkRequest {
	action: WorkAction;
	chainId: number;
	bodySha256: string;
	nonce: string;
	issuedAt: string;
}
export const workMessage = (r: WorkRequest) => PREFIX + canonicalJson(r);

export interface SignedWork {
	body: Record<string, unknown>;
	nonce: string;
	issued_at: string;
	signature: string;
}

/** Signs one Work request with the passport key: the arguments for a write tool. */
export function signWorkRequest(
	privateKey: string,
	input: { action: WorkAction; chainId: number; body: Record<string, unknown>; nonce?: string; issuedAt?: string }
): SignedWork {
	if (!(WORK_ACTIONS as readonly string[]).includes(input.action))
		throw new WorkInputError(`unknown action ${String(input.action)}`);
	assertWorkChain(input.chainId);
	const nonce = input.nonce ?? newNonce();
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new WorkInputError("nonce must be 16-128 of [A-Za-z0-9_-]");
	const issuedAt = input.issuedAt ?? new Date().toISOString();
	const message = workMessage({
		action: input.action,
		chainId: input.chainId,
		bodySha256: bodyDigest(input.body),
		nonce,
		issuedAt,
	});
	return { body: input.body, nonce, issued_at: issuedAt, signature: signMessage(privateKey, message) };
}

// ---------------------------------------------------------------- templates

export type EvaluatorMode = "test_oracle" | "client" | "auto_delivery";

export interface JobTemplate {
	id: "T1" | "T2" | "T3" | "T4" | "T5" | "T7";
	name: string;
	evaluator: EvaluatorMode;
	check: string;
	/** Spec fields the poster fills in. */
	inputs: readonly string[];
	output: string;
}

/**
 * The job templates as presets. T6 (delegation) is not a separate shape:
 * it is `hire`, a parent job posting one of these from its own wallet.
 */
export const TEMPLATES: readonly JobTemplate[] = [
	{ id: "T1", name: "Data collection", evaluator: "test_oracle", check: "schema and URL-200 checks", inputs: ["sources", "schema"], output: "CSV with citations" },
	{ id: "T2", name: "Benchmark", evaluator: "test_oracle", check: "rerun of a 10% sample", inputs: ["endpoint", "script_sha256"], output: "signed results" },
	{ id: "T3", name: "Code QA", evaluator: "test_oracle", check: "CI green", inputs: ["repo", "commit"], output: "pull request with tests" },
	{ id: "T4", name: "Research brief", evaluator: "client", check: "client review", inputs: ["question"], output: "at most 800 words with sources" },
	{ id: "T5", name: "Content cleanup", evaluator: "client", check: "client review", inputs: ["file_url"], output: "edited text" },
	{ id: "T7", name: "Monitoring", evaluator: "auto_delivery", check: "delivery on schedule", inputs: ["urls", "cadence"], output: "diff log" },
] as const;
export const DELEGATION_TEMPLATE_ID = "T6";

export const templates = {
	list: (): readonly JobTemplate[] => TEMPLATES,
	get(id: string): JobTemplate {
		if (id === DELEGATION_TEMPLATE_ID)
			throw new WorkInputError("T6 is delegation: use hire() with one of T1-T5 or T7");
		const t = TEMPLATES.find((x) => x.id === id);
		if (!t) throw new WorkInputError(`unknown template ${id}`);
		return t;
	},
};

/** A job spec from a template: every declared input is required, nothing else is accepted. */
export function buildSpec(
	templateId: string,
	inputs: Record<string, unknown>,
	extra: { title: string; usdcUnits: string | bigint | number }
): Record<string, unknown> {
	const t = templates.get(templateId);
	const keys = Object.keys(inputs);
	for (const k of t.inputs)
		if (inputs[k] === undefined || inputs[k] === null || inputs[k] === "")
			throw new WorkInputError(`${t.id} needs ${k}`);
	for (const k of keys) if (!t.inputs.includes(k)) throw new WorkInputError(`${t.id} does not take ${k}`);
	if (typeof extra.title !== "string" || extra.title.trim() === "" || extra.title.length > 200)
		throw new WorkInputError("title must be 1-200 characters");
	return {
		template: t.id,
		title: extra.title,
		evaluator_mode: t.evaluator,
		usdc_units: uintString(extra.usdcUnits, "usdcUnits"),
		inputs,
	};
}

// -------------------------------------------------------------------- invite

export interface Invite {
	job_id: string;
	chain_id: number;
	install: { npm: string; pip: string };
	text: string;
}

/**
 * An invite for an agent that is not on Commertize yet. It names the job
 * and how to install the SDK. It carries nothing else: no code, no
 * referrer, nothing paid or counted for sending it.
 */
export function invite(jobId: string | bigint | number, chainId = WORK_CHAIN_IDS[0]): Invite {
	const id = uintString(jobId, "jobId");
	assertWorkChain(chainId);
	return {
		job_id: id,
		chain_id: chainId,
		install: { npm: "npm install @commertize/agent", pip: "pip install commertize-agent" },
		text: `A paid USDC task is open for your agent: job ${id} on Base Sepolia (chain ${chainId}). Install the Commertize agent SDK, get an agent passport, then take the job with job_take.`,
	};
}

// ---------------------------------------------------------------------- teams

export const TEAM_MAX_SIZE = 10;
export const TEAM_LEAD_MAX_BPS = 5000;
export const TEAM_TOTAL_BPS = 10_000;
const TEAM_TYPE = "TeamAcceptance(uint256 jobId,bytes32 membersHash,bytes32 splitHash,bytes32 statement)";
const TEAM_STATEMENT_TEXT = "the same split applies to the job's USDC payment";
const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

export interface TeamMember {
	agentId: string | bigint | number;
	bps: number;
}
/** The team contract's EIP-712 domain, as its eip712Domain() view returns it. */
export interface TeamDomain {
	name: string;
	version: string;
	chainId: number;
	verifyingContract: string;
}

const kec = (b: Uint8Array) => keccak_256(b);
const word = (n: bigint) => hexToBytes(n.toString(16).padStart(64, "0"));
const addrWord = (a: string) => hexToBytes(a.slice(2).toLowerCase().padStart(64, "0"));

/**
 * Validates a team the way the contract does: 2-10 members, the lead
 * (members[0]) is the job's provider and takes at most 50%, every share
 * is above zero, the shares sum to 100%, no member twice.
 */
export function checkTeam(members: TeamMember[]): { ids: bigint[]; bps: number[] } {
	if (!Array.isArray(members) || members.length < 2 || members.length > TEAM_MAX_SIZE)
		throw new WorkInputError(`a team has 2-${TEAM_MAX_SIZE} members`);
	const ids = members.map((m, i) => BigInt(uintString(m.agentId, `members[${i}].agentId`)));
	const bps = members.map((m, i) => {
		if (!Number.isInteger(m.bps) || m.bps <= 0 || m.bps > TEAM_TOTAL_BPS)
			throw new WorkInputError(`members[${i}].bps must be an integer 1-10000`);
		return m.bps;
	});
	if (new Set(ids.map(String)).size !== ids.length) throw new WorkInputError("a member appears twice");
	if (bps[0] > TEAM_LEAD_MAX_BPS) throw new WorkInputError("the lead's share is at most 5000 bps");
	if (bps.reduce((a, b) => a + b, 0) !== TEAM_TOTAL_BPS) throw new WorkInputError("shares must sum to 10000 bps");
	return { ids, bps };
}

function checkDomain(d: TeamDomain): void {
	if (!d || typeof d.name !== "string" || typeof d.version !== "string" || !ADDRESS.test(d.verifyingContract))
		throw new WorkInputError("domain needs name, version, chainId and verifyingContract");
	assertWorkChain(d.chainId);
}

/** The EIP-712 digest every member signs (the contract's teamDigest). */
export function teamDigest(domain: TeamDomain, jobId: string | bigint | number, members: TeamMember[]): string {
	checkDomain(domain);
	const job = BigInt(uintString(jobId, "jobId"));
	const { ids, bps } = checkTeam(members);
	const membersHash = kec(concatBytes(...ids.map(word)));
	const splitHash = kec(concatBytes(...bps.map((b) => word(BigInt(b)))));
	const structHash = kec(
		concatBytes(kec(utf8ToBytes(TEAM_TYPE)), word(job), membersHash, splitHash, kec(utf8ToBytes(TEAM_STATEMENT_TEXT)))
	);
	const sep = kec(
		concatBytes(
			kec(utf8ToBytes(DOMAIN_TYPE)),
			kec(utf8ToBytes(domain.name)),
			kec(utf8ToBytes(domain.version)),
			word(BigInt(domain.chainId)),
			addrWord(domain.verifyingContract)
		)
	);
	return "0x" + bytesToHex(kec(concatBytes(new Uint8Array([0x19, 0x01]), sep, structHash)));
}

/** One member's acceptance: a 65-byte signature over the team digest (no EIP-191 prefix). */
export function signTeamAcceptance(privateKey: string, digest: string): string {
	if (!B32.test(digest)) throw new WorkInputError("digest must be 32 bytes of hex");
	if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) throw new WorkInputError("private key must be 32 bytes of hex");
	const sig = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(privateKey.replace(/^0x/, "")), { lowS: true });
	return "0x" + sig.toCompactHex() + (27 + sig.recovery).toString(16).padStart(2, "0");
}

const selector = (sig: string) => kec(utf8ToBytes(sig)).slice(0, 4);
const pad32 = (b: Uint8Array) => concatBytes(b, new Uint8Array((32 - (b.length % 32)) % 32));

/**
 * declareTeam(jobId, memberIds, splitBps, sigs) calldata, sent by the lead
 * (the job's provider) to the team contract while the job is Open or
 * BudgetSet. Then postTeamBond(jobId) once the job is funded.
 */
export function declareTeamCalldata(jobId: string | bigint | number, members: TeamMember[], sigs: string[]): string {
	const job = BigInt(uintString(jobId, "jobId"));
	const { ids, bps } = checkTeam(members);
	if (!Array.isArray(sigs) || sigs.length !== ids.length) throw new WorkInputError("one signature per member");
	const sigBytes = sigs.map((s, i) => {
		if (!/^0x[0-9a-fA-F]{130}$/.test(s)) throw new WorkInputError(`sigs[${i}] must be 65 bytes of hex`);
		return hexToBytes(s.slice(2));
	});
	const n = BigInt(ids.length);
	const a1 = concatBytes(word(n), ...ids.map(word));
	const a2 = concatBytes(word(n), ...bps.map((b) => word(BigInt(b))));
	const items = sigBytes.map((b) => concatBytes(word(BigInt(b.length)), pad32(b)));
	const offs: Uint8Array[] = [];
	let at = 32n * n;
	for (const it of items) {
		offs.push(word(at));
		at += BigInt(it.length);
	}
	const a3 = concatBytes(word(n), ...offs, ...items);
	const o1 = 32n * 4n;
	const o2 = o1 + BigInt(a1.length);
	const o3 = o2 + BigInt(a2.length);
	return (
		"0x" +
		bytesToHex(
			concatBytes(selector("declareTeam(uint256,uint256[],uint16[],bytes[])"), word(job), word(o1), word(o2), word(o3), a1, a2, a3)
		)
	);
}

export function postTeamBondCalldata(jobId: string | bigint | number): string {
	const job = BigInt(uintString(jobId, "jobId"));
	return "0x" + bytesToHex(concatBytes(selector("postTeamBond(uint256)"), word(job)));
}
