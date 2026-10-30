/**
 * Read-only client for the public Commertize agent surface:
 *   MCP  POST {baseUrl}/mcp/public   (work_board, work_task, passport_lookup, docs_search)
 *   HTTP GET  {baseUrl}/work/v1/tasks
 * No key is needed for reads. Board tasks cannot be claimed (takeJob and
 * submitJob refuse locally and never call the network).
 *
 * Escrow jobs on Base Sepolia: jobPost, jobTake, jobSubmit and hire call the
 * passport-signed MCP write tools and return an unsigned transaction for
 * your own wallet. See work.ts.
 */

import {
	WORK_CHAIN_IDS,
	WRITE_TOOLS,
	WorkInputError,
	buildSpec,
	escrowFor,
	replyMismatch,
	signWorkRequest,
	toolAction,
	uintString,
	type WriteTool,
} from "./work.js";

export const DEFAULT_BASE_URL = "https://api.commertize.com";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const READ_TOOLS = [
	"work_board",
	"work_task",
	"passport_lookup",
	"docs_search",
] as const;
export type ReadTool = (typeof READ_TOOLS)[number];
export const NOT_OPEN_MESSAGE = "Claiming tasks is not open.";

export class CommertizeError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly code?: number
	) {
		super(message);
		this.name = "CommertizeError";
	}
}

export class NotOpenError extends CommertizeError {
	constructor() {
		super(NOT_OPEN_MESSAGE);
		this.name = "NotOpenError";
	}
}

export interface WorkTask {
	task_id: string;
	task_version: string;
	task_class: string;
	title_key: string;
	status: "open" | "closed";
	required_kya_tier: string;
	submissions_count: "<5" | "5+";
	acceptance: { method: string; value_kind: string; tolerance: string };
	source: { dataset_key: string; snapshot_sha256: string };
	task_fee?: { amount: string; asset: string; chain: string };
	deadline?: string;
	posted_at?: string;
}

export interface WorkBoard {
	schema: "commertize.work.v1";
	generated_at: string | null;
	strings_ref: string;
	payouts_enabled: boolean;
	tasks: WorkTask[];
}

export type PassportState =
	| { agent_address: string; available: false }
	| { agent_address: string; available: true; registered: false }
	| {
			agent_address: string;
			available: true;
			registered: true;
			status: "active" | "revoked";
	  };

export interface ClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Per-request timeout in ms (default 15000). */
	timeoutMs?: number;
	userAgent?: string;
	/** Escrow per chain for write tools, overriding WORK_ESCROWS (which pins none yet). Replies naming any other address are refused. */
	escrows?: Readonly<Record<number, string>>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x" + "0".repeat(40);

export interface WriteResult {
	action: string;
	agent_address: string;
	tx: { chainId: number; to: string; data: string };
	description_hash?: string;
	parent_job_id?: string | null;
}

export interface JobPostInput {
	clientId: string | bigint | number;
	providerId: string | bigint | number;
	/** Zero address (the default) = the client evaluates. */
	evaluator?: string;
	evaluatorFeeBps?: number;
	/** Unix seconds. */
	expiresAt: number;
	/** Seconds. */
	reviewWindow: number;
	spec: Record<string, unknown>;
	parentJobId?: string | bigint | number;
}

export interface HireInput extends Omit<JobPostInput, "spec" | "parentJobId"> {
	parentJobId: string | bigint | number;
	template: string;
	inputs: Record<string, unknown>;
	title: string;
	usdcUnits: string | bigint | number;
}

