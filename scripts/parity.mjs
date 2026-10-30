// Parity between spec/, the JS package and the Python package. Reads source
// text, so it needs no install. Exit 1 on any drift.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const list = (src, re) => [...(src.match(re)?.[1] ?? "").matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);

export function check() {
	const problems = [];
	const eq = (what, a, b) => {
		if (JSON.stringify(a) !== JSON.stringify(b))
			problems.push(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
	};
	const spec = JSON.parse(read("spec/mcp-tools.json"));
	const jsClient = read("packages/js/src/client.ts");
	const pyClient = read("packages/python/src/commertize_agent/client.py");
	const specTools = spec.tools.map((t) => t.name);
	eq("JS READ_TOOLS vs spec", list(jsClient, /READ_TOOLS = \[([^\]]*)\]/), specTools);
	eq("Python READ_TOOLS vs spec", list(pyClient, /READ_TOOLS = \(([^)]*)\)/), specTools);
	eq("JS not-open message", jsClient.match(/NOT_OPEN_MESSAGE = "([^"]+)"/)?.[1], spec.closedMessage);
	eq("Python not-open message", pyClient.match(/NOT_OPEN_MESSAGE = "([^"]+)"/)?.[1], spec.closedMessage);
	eq("JS endpoint", jsClient.match(/DEFAULT_BASE_URL = "([^"]+)"/)?.[1] + "/mcp/public", spec.endpoint);
	eq("Python endpoint", pyClient.match(/DEFAULT_BASE_URL = "([^"]+)"/)?.[1] + "/mcp/public", spec.endpoint);

	const jsKeys = read("packages/js/src/keys.ts");
	const pyKeys = read("packages/python/src/commertize_agent/keys.py");
	eq("agent actions JS vs Python", list(jsKeys, /AGENT_ACTIONS = \[([^\]]*)\]/), list(pyKeys, /AGENT_ACTIONS = \(([^)]*)\)/));

	// Work writes: tools, actions, chains and template presets agree in both
	// packages and with the backend's write tools (spec.write).
	const jsWork = read("packages/js/src/work.ts");
	const pyWork = read("packages/python/src/commertize_agent/work.py");
	eq("JS WRITE_TOOLS vs spec", list(jsWork, /WRITE_TOOLS = \[([^\]]*)\]/), spec.write.tools);
	eq("Python WRITE_TOOLS vs spec", list(pyWork, /WRITE_TOOLS = \(([^)]*)\)/), spec.write.tools);
	eq("JS WORK_ACTIONS vs spec", list(jsWork, /WORK_ACTIONS = \[([^\]]*)\]/), spec.write.actions);
	eq("Python WORK_ACTIONS vs spec", list(pyWork, /WORK_ACTIONS = \(([^)]*)\)/), spec.write.actions);
	const nums = (src, re) => (src.match(re)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
	eq("JS WORK_CHAIN_IDS vs spec", nums(jsWork, /WORK_CHAIN_IDS = \[([^\]]*)\]/), spec.write.chainIds);
	eq("Python WORK_CHAIN_IDS vs spec", nums(pyWork, /WORK_CHAIN_IDS = \(([^)]*)\)/), spec.write.chainIds);
	eq("work request prefix JS vs Python", jsWork.match(/PREFIX = "([^"]+)"/)?.[1], pyWork.match(/_PREFIX = "([^"]+)"/)?.[1]);
	const tpl = (src) => [...src.matchAll(/id: "(T\d)", name: "([^"]+)", evaluator: "(\w+)"|"id": "(T\d)", "name": "([^"]+)", "evaluator": "(\w+)"/g)].map((m) => [m[1] ?? m[4], m[2] ?? m[5], m[3] ?? m[6]]);
	eq("templates JS vs Python", tpl(jsWork), tpl(pyWork));
	if (tpl(jsWork).length !== 6) problems.push(`expected 6 template presets, found ${tpl(jsWork).length}`);
	for (const term of ["LEAD_MAX_BPS = 5000", "MAX_SIZE = 10", "TOTAL_BPS = 10_000"])
		for (const [f, src] of [["js work", jsWork], ["python work", pyWork]])
			if (!src.includes(term)) problems.push(`${f} lacks ${term}`);

	const v = JSON.parse(read("packages/js/package.json")).version;
	eq("pyproject version", read("packages/python/pyproject.toml").match(/^version = "([^"]+)"/m)?.[1], v);
	eq("python __version__", read("packages/python/src/commertize_agent/__init__.py").match(/__version__ = "([^"]+)"/)?.[1], v);
	eq("JS VERSION", read("packages/js/src/index.ts").match(/VERSION = "([^"]+)"/)?.[1], v);
	for (const [f, src] of [["js client", jsClient], ["python client", pyClient]])
		for (const m of src.matchAll(/"version"?:? ?"(\d+\.\d+\.\d+)"/g)) eq(`${f} clientInfo version`, m[1], v);

	// One command name in both packages, distinct from @commertize/agent-kit's
	// `commertize-agent` bin so the two can be installed side by side.
	const pkg = JSON.parse(read("packages/js/package.json"));
	eq("JS bin names", Object.keys(pkg.bin), ["commertize"]);
	eq("Python console scripts", [...read("packages/python/pyproject.toml").matchAll(/^([\w-]+) = "commertize_agent\.cli:main"$/gm)].map((m) => m[1]), ["commertize"]);
	eq("JS bin file", pkg.bin.commertize, "bin/commertize.mjs");
	for (const [f, src] of [["js cli", read("packages/js/src/cli.ts")], ["python cli", read("packages/python/src/commertize_agent/cli.py")]])
		if (/^\s+commertize-agent /m.test(src)) problems.push(`${f} usage still names commertize-agent`);

	const api = JSON.parse(read("spec/openapi/work-v1.json")).components.schemas;
	const block = (name) => jsClient.match(new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
	const fields = (b) => [...b.matchAll(/^\t(\w+)(\?)?:/gm)].map((m) => m[1]).sort();
	eq("WorkBoard fields (OpenAPI vs JS type)", Object.keys(api.WorkBoard.properties).sort(), fields(block("WorkBoard")));
	eq("WorkTask fields (OpenAPI vs JS type)", Object.keys(api.WorkTask.properties).sort(), fields(block("WorkTask")));
	return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const p = check();
	for (const x of p) console.error(x);
	console.log(p.length ? `parity: ${p.length} problem(s)` : "parity: ok");
	process.exit(p.length ? 1 : 0);
}
