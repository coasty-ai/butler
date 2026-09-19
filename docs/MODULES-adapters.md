# Write your own adapter

Every stage of Butler's pipeline is a port with a contract (`.data/design/modules.md`; the schemas in `src/modules/contracts.ts`); the built-in code is one adapter, and you may put another behind the port. This section is the adapter author's: the three ways in, each contract's request and reply with an example, the budgets, what the core re-checks whatever you return, and how to run the conformance check before connecting anything. The rest of the modules feature (the Settings › Modules pane, fallback, the user recipes file) is documented in `docs/MODULES.md`.

## The three ways in

1. **An MCP tool.** Any server Settings › Tools can connect (stdio or HTTP, through the consent sheet, the trust tier and the network sandbox) may expose a tool with one of the contract names below; Settings › Modules then lists it by server and tool for the matching port. The tool must declare `inputSchema` and `outputSchema` (an object schema; a union of objects carries `type: "object"` at the top) and honest `annotations`: `segment_clauses`, `decide_clause` and `choose` are `readOnlyHint: true`; `open_url` is `readOnlyHint: false, destructiveHint: false, openWorldHint: true`. The reply goes in `structuredContent` (and, for older clients, as JSON in a text block). `examples/modules/mcp-modules/server.mjs` is the reference, with its own README.
2. **An HTTP endpoint.** One https URL per port; the app POSTs the request as JSON and reads the reply as JSON, with any headers you named from the vault. The same shapes as the tool's arguments and result.
3. **A command, for the recognizer.** The `recognizer` port is a protocol, not a tool: a binary spawned in place of `native/bin/coarena-voice` that speaks the voice helper's JSON lines. `docs/RECOGNIZER_PROTOCOL.md` is its whole specification, including what a replacement must own (its microphone permission, the input latch) and what is not yet pluggable.

## The contracts

Requests and replies are JSON. Word offsets, times and probabilities are numbers; times are milliseconds on the caller's monotonic clock.

### `segment_clauses` (port `clauseSegmenter`)

Cut the growing partial transcript into clauses and say which committed. Stateless on the wire: the caller sends back the clauses it was given last time.

```json
{ "text": "go to youtube and play", "atMs": 640, "previous": [] }
```

```json
{
  "clauses": [
    {
      "index": 0,
      "text": "go to youtube",
      "startWord": 0,
      "endWord": 3,
      "state": "committed",
      "committedAtMs": 640
    },
    {
      "index": 1,
      "text": "play",
      "startWord": 4,
      "endWord": 5,
      "state": "growing"
    }
  ],
  "events": [
    {
      "kind": "committed",
      "by": "boundary",
      "clause": {
        "index": 0,
        "text": "go to youtube",
        "startWord": 0,
        "endWord": 3,
        "state": "committed",
        "committedAtMs": 640
      }
    }
  ]
}
```

