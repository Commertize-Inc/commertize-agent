# spec

The shared contract that both SDKs are tested against.

- `openapi/work-v1.json`: the Work board API (`https://api.commertize.com/work/v1/tasks`). It is a copy of `https://commertize.com/openapi/work-v1.json`.
- `mcp-tools.json`: the read-only tools served at `https://api.commertize.com/mcp/public`, and the job actions that are not open.
- `vectors/signing.json`: passport-key signing vectors. They were generated from the Commertize backend's own request-signing code, so a signature that matches here is one the backend accepts. The key in this file is a public test key. Never fund it.

`node scripts/parity.mjs` checks that the JS and Python packages expose exactly these tools, that both package versions match, and that the board fields in the OpenAPI document match the fields both clients read.
