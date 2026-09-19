# Modules: every stage behind a port, any adapter behind the port

Butler's pipeline is a row of **ports**. Each port is a TypeScript interface
with a zod schema for what goes in and what comes out (`src/modules/contracts.ts`),
and the code Butler ships is one **adapter** behind it. You may put another
adapter behind any port: a tool on a connected MCP server, an HTTPS endpoint,
or, for hearing you, a command speaking the voice helper's JSON-lines protocol.
The core never moves. The policy (its floors, the while-you-speak allow-list,
protected sites, credentials), the approval model, the journal and the
diagnostics judge every adapter's output exactly as they judge the built-in's.
An adapter can make Butler smarter, slower or wrong; it cannot make it less
safe. The design is `.data/design/modules.md`; the registry is
`src/modules/registry.ts`; the built-in adapters are `electron/modules.ts`.

## The ports

| Port                    | What it does                                                     | Built-in adapter                                                                               | Pluggable as                                                                                                     |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `recognizer`            | microphone → wake phrase → partial and final transcripts         | `native/bin/coarena-voice` (Apple speech, on device)                                           | **command**: any binary speaking the voice helper's JSON-lines protocol (docs/RECOGNIZER_PROTOCOL.md, lane MOD3) |
| `clauseSegmenter`       | the growing partial → committed clauses                          | `src/voice/stream.ts`                                                                          | MCP tool `segment_clauses`, HTTP                                                                                 |
| `fastDecider`           | a committed clause → a navigational action or none               | `src/voice/fast.ts` (rules → recipes → the choice model)                                       | MCP tool `decide_clause`, HTTP                                                                                   |
| `choiceModel`           | one fixed multiple-choice question → a choice with a probability | Jev through OpenRouter (`src/providers/jev-clause.ts`)                                         | OpenRouter model id, HTTP, MCP tool `choose`                                                                     |
| `recipes`               | sites → URL templates and the words that select them             | the table in `src/voice/recipes.ts`                                                            | **file**: `~/Library/Application Support/coarena-open-assist/recipes.json`, merged over the built-ins            |
| `urlOpener`             | load an address in Butler's browser without keys or clicks       | `electron/open-url.ts` (the tab this app navigated by AppleScript, else LaunchServices `open`) | MCP tool `open_url` (a browser server's navigate mapped to it), HTTP                                             |
| `appOpener`, `scroller` | open an application by name; continuous scroll                   | the native helper                                                                              | built-in only for now (declared, so the pane says so)                                                            |
| `dialogDecider`         | the turn's answer, act or ask                                    | the text model with the dialog prompt, or Jev                                                  | your provider choice, plus `choiceModel`                                                                         |
| `taskModel`             | the computer-use steps                                           | `src/providers/http.ts`                                                                        | your provider choice                                                                                             |
| `tts`                   | say a sentence                                                   | the `voiceEngine` setting: system, Kokoro or OpenAI                                            | MCP tool `speak` (returns wav audio, or plays it itself), HTTP                                                   |
| `memory`                | recall and learning                                              | `src/memory`                                                                                   | declared; adapters later                                                                                         |

What crosses each port, in `src/modules/contracts.ts`:

- `segment_clauses`: in `{ text, atMs, previous: Clause[] }` → out `{ clauses: Clause[], events: ClauseEvent[] }`. Stateless: Butler keeps the clauses and hands them back with the next partial. The final sentence is always cut by Butler's own segmenter, and a committed clause the final no longer says is dropped by Butler's own comparison, never by the adapter.
- `decide_clause`: in `{ clause, context }` → out a `FastAction` (`open_app`, `open_url`, `scroll` or `none`). An `open_url` may leave `siteKey` and `label` out; Butler names it by its host and the search read from the address. Every `open_url` is re-checked: a full http or https address without credentials (the action schema), then the policy while speaking, which refuses a protected host outright whatever the autonomy setting.
- `choose`: in `{ question: { id, choices, prompt }, state }` → out `{ choice, p }`. `prompt` carries the question's instructions and the meaning of each choice as JSON text, so the built-in rebuilds the very question and an adapter reads every word of it. A `choice` outside `choices` is discarded; `p` is clamped to [0, 1].
- `open_url`: in `{ url, browser? }` → out `{ navigated, method }`.
- `speak`: in `{ text, voice? }` → out `{ audio?, played?, ms }`. `audio` is base64 wav; Butler plays it through the voice helper as it plays the natural voice, at the wav's own rate (8 to 48 kHz, 8/16/24/32-bit integer or float, channels averaged). `played: true` means the adapter spoke. Mp3 is not decoded: the sentence falls back to the engines with the status `mp3_unsupported`.

## Settings

`settings.modules` (`src/core/schema.ts`), every key optional and "built-in" when absent (Jev for the choice model):

```ts
modules: {
  clauseSegmenter?: ModuleChoice; fastDecider?: ModuleChoice; urlOpener?: ModuleChoice; tts?: ModuleChoice;
  choiceModel?: { kind: "jev" } | { kind: "openrouter"; model } | { kind: "http"; url } | { kind: "mcp"; server; tool };
  recognizer?: { kind: "builtin" } | { kind: "command"; command; args: string[] };
}
type ModuleChoice =
  | { kind: "builtin" }
  | { kind: "mcp"; server: string; tool: string; fallback: boolean } // a connected server's ticked tool
  | { kind: "http"; url: string; fallback: boolean };                // https POST, JSON in and out
```

