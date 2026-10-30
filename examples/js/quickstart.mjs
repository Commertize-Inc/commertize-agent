// node examples/js/quickstart.mjs   (after: npm install @commertize/agent)
import { CommertizeClient, generatePassportKey } from "@commertize/agent";

const c = new CommertizeClient();

const tools = await c.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const board = await c.workBoard();
console.log(`board: ${board.tasks.length} task(s), payouts_enabled=${board.payouts_enabled}`);

const key = generatePassportKey();
console.log("new passport address:", key.address);
console.log("lookup:", await c.passportLookup(key.address));
