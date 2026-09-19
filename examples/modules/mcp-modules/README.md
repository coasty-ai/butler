# mcp-modules: the reference adapter server

One MCP stdio server that stands behind four of Butler's ports (`.data/design/modules.md`, `docs/MODULES-adapters.md`): `segment_clauses` for the clause segmenter, `decide_clause` for the fast decider, `choose` for the choice model and `open_url` for the URL opener. It is the subject of `npm run modules:check` and the file to copy when writing an adapter of your own.

```sh
node examples/modules/mcp-modules/server.mjs               # open_url answers a dry run
node examples/modules/mcp-modules/server.mjs --allow-open  # open_url runs `open <url>`
```

What it does: `segment_clauses` and `decide_clause` call the app's own built-ins (`src/voice/stream.ts`, `src/voice/fast.ts`) through the repository, so the example proves the wiring rather than a new decider; the one visible difference is that every `open_url` it decides carries a label ending in " · example". `choose` returns the first choice at p 0.5, below the decider's 0.85 bar, so it is never taken on its word. `open_url` validates the address (http or https, a host, no credentials) and only with `--allow-open` hands it to LaunchServices (`open <url>`, or `open -a <browser> <url>` when a browser is named); otherwise it answers `{ "navigated": false, "method": "dry-run" }`. Nothing is read from the screen, nothing is kept, nothing is written to disk.

The framing is newline-delimited JSON-RPC 2.0 with the MCP handshake (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`), written by hand like `tests/fixtures/mcp-fixture-server.mjs`: the repository ships the MCP client packages and no server package. The tool schemas are `src/modules/contracts.ts`'s, so a reply the app would refuse is refused here too. It runs from a checkout (it registers `tsx` to import the TypeScript), which is what an example is for; an adapter of your own carries its own code.

## Connect it

1. Settings › Tools › Add a server, paste row: command `node`, args `["examples/modules/mcp-modules/server.mjs"]` (an absolute path if the app's working directory is not the checkout), network `none`, then consent. The consent sheet's preview connects once, lists the four tools and disconnects. Tick the tools you want the ports to use; `open_url` is the one that acts, so it is listed under its own tier.
2. Settings › Modules: for each port, pick the server and its tool (`Clause segmenter → mcp-modules / segment_clauses`, and so on). Leave "fall back to built-in on error" on until the check below is clean.
3. Check it before you rely on it, without the app:

```sh
npm run modules:check -- --port fastDecider --adapter "mcp:node examples/modules/mcp-modules/server.mjs"
npm run modules:check -- --port clauseSegmenter --adapter mcp -- node examples/modules/mcp-modules/server.mjs
npm run modules:check -- --port choose --adapter "mcp:node examples/modules/mcp-modules/server.mjs"
npm run modules:check -- --port urlOpener --call --adapter "mcp:node examples/modules/mcp-modules/server.mjs"
```

The check spawns the command itself over stdio, runs `tests/fixtures/partial-timelines.json` through it and prints agreement with the built-in, latency against the port's budget and any reply the contract refuses; codes, counts and milliseconds only, never a clause's words.

## What stays fixed whatever this server says

Every reply is data. An `open_url` the decider returns is re-checked by the core: http(s), no credentials, host not protected, and while the user is still speaking only navigation runs. A clause with a consequential word is refused before `decide_clause` is asked. `choose` probabilities are clamped and a choice never produces text that runs. The consent sheet, the trust tier and the network sandbox of Settings › Tools apply to this server as to any other.