`events` are `committed` (`by`: `boundary`, the next clause's first content word arrived; `stable`, the words stood 350 ms as verb + object), `superseded` (`clause`, `replacement`: the recognizer rewrote committed words) and, when the request carries `"final": true`, one `final` event with `clauses` and `dropped` (committed clauses the final no longer says). A clause's `text` is its words with connectors stripped; `startWord`/`endWord` index the recognizer's words, `endWord` exclusive. The built-in keeps the time each clause's words last changed, which a `Clause` does not carry: an adapter that remembers nothing between calls can commit by boundary only; the example continues its live stream when `previous` is what it returned last.

### `decide_clause` (port `fastDecider`)

What one committed clause of a sentence still being spoken may do at once. Navigation only.

```json
{
  "clause": {
    "index": 1,
    "text": "play a midwest safety",
    "startWord": 4,
    "endWord": 8,
    "state": "committed",
    "committedAtMs": 1460
  },
  "context": {
    "frontAppId": "com.apple.Safari",
    "frontHost": "www.youtube.com",
    "browser": "Safari",
    "protectedHosts": ["paypal.com"]
  }
}
```

```json
{
  "kind": "open_url",
  "url": "https://www.youtube.com/results?search_query=midwest%20safety",
  "siteKey": "youtube",
  "label": "YouTube search for midwest safety"
}
```

One of `{ "kind": "open_app", "name" }`, `{ "kind": "open_url", "url", "siteKey"?, "label" }`, `{ "kind": "scroll", "direction": "down" | "up" }` or `{ "kind": "none", "reason": "not_navigational" | "needs_final" | "ambiguous" | "protected" | "unsure" }`. `frontHost` is the host the browser shows or was just sent to, so the second clause of "go to youtube and play …" can resolve to a YouTube search; `protectedHosts` are the user's protected domains (any host under them is `none:protected`). `siteKey` names the recipe the URL was built from (the diagnostics read it as a code) and is optional for adapters; `label` is what the pill shows while the page loads.

### `choose` (port `choiceModel`)

One typed choice with a probability.

```json
{
  "question": {
    "id": "clause",
    "choices": [
      "open_app",
      "open_site",
      "search_on_site",
      "scroll",
      "not_navigational",
      "unclear"
    ],
    "prompt": "What does this spoken clause ask the computer to do?"
  },
  "state": {
    "clause": "play a midwest safety",
    "frontApp": "com.apple.Safari",
    "frontHost": "www.youtube.com",
    "browser": "Safari"
  }
}
```

```json
{ "choice": "search_on_site", "p": 0.93 }
```

`choice` must be one of `choices`; `p` in [0, 1]. The decider takes a clause verdict only at p ≥ 0.85 and still takes the object from its own extraction: a choice model never produces text that runs. `state` is information, never instructions.

### `open_url` (port `urlOpener`)

Load a URL in the user's non-personal browser without keys or clicks.

```json
{
  "url": "https://www.youtube.com/results?search_query=midwest%20safety",
  "browser": "Safari"
}
```

```json
{ "navigated": true, "method": "open -a" }
```

`method` is a short code for how it was done (the built-in answers `script` for an Apple Event to its own tab and `open` for LaunchServices; the example answers `dry-run` unless started with `--allow-open`). A URL that is not http(s), has no host or carries credentials is refused before it reaches you.

### `speak` (port `tts`)

```json
{ "text": "Opened YouTube.", "voice": "af_heart" }
```

```json
{ "audio": "<base64 wav or mp3>", "ms": 640 }
```

or `{ "played": true, "ms": 640 }` when the adapter plays it itself. `ms` is the time to the first audio or the whole synthesis, as the adapter measures it.

## Budgets

An adapter has the built-in's target (`PORTS` in `src/modules/contracts.ts`); the registry enforces the deadline per call and traces `ModuleSlow`, and with "fall back to built-in on error" on, an error, a timeout or a reply the contract refuses falls back to the built-in for that call (`ModuleFallback`).

| Port              | Tool              | p50     | p95     | Deadline |
| ----------------- | ----------------- | ------- | ------- | -------- |
| `clauseSegmenter` | `segment_clauses` | 50 ms   | 150 ms  | 300 ms   |
| `fastDecider`     | `decide_clause`   | 250 ms  | 600 ms  | 600 ms   |
| `choiceModel`     | `choose`          | 250 ms  | 600 ms  | 600 ms   |
| `urlOpener`       | `open_url`        | 1000 ms | 3000 ms | 3000 ms  |
| `tts`             | `speak`           | 1500 ms | 4000 ms | 8000 ms  |

The segmenter runs on every partial and the decider on every committed clause while the person is still speaking; the design's whole budget from a clause committing to its page loading is 250 ms p50, so a decider that spends its budget leaves nothing for the route.

## What the core re-checks

Your reply is data. Whatever an adapter returns:

- `open_url` from any adapter: http or https, a host, no credentials, the host not protected under the user's list; while the user is still speaking only navigation runs, through the policy's speaking allow-list (`src/core/policy.ts`). A dictated address is never opened; a URL the built-in would have built from a recipe and one you built are judged the same way.
- `decide_clause`: a clause with a consequential or irreversible word (`send`, `pay`, `delete`, `share`, …), an "@" or a credential is refused before you are asked. Every reply is parsed against the contract; anything else is a fallback.
- `choose`: probabilities are clamped to [0, 1]; a choice outside `choices` is refused; the text acted on is never yours.
- `speak`: text goes out only under the same privacy tier as the task model; `PRIVATE_LOCAL` refuses an internet adapter.
- An MCP adapter inherits the tool layer's consent sheet, trust tier, ticks and network sandbox; a tool that is not ticked on is not offered, and an untrusted write-tier tool is refused for a port that must never act.
- The journal and the diagnostics record what ran as codes and counts; `scripts/streaming-report.mjs` reads the streamed steps whatever adapter decided them.

Nothing here moves THREAT_MODEL's floors: an adapter can make Butler smarter, slower or wrong, not less safe.

## Run the check first

`scripts/modules-check.mjs` (`npm run modules:check`) runs `tests/fixtures/partial-timelines.json` through an adapter without the app, the registry or any setting: an MCP adapter is the command itself, spawned over stdio with the SDK client, so you can test a server before connecting it.

```sh
npm run modules:check -- --port fastDecider --adapter "mcp:node examples/modules/mcp-modules/server.mjs"
npm run modules:check -- --port clauseSegmenter --adapter mcp -- node path/to/your/server.mjs --your-flag
npm run modules:check -- --port choose --adapter http:https://host/choose --json
npm run modules:check -- --port urlOpener --call --adapter "mcp:node examples/modules/mcp-modules/server.mjs"
npm run modules:check -- --port fastDecider --adapter builtin
```

Per case it prints one line per call: for `fastDecider` the built-in's decision and yours as codes (`open_url:youtube`, `open_app`, `scroll:down`, `none:protected`) and whether they agree (the same kind and the same URL, application or direction); for `clauseSegmenter` how many events the built-in produced on that partial and whether yours matched them (committed, superseded and final events by index and words); for `choose` the act the rules decided against your choice and its `p`, marked taken only at 0.85 or above; for `urlOpener` whether each URL the built-in decided passes the contract and, with `--call`, your reply's `method` (call it only against a dry-run adapter, since a live one loads the pages). Every call's latency is printed, and the summary gives p50 and p95 against the port's budget, the agreement rate and the failed replies with their codes (`schema:<field>`, `TOOL_ERROR`, `HTTP_500`, a timeout). The output is content-free: codes, counts and milliseconds, never a clause's words, a URL or a label. Exit 0 when every reply passed and the budget was met, 1 on any failed reply or a budget miss, 2 on a usage error or an adapter that would not start. `--json` gives the same as data.

Agreement below 100 % is not a failure: a smarter decider may disagree with the rules and be right. A failed reply is: the app would have fallen back on it.