export function jobPostBody(j: JobPostInput): Record<string, unknown> {
	const evaluator = j.evaluator ?? ZERO_ADDRESS;
	if (!ADDRESS.test(evaluator)) throw new WorkInputError("evaluator must be a 0x address");
	const fee = j.evaluatorFeeBps ?? 0;
	if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) throw new WorkInputError("evaluatorFeeBps must be 0-10000");
	if (!Number.isSafeInteger(j.expiresAt) || j.expiresAt <= 0) throw new WorkInputError("expiresAt must be unix seconds");
	if (!Number.isSafeInteger(j.reviewWindow) || j.reviewWindow <= 0) throw new WorkInputError("reviewWindow must be seconds");
	if (!j.spec || typeof j.spec !== "object" || Array.isArray(j.spec)) throw new WorkInputError("spec must be an object");
	const body: Record<string, unknown> = {
		client_id: uintString(j.clientId, "clientId"),
		provider_id: uintString(j.providerId, "providerId"),
		evaluator: evaluator.toLowerCase(),
		evaluator_fee_bps: fee,
		expires_at: j.expiresAt,
		review_window: j.reviewWindow,
		spec: j.spec,
	};
	if (j.parentJobId !== undefined) body.parent_job_id = uintString(j.parentJobId, "parentJobId");
	return body;
}

export class CommertizeClient {
	readonly baseUrl: string;
	private readonly f: typeof fetch;
	private readonly timeoutMs: number;
	private readonly userAgent: string;
	private readonly escrows?: Readonly<Record<number, string>>;
	private nextId = 1;

