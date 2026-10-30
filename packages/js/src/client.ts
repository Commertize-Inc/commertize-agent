/**
 * Read-only client for the public Commertize agent surface:
 *   MCP  POST {baseUrl}/mcp/public   (work_board, work_task, passport_lookup, docs_search)
 *   HTTP GET  {baseUrl}/work/v1/tasks
 * No key is needed. Taking or submitting a job is not open; those
 * methods refuse locally and never call the network.
 */

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
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class CommertizeClient {
	readonly baseUrl: string;
	private readonly f: typeof fetch;
	private readonly timeoutMs: number;
	private readonly userAgent: string;
	private nextId = 1;

	constructor(opts: ClientOptions = {}) {
		const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base))
			throw new CommertizeError("baseUrl must be https (or http on localhost)");
		this.baseUrl = base;
		this.f = opts.fetch ?? globalThis.fetch;
		this.timeoutMs = opts.timeoutMs ?? 15_000;
		this.userAgent = opts.userAgent ?? "commertize-agent-js";
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

	/** Not open. Refuses without a network call. */
	async takeJob(_taskId: string): Promise<never> {
		throw new NotOpenError();
	}

	/** Not open. Refuses without a network call. */
	async submitJob(_taskId: string, _submission: unknown): Promise<never> {
		throw new NotOpenError();
	}
}
