// Copy guard: no airdrop, price, listing, value, earning, yield or launch
// wording anywhere in this repository's text. Copy is certified before each
// release; this keeps uncertified words out between reviews. Exit 1 on any hit.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Launch-wording terms included. Whole words only, so code identifiers
// (accessToken, token_id, id-token, earlyExit, comingSoon) never match.
export const BANNED =
	/\bCTZ\b|airdrop|\bprice|\blisting|\bvalue\b|\bearn|\byield|(?<![\w-])(?:not yet|coming|soon|TGE|early|points?|tokens?|rewards?|genesis)(?![\w-])/i;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".venv"]);
// LICENSE is the Apache text, verbatim. This file and its test name the words.
const SKIP_FILES = new Set(["LICENSE", "scripts/copy_guard.mjs", "scripts/copy_guard.test.mjs"]);
const TEXT = /\.(md|mjs|js|ts|py|json|toml|ya?ml|txt|cfg)$/;

export function scan(root = ROOT) {
	const hits = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir)) {
			const p = path.join(dir, e);
			const rel = path.relative(root, p).split(path.sep).join("/");
			if (statSync(p).isDirectory()) {
				if (!SKIP_DIRS.has(e)) walk(p);
				continue;
			}
			if (SKIP_FILES.has(rel) || path.basename(p) === "LICENSE" || !TEXT.test(e)) continue;
			readFileSync(p, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (BANNED.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
				});
		}
	};
	walk(root);
	return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const hits = scan();
	for (const h of hits) console.error(h);
	console.log(hits.length ? `copy guard: ${hits.length} hit(s)` : "copy guard: clean");
	process.exit(hits.length ? 1 : 0);
}