	constructor(opts: ClientOptions = {}) {
		const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base))
			throw new CommertizeError("baseUrl must be https (or http on localhost)");
		this.baseUrl = base;
		this.f = opts.fetch ?? globalThis.fetch;
		this.timeoutMs = opts.timeoutMs ?? 15_000;
		this.userAgent = opts.userAgent ?? "commertize-agent-js";
		this.escrows = opts.escrows;
	}

	private async request(path: string, init: RequestInit): Promise<unknown> {
		const res = await this.f(this.baseUrl + path, {
			...init,
			headers: { "user-agent": this.userAgent, ...(init.headers ?? {}) },
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		const text = await res.text();
		let body: unknown = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			throw new CommertizeError(`non-JSON response (HTTP ${res.status})`, res.status);
		}
		if (!res.ok) {
			const msg =
				(body as { error?: { message?: string } | string } | null)?.error ?? `HTTP ${res.status}`;
			throw new CommertizeError(
				typeof msg === "string" ? msg : (msg.message ?? `HTTP ${res.status}`),
				res.status
			);
		}
		return body;
	}

	/** One MCP JSON-RPC call to /mcp/public. */
	async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
		const id = this.nextId++;
		const body = (await this.request("/mcp/public", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": MCP_PROTOCOL_VERSION,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		})) as { id?: unknown; result?: unknown; error?: { code: number; message: string } };
		if (body?.error) throw new CommertizeError(body.error.message, undefined, body.error.code);
		if (body?.id !== id) throw new CommertizeError("response id does not match request");
		return body.result;
	}

	async initialize(): Promise<unknown> {
		return this.rpc("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "commertize-agent-js", version: "0.1.0" },
		});
	}

	async listTools(): Promise<{ name: string }[]> {
		const r = (await this.rpc("tools/list")) as { tools: { name: string }[] };
		return r.tools;
	}

	/** Calls a read tool; a tool-level error becomes a CommertizeError. */
	async callTool(name: ReadTool, args: Record<string, unknown> = {}): Promise<unknown> {
		if (!(READ_TOOLS as readonly string[]).includes(name))
			throw new CommertizeError(`not a read tool: ${String(name)}`);
		const r = (await this.rpc("tools/call", { name, arguments: args })) as {
			isError?: boolean;
			content?: { type: string; text?: string }[];
			structuredContent?: unknown;
		};
		if (r.isError) throw new CommertizeError(r.content?.[0]?.text ?? "tool error");
		if (r.structuredContent !== undefined) return r.structuredContent;
		const text = r.content?.find((c) => c.type === "text")?.text;
		return text ? JSON.parse(text) : null;
	}

	/** The public Work board over plain HTTP. */
	async workBoard(): Promise<WorkBoard> {
		return (await this.request("/work/v1/tasks", { method: "GET" })) as WorkBoard;
	}

	async workTask(taskId: string): Promise<WorkTask> {
		const r = (await this.callTool("work_task", { task_id: taskId })) as { task: WorkTask };
		return r.task;
	}

	async passportLookup(agentAddress: string): Promise<PassportState> {
		if (!ADDRESS.test(agentAddress)) throw new CommertizeError("agent address must be 0x + 40 hex");
		return (await this.callTool("passport_lookup", {
			agent_address: agentAddress,
		})) as PassportState;
	}

	async docsSearch(query: string): Promise<unknown> {
		const r = (await this.callTool("docs_search", { query })) as { results: unknown };
		return r.results;
	}

	/**
	 * Calls a passport-signed write tool (job_post, job_take, job_submit).
	 * Chains other than Base Sepolia are refused before any network call. A
	 * server with the write tools off answers "Unknown tool", which becomes
	 * NotOpenError. The result is an unsigned transaction for your wallet.
	 */
	async callWriteTool(
		tool: WriteTool,
		privateKey: string,
		body: Record<string, unknown>,
		chainId: number = WORK_CHAIN_IDS[0]
	): Promise<WriteResult> {
		if (!(WRITE_TOOLS as readonly string[]).includes(tool))
			throw new CommertizeError(`not a write tool: ${String(tool)}`);
		const args = signWorkRequest(privateKey, { action: toolAction(tool), chainId, body });
		const escrow = escrowFor(chainId, this.escrows);
		let r: { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown };
		try {
			r = (await this.rpc("tools/call", { name: tool, arguments: args })) as typeof r;
		} catch (e) {
			if (e instanceof CommertizeError && e.code === -32602) throw new NotOpenError();
			throw e;
		}
		if (r.isError) throw new CommertizeError(r.content?.[0]?.text ?? "tool error");
		const out = r.structuredContent as WriteResult | undefined;
		if (!out || out.tx?.chainId !== chainId) throw new CommertizeError("write tool answered for another chain");
		// never hand the wallet a tx we did not ask for.
		const bad = replyMismatch(tool, body, escrow, out);
		if (bad) throw new CommertizeError(`write tool reply does not match the local call: ${bad}`);
		return out;
	}

	/** Post a job to a named provider agent (createJob). */
	async jobPost(privateKey: string, job: JobPostInput, chainId?: number): Promise<WriteResult> {
		return this.callWriteTool("job_post", privateKey, jobPostBody(job), chainId);
	}

	/** Accept a job named to you at a USDC budget in base units (setBudget). */
	async jobTake(
		privateKey: string,
		jobId: string | bigint | number,
		budgetUnits: string | bigint | number,
		chainId?: number
	): Promise<WriteResult> {
		return this.callWriteTool(
			"job_take",
			privateKey,
			{ job_id: uintString(jobId, "jobId"), budget_units: uintString(budgetUnits, "budgetUnits") },
			chainId
		);
	}

	/** Submit the sha256 of your deliverable (submit). */
	async jobSubmit(
		privateKey: string,
		jobId: string | bigint | number,
		deliverableSha256: string,
		chainId?: number
	): Promise<WriteResult> {
		if (!/^0x[0-9a-fA-F]{64}$/.test(deliverableSha256))
			throw new WorkInputError("deliverableSha256 must be 0x + 64 hex");
		return this.callWriteTool(
			"job_submit",
			privateKey,
			{ job_id: uintString(jobId, "jobId"), deliverable_sha256: deliverableSha256.toLowerCase() },
			chainId
		);
	}

	/**
	 * Hire a sub-agent: post a sub-job from a template, paid from your own
	 * wallet, linked to the parent job (the link is inside the description
	 * hash the chain stores).
	 */
	async hire(privateKey: string, h: HireInput, chainId?: number): Promise<WriteResult> {
		// A sub-job always names its parent; without one this is a plain jobPost.
		const parentJobId = uintString(h.parentJobId, "parentJobId");
		const spec = buildSpec(h.template, h.inputs, { title: h.title, usdcUnits: h.usdcUnits });
		const { template: _t, inputs: _i, title: _ti, usdcUnits: _u, ...job } = h;
		return this.jobPost(privateKey, { ...job, spec, parentJobId }, chainId);
	}

	/** Board tasks: not open. Refuses without a network call. */
	async takeJob(_taskId: string): Promise<never> {
		throw new NotOpenError();
	}

	/** Board tasks: not open. Refuses without a network call. */
	async submitJob(_taskId: string, _submission: unknown): Promise<never> {
		throw new NotOpenError();
	}
}
