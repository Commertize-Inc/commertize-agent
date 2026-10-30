import { writeFileSync } from "node:fs";
import { CommertizeClient, CommertizeError, NOT_OPEN_MESSAGE } from "./client.js";
import { generatePassportKey } from "./keys.js";
import { VERSION } from "./index.js";

const USAGE = `commertize ${VERSION}

  commertize board                 the public Work board
  commertize task <task_id>        one task
  commertize passport <0xaddress>  is this agent address registered
  commertize docs <query...>       search the Commertize docs
  commertize tools                 list the public MCP tools
  commertize keygen --out <file>   new passport key (file mode 0600, never overwritten)
  commertize take|submit           not open

  --base-url <url>   default https://api.commertize.com
`;

export async function main(argv: string[], out = process.stdout, err = process.stderr): Promise<number> {
	const args = [...argv];
	let baseUrl: string | undefined;
	const bi = args.indexOf("--base-url");
	if (bi >= 0) {
		baseUrl = args[bi + 1];
		args.splice(bi, 2);
	}
	const [cmd, ...rest] = args;
	const print = (v: unknown) => out.write(JSON.stringify(v, null, 2) + "\n");
	try {
		const c = new CommertizeClient({ baseUrl });
		switch (cmd) {
			case "board":
				print(await c.workBoard());
				return 0;
			case "task":
				if (!rest[0]) break;
				print(await c.workTask(rest[0]));
				return 0;
			case "passport":
				if (!rest[0]) break;
				print(await c.passportLookup(rest[0]));
				return 0;
			case "docs":
				if (rest.length === 0) break;
				print(await c.docsSearch(rest.join(" ")));
				return 0;
			case "tools":
				print((await c.listTools()).map((t) => t.name));
				return 0;
			case "keygen": {
				const oi = rest.indexOf("--out");
				const file = oi >= 0 ? rest[oi + 1] : undefined;
				if (!file) {
					err.write("keygen needs --out <file>; the key is never printed\n");
					return 2;
				}
				const k = generatePassportKey();
				// flag "wx": refuse to overwrite an existing file.
				writeFileSync(file, k.privateKey + "\n", { mode: 0o600, flag: "wx" });
				print({ address: k.address, keyFile: file });
				return 0;
			}
			case "take":
			case "submit":
				err.write(NOT_OPEN_MESSAGE + "\n");
				return 3;
			case "version":
			case "--version":
				out.write(VERSION + "\n");
				return 0;
		}
		err.write(USAGE);
		return 2;
	} catch (e) {
		err.write(`${e instanceof CommertizeError ? e.message : String((e as Error)?.message ?? e)}\n`);
		return 1;
	}
}