`fallback: true` (the default) means an adapter's error, timeout or reply that
fails the port's schema falls back to the built-in for that call, traced
`ModuleFallback { port, kind, code }`; `false` means the stage answers "none"
or skips. Budgets are the port's: a `fastDecider` adapter has the same 250 ms
target as the built-in, and a slow call is traced `ModuleSlow`.

Two rules hold at save time (`src/core/privacy.ts` `validateModuleSettings`):
a tool choice must name a connected server (forgetting a server resets every
choice that named it), and in **Private local** no adapter may reach the
internet: an HTTPS endpoint that is not loopback, a tool on a server declared
`internet` or reached over HTTP, and an OpenRouter model are refused with one
fixed line. The same rule the task model has.

## Settings › Modules

One row per stage (`src/ui/settings-modules.tsx`, after Tools): the stage in
plain words (Hearing you, Cutting a sentence into clauses, Deciding what a
clause means, The quick choice model, Site recipes, Loading a web address,
Opening an application, Scrolling, Understanding a request, Doing the task,
Speaking, Remembering), the adapter now in force, a picker (Built-in · each
connected server's ticked tools, by server and tool name · HTTP endpoint · for
the choice model an OpenRouter model id · for hearing you, a command and its
arguments), the "fall back to Built-in" switch, and the registry's last code
and latency for the port ("Last call failed: timeout · 620 ms · 3 calls").
The Site recipes row shows the user file's path, how many entries loaded over
the built-ins and which entries were rejected, by index and code, with a
Re-read button. Under every row one sentence says what never changes whatever
the adapter. Choices are saved with the form; the status is read from the
registry while the pane is open (`modulesStatus`, `recipesStatus` on the bridge).

## The recipes file

`~/Library/Application Support/coarena-open-assist/recipes.json` is a JSON
array of site recipes. It is read when Butler starts, whenever it changes and
whenever Settings opens; its absence is normal. A user entry replaces the
built-in with the same `key`; a new key is appended.

```json
[
  {
    "key": "hn",
    "label": "Hacker News",
    "names": ["hacker news", "hn"],
    "domain": "ycombinator.com",
    "host": "hn.algolia.com",
    "home": "https://news.ycombinator.com/",
    "templates": { "search": "https://hn.algolia.com/?q={q}" }
  },
  {
    "key": "music",
    "label": "Music",
    "names": ["music", "apple music"],
    "domain": "music.apple.com",
    "host": "music.apple.com",
    "home": "https://music.apple.com/",
    "templates": {},
    "app": "Music"
  }
]
```

- `key`: a short code (`^[a-z][a-z0-9_-]*$`, ≤ 40), the same rule a streamed step's site code follows.
- `label`: how the pill and the run name the site (≤ 40).
- `names`: how people say it, one to eight lowercase names of at most 40 characters ("google maps" beats "google" when both fit).
- `domain`: a page whose host is this domain or under it counts as this site ("search for cats" on the site searches the site).
- `host`: the one host every template must be on.
- `home`: an https address on `host` or under `domain`.
- `templates`: `search` and/or `directions`, each an https address on `host` with exactly one `{q}`, which receives your words URL-encoded. Nothing else of the address changes. A dictated address is never loaded.
- `app`: name an application instead (Spotify, the App Store): the recipe opens it and builds no address.

Every entry stands or falls on its own. A bad one is rejected by index with a
code (`key`, `label`, `names`, `domain`, `host`, `home`, `templates`, `app`,
`home_scheme`, `home_host`, `template_scheme`, `template_placeholder`,
`template_credentials`, `template_host`, `duplicate_key`, `too_many`,
`not_object`, `invalid`), shown in the pane and traced `RecipesFileRejected
{ index, code }`; the load is traced `RecipesFileLoaded { loaded, rejected }`.
A file that is not a JSON array loads nothing and says so. At most 100 entries.
A user recipe on a protected site is still refused by the policy's floor.

## Safety, stated once

An adapter's output is data. `open_url` from any adapter: http(s), no
credentials, host not protected, and while you speak only navigation.
`decide_clause`: a clause with a consequential or irreversible word or a
credential is refused before any adapter is asked. `choose`: probabilities
are clamped and a choice model never produces text that runs. `speak`: text
goes out only under the same privacy tier as the task model; Private local
refuses an internet voice before it is asked. MCP adapters inherit the tool
layer's consent sheet, trust tier and network sandbox. Nothing here touches
docs/THREAT_MODEL.md's floors; that file has one row saying so.

## Diagnostics

Content-free, as everything else Butler writes: `ModuleFallback { port, kind,
code }`, `ModuleSlow { port, kind, ms }`, `RecognizerStarted { kind }`,
`RecipesFileLoaded { loaded, rejected }`, `RecipesFileRejected { index, code }`.
Never an adapter's words, an address or an entry.

## Write your own adapter

Lane MOD3's section: the reference MCP server under `examples/modules/mcp-modules/`,
`npm run modules:check` (`scripts/modules-check.mjs`) and docs/RECOGNIZER_PROTOCOL.md.

## What only a live run confirms

That a connected server's `decide_clause` answers inside the 250 ms budget on
this Mac (the registry's `ModuleSlow` line and the pane's latency say); that
`fs.watch` on the data folder reports an editor's save of `recipes.json` once
(atomic saves rename, which the folder watch sees and the debounce folds); that
a wav an adapter returns plays cleanly through the helper's PCM path at rates
other than 24 kHz; that a replacement recognizer command receives macOS's
microphone prompt for itself and its `transcript_partial` lines drive the early
start and the streamed actions as the built-in helper's do; and that the
Settings window's Save applies a module change without a restart (settings are
read live at each call).
