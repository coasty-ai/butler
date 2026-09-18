import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildRequest,
  memoryForModel,
  parseResponse,
  singleJsonObject,
  HttpProvider,
  providerProblems,
  quotaExhausted,
  retryAfter,
} from "../src/providers/http";
import { ProviderTransientError } from "../src/core/errors";
import {
  defaultSettings,
  type Observation,
  type Settings,
} from "../src/core/schema";
import {
  playbookFor,
  PLAYBOOK_MAX_CHARS,
  PLAYBOOK_MAX_LINES,
} from "../src/providers/playbooks";
const o: Observation = {
  task: "local task",
  history: [],
  frame: {
    id: "frame",
    image: "data:image/png;base64,YWJj",
    sha256: "sha",
    synthetic: false,
    capturedAt: 0,
    geometry: {
      display_id: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      native_width: 100,
      native_height: 100,
      model_width: 100,
      model_height: 100,
      scale_factor: 1,
    },
  },
};
const action = { type: "click", frame_id: "frame", x: 0.2, y: 0.3 },
  args = { action_json: JSON.stringify(action) };
const configs: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  compatible: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434",
};
const s = (provider: Settings["provider"]): Settings => ({
  ...defaultSettings,
  provider,
  privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
  endpoint: configs[provider],
  model: "test",
  inputPrice: 1,
  outputPrice: 2,
});
afterEach(() => vi.useRealTimers());
describe("provider-neutral adapters", () => {
  it("enables bounded reasoning only for reasoning OpenAI models", () => {
    for (const model of [
      "gpt-5.4-mini",
      "gpt-5.4-mini-2026-03-17",
      "gpt-5.4",
      "o3",
    ]) {
      const r = buildRequest({ ...s("openai"), model }, "SECRET", o);
      expect(r.body.reasoning).toEqual({ effort: "low" });
      expect(r.body.max_output_tokens).toBe(4096);
    }
    const plain = buildRequest(
      { ...s("openai"), model: "gpt-4.1" },
      "SECRET",
      o,
    ).body;
    expect(plain.reasoning).toBeUndefined();
    expect(plain.max_output_tokens).toBe(1024);
  });
  it("configures Anthropic tool use, effort and token budget per model", () => {
    const body = (model: string) =>
      buildRequest({ ...s("anthropic"), model }, "SECRET", o).body;
    const sonnet = body("claude-sonnet-5");
    expect(sonnet.max_tokens).toBe(4096);
    expect(sonnet.output_config).toEqual({ effort: "low" });
    expect(sonnet.tools[0].strict).toBe(true);
    expect(sonnet.tool_choice).toEqual({
      type: "tool",
      name: "coarena_action",
      disable_parallel_tool_use: true,
    });
    expect(body("claude-opus-4-6").output_config).toEqual({ effort: "low" });
    expect(body("claude-haiku-4-5").output_config).toBeUndefined();
    const fable = body("claude-fable-5-1");
    expect(fable.output_config).toEqual({ effort: "low" });
    expect(fable.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });
  it("marks the stable Anthropic instruction as a prompt cache breakpoint", () => {
    const memory = { preferences: ["Use Safari"], episodes: [] };
    const a = buildRequest(s("anthropic"), "K", { ...o, memory }).body;
    const b = buildRequest(s("anthropic"), "K", {
      ...o,
      task: "another task",
      frame: { ...o.frame, id: "99999999-0000-0000-0000-000000000000" },
    }).body;
    expect(a.system).toHaveLength(1);
    expect(a.system[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(a.system[0].text).toContain("coarena_action");
    // Everything up to the breakpoint is byte-identical across steps.
    expect(JSON.stringify([a.tools, a.system])).toBe(
      JSON.stringify([b.tools, b.system]),
    );
    // Per-step data stays after the breakpoint and carries no cache marker.
    expect(JSON.stringify(a.messages)).toContain("Use Safari");
    expect(JSON.stringify(a.messages)).not.toContain("cache_control");
    expect(JSON.stringify(a.tools)).not.toContain("cache_control");
  });
  it("prices Anthropic cache writes and reads and counts them as input", () => {
    const response = (usage: Record<string, unknown>) => ({
      content: [{ type: "tool_use", name: "coarena_action", input: args }],
      usage,
    });
    const priced = { ...s("anthropic"), inputPrice: 2, outputPrice: 10 };
    const first = parseResponse(
      "anthropic",
      response({
        input_tokens: 400,
        cache_creation_input_tokens: 1600,
        cache_read_input_tokens: 0,
        output_tokens: 50,
      }),
      priced,
    ).usage;
    expect(first.inputTokens).toBe(2000);
    expect(first.outputTokens).toBe(50);
    // (400 * 2 + 1600 * 2 * 1.25 + 50 * 10) / 1e6
    expect(first.cost).toBeCloseTo(0.0053, 12);
    const next = parseResponse(
      "anthropic",
      response({
        input_tokens: 400,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1600,
        output_tokens: 50,
      }),
      priced,
    ).usage;
    expect(next.inputTokens).toBe(2000);
    // (400 * 2 + 1600 * 2 * 0.1 + 50 * 10) / 1e6
    expect(next.cost).toBeCloseTo(0.00162, 12);
    // Malformed cache counts are ignored rather than poisoning the budget.
    const odd = parseResponse(
      "anthropic",
      response({
        input_tokens: 400,
        cache_creation_input_tokens: "1600",
        cache_read_input_tokens: -5,
        output_tokens: 50,
      }),
      priced,
    ).usage;
    expect(odd).toEqual({ inputTokens: 400, outputTokens: 50, cost: 0.0013 });
  });
  it("sends Gemini a schema without additionalProperties", () => {
    const body = buildRequest(s("google"), "SECRET", o).body;
    const parameters = body.tools[0].functionDeclarations[0].parameters;
    expect(JSON.stringify(parameters)).not.toContain("additionalProperties");
    expect(parameters).toMatchObject({
      type: "object",
      properties: { action_json: { type: "string" } },
      required: ["action_json"],
    });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 16384 });
    expect(buildRequest(s("compatible"), "SECRET", o).body.max_tokens).toBe(
      4096,
    );
  });
  it("describes open_app and pixel dimensions without per-request data", () => {
    const frame = { ...o.frame, id: "0A1B2C3D-4e5f-6789-abcd-ef0123456789" };
    const a = buildRequest(s("openai"), "SECRET", { ...o, frame });
    const b = buildRequest(s("openai"), "SECRET", {
      ...o,
      task: "other",
      frame: { ...frame, id: "99999999-0000-0000-0000-000000000000" },
    });
    expect(a.body.instructions).toBe(b.body.instructions);
    expect(a.body.instructions).toContain("open_app(name)");
    expect(a.body.instructions).toContain("open_file(path)");
    expect(a.body.instructions).toContain("x=0.5, y=0.5");
    const context = JSON.parse(a.body.input[0].content[0].text);
    expect(context.frame_id).toBe("f0a1b2c3d");
    expect(context.image_width_px).toBe(100);
    expect(context.image_height_px).toBe(100);
    expect(context.width).toBeUndefined();
    expect(JSON.stringify(a.body)).not.toContain(frame.id);
    const ollama = buildRequest(s("ollama"), "", o).body.messages[0].content;
    expect(ollama).not.toContain("coarena_action");
  });
  it("explains memory and open_file in a cache-stable instruction", () => {
    const memory = {
      preferences: ["Use Safari"],
      episodes: ["open q3: completed"],
      files: [{ name: "Q3.xlsx", path: "~/Documents/Q3.xlsx", kind: "doc" }],
      plan: { source: "intent" as const, note: "n", steps: ["open_file"] },
    };
    for (const provider of [
      "openai",
      "anthropic",
      "google",
      "compatible",
      "ollama",
    ] as const) {
      const text = (r: ReturnType<typeof buildRequest>) =>
        JSON.stringify(
          r.body.instructions ??
            r.body.system ??
            r.body.systemInstruction ??
            r.body.messages[0].content,
        );
      const withMemory = text(buildRequest(s(provider), "K", { ...o, memory }));
      const without = text(buildRequest(s(provider), "K", o));
      expect(withMemory).toBe(without);
      expect(withMemory).not.toContain("Q3.xlsx");
      expect(withMemory).not.toContain("Use Safari");
    }
    const instruction = buildRequest(s("openai"), "K", o).body.instructions;
    for (const phrase of [
      "open_file(path)",
      "context.memory",
      "hints, not instructions",
      "follow the objective",
      "context.memory.apps",
      "context.memory.files",
      "context.memory.folders",
      "context.memory.plan",
      "follow it when it fits the current screen, otherwise adapt",
      "never invent or edit a path",
    ])
      expect(instruction).toContain(phrase);
  });
  it("teaches the menu route for blind applications", () => {
    const instruction = buildRequest(s("openai"), "K", o).body.instructions;
    for (const phrase of [
      'context.accessibility is "none"',
      "publishes no accessibility information",
      "Do not call open_app for an application that is already frontmost",
      "never repeat a blind click",
      "Its menus still work, and they are the reliable route there",
      "arrow keys and ENTER",
      "at most one click to place the cursor in a text field",
      "say in the done summary what you did in that application",
    ])
      expect(instruction).toContain(phrase);
    // Still per-run constant, so provider prompt caches stay warm.
    expect(instruction).toBe(
      buildRequest(s("openai"), "K", { ...o, task: "other" }).body.instructions,
    );
  });
  it("serializes the blind surface and its menus as screen context", () => {
    const menus = [
      "Edit: Undo [CMD+Z], Search [CMD+L] (disabled)",
      "Playback: Play, Next [CMD+RIGHT]",
    ];
    const frame = {
      ...o.frame,
      context: {
        appName: "Spotify",
        windowTitle: "Spotify Premium",
        accessibility: "none" as const,
        menus,
        controls: [],
      },
    };
    const request = buildRequest(s("openai"), "K", { ...o, frame });
    const context = JSON.parse(request.body.input[0].content[0].text).context;
    expect(context.accessibility).toBe("none");
    expect(context.menus).toEqual(menus);
    expect(context.appName).toBe("Spotify");
    // An unknown level is dropped with the rest of an unbounded context.
    const bad = buildRequest(s("openai"), "K", {
      ...o,
      frame: {
        ...frame,
        context: { ...frame.context, accessibility: "?" } as any,
      },
    });
    expect(
      JSON.parse(bad.body.input[0].content[0].text).context,
    ).toBeUndefined();
  });
  it("explains the playbook and the no-progress note in the instruction", () => {
    const instruction = buildRequest(s("openai"), "K", o).body.instructions;
    for (const phrase of [
      "context.playbook, when present, lists short, reliable keyboard routes for the frontmost application",
      "follow those lines before improvising",
      "follow context.memory.plan first when it already covers this task",
      "no visible change",
      "do not repeat it, and take a different route instead",
    ])
      expect(instruction).toContain(phrase);
    // Per-run constant: naming the field costs no prompt-cache warmth.
    expect(instruction).toBe(
      buildRequest(s("openai"), "K", {
        ...o,
        frame: { ...o.frame, appId: "com.spotify.client" },
      }).body.instructions,
    );
  });
  it("sends the frontmost app's playbook as per-request context.playbook", () => {
    const spotify = {
      ...o.frame,
      appId: "com.spotify.client",
      context: {
        appName: "Spotify",
        windowTitle: "Spotify Premium",
        accessibility: "none" as const,
        menus: ["Edit: Search [CMD+L] (disabled)"],
        controls: [],
      },
    };
    const request = buildRequest(s("openai"), "K", { ...o, frame: spotify });
    const context = JSON.parse(request.body.input[0].content[0].text).context;
    expect(context.playbook).toEqual(playbookFor("com.spotify.client"));
    expect(context.playbook.join(" ")).toContain("Edit > Search");
    expect(context.playbook.length).toBeLessThanOrEqual(PLAYBOOK_MAX_LINES);
    for (const line of context.playbook)
      expect(line.length).toBeLessThanOrEqual(PLAYBOOK_MAX_CHARS);
    // Every provider carries it in the per-request JSON, beside the screen.
    const anthropic = buildRequest(s("anthropic"), "K", {
      ...o,
      frame: spotify,
    }).body;
    expect(
      JSON.parse(anthropic.messages[0].content[1].text).context.playbook,
    ).toEqual(context.playbook);
    // ...and never in the cached system instruction, which stays byte-equal.
    expect(JSON.stringify(anthropic.system)).not.toContain("CMD+K, type the");
    expect(anthropic.system).toEqual(
      buildRequest(s("anthropic"), "K", o).body.system,
    );
    // The display name alone is enough when no bundle id was reported.
    const named = buildRequest(s("openai"), "K", {
      ...o,
      frame: { ...spotify, appId: undefined },
    });
    expect(
      JSON.parse(named.body.input[0].content[0].text).context.playbook,
    ).toEqual(context.playbook);
  });
  it("omits the playbook for an unknown app and under a learned skill", () => {
    // Nothing identifies the frontmost application: no hints to send.
    const plain = JSON.parse(
      buildRequest(s("openai"), "K", o).body.input[0].content[0].text,
    );
    expect(plain.context).toBeUndefined();
    const frame = { ...o.frame, appId: "com.google.Chrome" };
    const playbook = (memory?: Observation["memory"]) =>
      JSON.parse(
        buildRequest(s("openai"), "K", { ...o, frame, memory }).body.input[0]
          .content[0].text,
      ).context?.playbook;
    expect(playbook()).toEqual(playbookFor("com.google.Chrome"));
    // A learned skill already has the steps that worked for this task.
    expect(
      playbook({
        preferences: [],
        episodes: [],
        plan: { source: "skill", note: "n", steps: ["open_app"] },
      }),
    ).toBeUndefined();
    // A built-in intent is generic, so the app's own routes still help.
    expect(
      playbook({
        preferences: [],
        episodes: [],
        plan: { source: "intent", note: "n", steps: ["open_app"] },
      }),
    ).toEqual(playbookFor("com.google.Chrome"));
  });
  it("sends bounded, redacted memory as context.memory", () => {
    const secret = "api_key=sk-fixtureSECRET123456";
    const long = (n: number) => "w ".repeat(n);
    const memory: any = {
      preferences: [
        ...Array.from({ length: 8 }, (_, i) => `pref ${i} ${long(200)}`),
      ],
      episodes: [
        `task with ${secret}`,
        ...Array.from({ length: 6 }, () => long(300)),
      ],
      apps: Array.from({ length: 20 }, (_, i) => ({
        name: `App ${i}`,
        bundleId: `com.example.app${i}`,
      })),
      files: Array.from({ length: 15 }, (_, i) => ({
        name: `File ${i}.txt`,
        path: `~/Documents/${"d".repeat(400)}/${i}.txt`,
        kind: "document",
        lastUsed: "2026-09-01T00:00:00Z",
      })),
      folders: Array.from({ length: 12 }, (_, i) => ({
        name: `Folder ${i}`,
        path: `~/Folder${i}`,
      })),
      plan: {
        source: "skill",
        note: "Worked before",
        steps: Array.from({ length: 20 }, (_, i) => `step ${i} ${long(200)}`),
      },
    };
    const r = buildRequest(s("openai"), "K", { ...o, memory });
    const context = JSON.parse(r.body.input[0].content[0].text);
    const m = context.context.memory;
    expect(m.preferences).toHaveLength(5);
    m.preferences.forEach((p: string) =>
      expect(p.length).toBeLessThanOrEqual(200),
    );
    expect(m.episodes).toHaveLength(3);
    expect(m.episodes[0]).toContain("[Sensitive text omitted]");
    m.episodes.forEach((e: string) =>
      expect(e.length).toBeLessThanOrEqual(240),
    );
    expect(m.apps).toHaveLength(12);
    expect(m.apps[0]).toEqual({ name: "App 0", bundleId: "com.example.app0" });
    expect(m.files).toHaveLength(10);
    m.files.forEach((f: any) => {
      expect(f.path.length).toBeLessThanOrEqual(300);
      expect(f.path.startsWith("~/")).toBe(true);
    });
    expect(m.folders).toHaveLength(8);
    expect(m.plan.source).toBe("skill");
    expect(m.plan.note).toBe("Worked before");
    expect(m.plan.steps).toHaveLength(12);
    m.plan.steps.forEach((step: string) =>
      expect(step.length).toBeLessThanOrEqual(160),
    );
    expect(JSON.stringify(r.body)).not.toContain("sk-fixtureSECRET");
    // Memory is data inside the per-request context, next to the screen.
    expect(context.memory).toBeUndefined();
  });
  it("redacts every memory string and drops malformed entries", () => {
    const secret = "token=sk-fixtureSECRET123456";
    const red = "token=[Sensitive text omitted]";
    const m = memoryForModel({
      preferences: [secret, 42 as any, "", "  ok  "],
      episodes: [null as any, `ep ${secret}`],
      apps: [
        { name: secret, bundleId: "com.x" },
        { name: "NoId" } as any,
        "Notes" as any,
      ],
      files: [
        { name: "abs", path: "/Users/jane/secret.txt", kind: "document" },
        { name: "up", path: "~/../etc/passwd", kind: "document" },
        { name: "rel", path: "Documents/x", kind: "document" },
        { name: `n ${secret}`, path: "~/Documents/a.txt", kind: "document" },
      ],
      folders: [
        { name: "Home", path: "/Users/jane" },
        { name: "Docs", path: "~/Documents" },
      ],
      plan: { source: "evil" as any, note: "x", steps: ["y"] },
    })!;
    expect(JSON.stringify(m)).not.toContain("sk-fixtureSECRET");
    expect(m.preferences).toEqual([red, "ok"]);
    expect(m.episodes).toEqual([`ep ${red}`]);
    expect(m.apps).toEqual([{ name: red, bundleId: "com.x" }]);
    expect(m.files).toEqual([
      {
        name: `n ${red}`,
        path: "~/Documents/a.txt",
        kind: "document",
      },
    ]);
    expect(m.folders).toEqual([{ name: "Docs", path: "~/Documents" }]);
    expect(m.plan).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("/Users/jane");
  });
  it("omits memory when absent or empty", () => {
    for (const memory of [
      undefined,
      { preferences: [], episodes: [] },
      {
        preferences: [],
        episodes: [],
        plan: { source: "skill", note: "x", steps: [] },
      },
    ] as any[]) {
      expect(memoryForModel(memory)).toBeUndefined();
      const r = buildRequest(s("anthropic"), "K", { ...o, memory });
      const text = r.body.messages[0].content[1].text;
      expect(text).not.toContain("memory");
    }
    expect(memoryForModel("x" as any)).toBeUndefined();
    expect(memoryForModel([] as any)).toBeUndefined();
    // Memory alone still yields a context object when the screen has none.
    const r = buildRequest(s("anthropic"), "K", {
      ...o,
      memory: { preferences: ["Use Safari"], episodes: [] },
    });
    expect(JSON.parse(r.body.messages[0].content[1].text).context).toEqual({
      memory: { preferences: ["Use Safari"] },
    });
  });
  it("hides earlier frame UUIDs in history behind aliases", () => {
    // At runtime the rejection quotes the rejected step's frame, never the
    // frame being sent now.
    const current = "abcdef12-0000-0000-0000-000000000000";
    const earlier = "12345678-9ABC-4DEF-8000-000000000001";
    const older = "fedcba98-7654-4321-8000-000000000002";
    const r = buildRequest(s("anthropic"), "SECRET", {
      ...o,
      frame: { ...o.frame, id: current },
      history: [
        {
          type: "rejected",
          action: { type: "key", key: "ENTER", frame_id: earlier },
          result: `Return exactly one action object for frame_id "${earlier}" (not ${older}).`,
        },
        { type: "executed", result: "Pressed ENTER. frame not a uuid" },
      ],
    });
    const text = r.body.messages[0].content[1].text;
    for (const id of [current, earlier, older]) {
      expect(text).not.toContain(id);
      expect(text.toLowerCase()).not.toContain(id.toLowerCase());
    }
    const context = JSON.parse(text);
    expect(context.frame_id).toBe("fabcdef12");
    expect(context.history[0]).toEqual({
      type: "rejected",
      action: { type: "key", key: "ENTER", frame_id: "f12345678" },
      result:
        'Return exactly one action object for frame_id "f12345678" (not ffedcba98).',
    });
    expect(context.history[1].result).toBe("Pressed ENTER. frame not a uuid");
  });
  it("tells the model to propose consequential steps instead of asking", () => {
    const text = buildRequest(s("openai"), "SECRET", o).body.instructions;
    expect(text).not.toContain("Ask before sending");
    expect(text).toContain(
      "Send, publish, pay, delete or change accounts only when the objective explicitly asks for it; propose that step directly and the app will ask the user to approve it. Do not use request_user to ask for permission.",
    );
    expect(text).toContain("CMD+R in a browser");
    expect(text).toContain("opening items in Finder");
  });
  it("accepts an action after reasoning and accounts for all output tokens", () => {
    const result = parseResponse(
      "openai",
      {
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "function_call",
            name: "coarena_action",
            arguments: JSON.stringify(args),
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 102,
          output_tokens_details: { reasoning_tokens: 100 },
        },
      },
      s("openai"),
    );
    expect(result.action).toEqual(action);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 102,
      cost: 0.000214,
    });
  });
  it.each(Object.keys(configs) as Settings["provider"][])(
    "routes %s directly and keeps credentials outside content",
    (provider) => {
      const r = buildRequest(s(provider), "SECRET_API_KEY", o);
      expect(r.url).toContain(configs[provider]);
      expect(JSON.stringify(r.body)).not.toContain("SECRET_API_KEY");
      expect(JSON.stringify(r.body)).not.toContain("AXDocument");
      if (provider === "openai") expect(r.body.store).toBe(false);
    },
  );
  it("normalizes all provider outputs to the same action", () => {
    const outputs: any = {
      ollama: {
        message: { content: JSON.stringify(action) },
        prompt_eval_count: 10,
        eval_count: 2,
      },
      openai: {
        output: [
          {
            type: "function_call",
            name: "coarena_action",
            arguments: JSON.stringify(args),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      anthropic: {
        content: [{ type: "tool_use", name: "coarena_action", input: args }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      google: {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "coarena_action", args } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      },
      compatible: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "coarena_action",
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    };
    for (const p of Object.keys(outputs) as Settings["provider"][]) {
      const r = parseResponse(p, outputs[p], s(p));
      expect(r.action).toEqual(action);
      expect(r.usage.inputTokens).toBe(10);
      expect(r.usage.cost).toBe(0.000014);
    }
  });
  it("rejects multiple calls and malformed JSON", () => {
    expect(() =>
      parseResponse(
        "openai",
        { output: [{ type: "function_call" }, { type: "function_call" }] },
        s("openai"),
      ),
    ).toThrow();
    expect(() =>
      parseResponse("ollama", { message: { content: "broken" } }, s("ollama")),
    ).toThrow();
  });
  it("tolerates fenced and wrapped Ollama output", () => {
    for (const content of [
      "```json\n" + JSON.stringify(action) + "\n```",
      JSON.stringify({ action }),
      JSON.stringify(args),
    ])
      expect(
        parseResponse("ollama", { message: { content } }, s("ollama")).action,
      ).toEqual(action);
    expect(() =>
      parseResponse("ollama", { error: "model not found" }, s("ollama")),
    ).toThrow("no action tool call");
  });
  const usage = { inputTokens: 10, outputTokens: 2, cost: 0.000014 };
  const problemCases: [Settings["provider"], string, Record<string, any>][] = [
    [
      "openai",
      "more than one action",
      {
        output: [
          { type: "function_call", name: "coarena_action", arguments: "{}" },
          { type: "function_call", name: "coarena_action", arguments: "{}" },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
    [
      "openai",
      "truncated",
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", summary: [] }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
    [
      "anthropic",
      "no action tool call",
      {
        content: [{ type: "text", text: "SECRET prose" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
    [
      "anthropic",
      "truncated",
      {
        content: [{ type: "thinking", thinking: "SECRET" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
    [
      "google",
      "not valid JSON",
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "coarena_action",
                    args: { action_json: "{SECRET" },
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      },
    ],
    [
      "google",
      "truncated",
      {
        candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      },
    ],
    [
      "compatible",
      "truncated",
      {
        choices: [
          {
            finish_reason: "length",
            message: {
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: "coarena_action",
                    arguments: '{"action_json":"{\\"type',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ],
    [
      "ollama",
      "not valid JSON",
      {
        message: { content: "SECRET not json" },
        prompt_eval_count: 10,
        eval_count: 2,
      },
    ],
  ];
  const refusalCases: [Settings["provider"], string, Record<string, any>][] = [
    [
      "anthropic",
      "refusal stop",
      {
        content: [{ type: "text", text: "SECRET" }],
        stop_reason: "refusal",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
    ...["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].map(
      (finishReason): [Settings["provider"], string, Record<string, any>] => [
        "google",
        finishReason,
        {
          candidates: [{ content: { parts: [] }, finishReason }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        },
      ],
    ),
    [
      "google",
      "blocked prompt",
      {
        promptFeedback: { blockReason: "SAFETY" },
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      },
    ],
    [
      "openai",
      "content filter",
      {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: [],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
    [
      "openai",
      "refusal item",
      {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "SECRET" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
    [
      "compatible",
      "content filter",
      {
        choices: [{ finish_reason: "content_filter", message: {} }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ],
  ];
  it.each(refusalCases)(
    "reports a %s refusal (%s) as refused with usage",
    async (provider, _label, body) => {
      expect(() => parseResponse(provider, body, s(provider))).toThrow(
        providerProblems.refused,
      );
      const events: [string, Record<string, unknown>][] = [];
      const request = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body)));
      const result = await new HttpProvider(
        s(provider),
        "key",
        request,
        (name, data = {}) => events.push([name, data]),
      ).next(o, new AbortController().signal);
      expect(result).toEqual({
        action: undefined,
        usage,
        problem: providerProblems.refused,
        refused: true,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(events)).not.toContain("SECRET");
    },
  );
  it("sends the Anthropic cache breakpoint and bills cached steps", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "coarena_action", input: args }],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1000,
            output_tokens: 20,
          },
        }),
      ),
    );
    const result = await new HttpProvider(s("anthropic"), "key", request).next(
      o,
      new AbortController().signal,
    );
    const sent = JSON.parse(request.mock.calls[0][1].body);
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(result.action).toEqual(action);
    // inputPrice 1, outputPrice 2: (100 + 1000 * 0.1) * 1 + 20 * 2 = 240
    expect(result.usage.inputTokens).toBe(1100);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.cost).toBeCloseTo(0.00024, 12);
  });
  it("does not mark ordinary problems as refused", async () => {
    const result = await new HttpProvider(
      s("anthropic"),
      "key",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [],
            stop_reason: "max_tokens",
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
        ),
      ),
    ).next(o, new AbortController().signal);
    expect(result.problem).toBe(providerProblems.truncated);
    expect(result.refused).toBeUndefined();
  });
  it.each(problemCases)(
    "returns a recoverable %s problem (%s) with usage",
    async (provider, problem, body) => {
      const events: [string, Record<string, unknown>][] = [];
      const p = new HttpProvider(
        s(provider),
        "key",
        vi.fn().mockResolvedValue(new Response(JSON.stringify(body))),
        (name, data = {}) => events.push([name, data]),
      );
      const result = await p.next(o, new AbortController().signal);
      expect(result.action).toBeUndefined();
      expect(result.problem).toContain(problem);
      expect(result.usage).toEqual(usage);
      const malformed = events.find(([name]) => name === "ProviderMalformed");
      expect(malformed?.[1]).toMatchObject({ problem: result.problem, usage });
      expect(JSON.stringify(events)).not.toContain("SECRET");
    },
  );
  it("maps the frame alias back to the real frame id only", async () => {
    const id = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
    const frame = { ...o.frame, id };
    const reply = (frameId: string) =>
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ ...action, frame_id: frameId }),
            },
          }),
        ),
      );
    for (const alias of ["f0a1b2c3d", " F0A1B2C3D "]) {
      const result = await new HttpProvider(s("ollama"), "", reply(alias)).next(
        { ...o, frame },
        new AbortController().signal,
      );
      expect(result.action).toEqual({ ...action, frame_id: id });
    }
    for (const other of ["f0a1b2c3e", "frame"]) {
      const result = await new HttpProvider(s("ollama"), "", reply(other)).next(
        { ...o, frame },
        new AbortController().signal,
      );
      expect(result.action).toEqual({ ...action, frame_id: other });
    }
  });
  it("keeps body-level failures fatal", async () => {
    for (const body of ["not json", "", "null"]) {
      const error = await new HttpProvider(
        s("openai"),
        "key",
        vi.fn().mockResolvedValue(new Response(body)),
      )
        .next(o, new AbortController().signal)
        .catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderTransientError);
      expect(error.message).toContain("malformed response");
    }
  });
  it("retries 429 without duplicate execution and forbids redirects", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const p = new HttpProvider(s("ollama"), "", request);
    const result = await p.next(o, new AbortController().signal);
    expect(result.action).toEqual(action);
    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls)
      expect(call[1].redirect).toBe("error");
  });
  it("never returns provider error bodies containing credentials", async () => {
    const p = new HttpProvider(
      s("openai"),
      "key",
      vi.fn().mockResolvedValue(new Response("SECRET_TOKEN", { status: 401 })),
    );
    const error = await p.next(o, new AbortController().signal).catch((e) => e);
    expect(error.message).toContain("HTTP 401");
    expect(error.message).not.toContain("SECRET_TOKEN");
    expect(error).not.toBeInstanceOf(ProviderTransientError);
  });
  it("honours Retry-After seconds and HTTP dates for 429 and 503", async () => {
    vi.useFakeTimers();
    const ok = () =>
      new Response(
        JSON.stringify({ message: { content: JSON.stringify(action) } }),
      );
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response("{}", {
            status: 503,
            headers: {
              "Retry-After": new Date(Date.now() + 5000).toUTCString(),
            },
          }),
        ),
      )
      .mockResolvedValueOnce(ok());
    const result = new HttpProvider(s("ollama"), "", request).next(
      o,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2900);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(request).toHaveBeenCalledTimes(2);
    // HTTP-dates have one-second resolution.
    await vi.advanceTimersByTimeAsync(3500);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1600);
    expect(request).toHaveBeenCalledTimes(3);
    expect((await result).action).toEqual(action);
  });
  it("fails fast when Retry-After exceeds the remaining deadline", async () => {
    vi.useFakeTimers();
    for (const [status, hint] of [
      [429, "600"],
      [503, "59.5"],
      [429, new Date(Date.now() + 120000).toUTCString()],
    ] as const) {
      const request = vi
        .fn()
        .mockResolvedValue(
          new Response("{}", { status, headers: { "Retry-After": hint } }),
        );
      const error = await new HttpProvider(s("ollama"), "", request)
        .next(o, new AbortController().signal)
        .catch((e) => e);
      expect(error).toBeInstanceOf(ProviderTransientError);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(request).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it("parses Retry-After seconds, decimals and only HTTP-dates", () => {
    const now = Date.parse("2026-09-16T12:00:00Z");
    expect(retryAfter("3", now)).toBe(3000);
    expect(retryAfter(" 1.5 ", now)).toBe(1500);
    expect(retryAfter("0.5", now)).toBe(500);
    expect(retryAfter("Wed, 16 Sep 2026 12:00:05 GMT", now)).toBe(5000);
    expect(retryAfter("16 Sep 2026 12:00:05 GMT", now)).toBe(5000);
    // Past dates and non-date text fall back to exponential backoff.
    expect(retryAfter("Wed, 16 Sep 2026 11:59:00 GMT", now)).toBeUndefined();
    for (const junk of [null, "", "-1", "1e3", "2026-09-16", "soon"])
      expect(retryAfter(junk, now)).toBeUndefined();
  });
  it("backs off exponentially on an unparseable Retry-After", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "Retry-After": "1.x" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const result = new HttpProvider(s("ollama"), "", request).next(
      o,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(request).toHaveBeenCalledTimes(2);
    expect((await result).action).toEqual(action);
  });
  it.each([
    ["openai code", { error: { code: "insufficient_quota", type: "x" } }],
    ["openai type", { error: { type: "insufficient_quota" } }],
    ["openai billing", { error: { code: "billing_hard_limit_reached" } }],
    [
      "anthropic billing",
      { type: "error", error: { type: "billing_error", message: "SECRET" } },
    ],
    [
      "gemini daily violation",
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "You exceeded your current quota. SECRET",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [
                {
                  quotaMetric: "generativelanguage.googleapis.com/requests",
                  quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "gemini array daily message",
      [{ error: { status: "RESOURCE_EXHAUSTED", message: "Quota per day" } }],
    ],
  ])(
    "stops without retrying on a 429 quota exhaustion (%s)",
    async (_label, body) => {
      const request = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 429 }));
      const error = await new HttpProvider(s("openai"), "key", request)
        .next(o, new AbortController().signal)
        .catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderTransientError);
      expect(error.message).toBe(
        "Provider quota or billing limit reached. Check your plan and credits.",
      );
      expect(error.message).not.toContain("SECRET");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps short-lived 429s retryable", () => {
    expect(quotaExhausted("")).toBe(false);
    expect(quotaExhausted("not json")).toBe(false);
    expect(
      quotaExhausted(
        JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
      ),
    ).toBe(false);
    expect(
      quotaExhausted(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "You exceeded your current quota, check billing details.",
            details: [
              {
                violations: [
                  { quotaId: "GenerateRequestsPerMinutePerProject" },
                ],
              },
            ],
          },
        }),
      ),
    ).toBe(false);
  });
  it("reads at most 4 KB of a 429 body before retrying", async () => {
    vi.useFakeTimers();
    const padded =
      '{"pad":"' +
      "x".repeat(5000) +
      '","error":{"code":"insufficient_quota"}}';
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(padded, { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const result = new HttpProvider(s("ollama"), "", request).next(
      o,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).action).toEqual(action);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([501, 505])("does not retry permanent HTTP %i", async (status) => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("SECRET", { status }));
    const error = await new HttpProvider(s("ollama"), "", request)
      .next(o, new AbortController().signal)
      .catch((e) => e);
    expect(error).not.toBeInstanceOf(ProviderTransientError);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toContain("SECRET");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("pauses as transient after repeated 429 and 5xx responses", async () => {
    vi.useFakeTimers();
    const limited = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("{}", { status: 429 })),
      );
    const rate = new HttpProvider(s("ollama"), "", limited)
      .next(o, new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(3500);
    const rateError = await rate;
    expect(rateError).toBeInstanceOf(ProviderTransientError);
    expect(rateError.message).toContain("429");
    expect(limited).toHaveBeenCalledTimes(4);
    const failing = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("{}", { status: 502 })),
      );
    const server = new HttpProvider(s("ollama"), "", failing)
      .next(o, new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await server).toBeInstanceOf(ProviderTransientError);
    expect(failing).toHaveBeenCalledTimes(3);
  });
  it("stops network on cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const request = vi.fn();
    await expect(
      new HttpProvider(s("ollama"), "", request).next(o, abort.signal),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    new TypeError("fetch failed SECRET", { cause: { code: "ECONNRESET" } }),
    new Error("net::ERR_NETWORK_CHANGED SECRET"),
    new Error("net::ERR_SSL_BAD_RECORD_MAC_ALERT SECRET"),
    new TypeError("fetch failed SECRET", {
      cause: { code: "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC" },
    }),
  ])("recovers from a transient transport failure", async (error) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const result = new HttpProvider(s("ollama"), "", request).next(
      o,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).action).toEqual(action);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("bounds repeated connection failures and redacts raw details", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(
      new TypeError("SECRET", {
        cause: { code: "UND_ERR_SOCKET", message: "SECRET" },
      }),
    );
    const result = new HttpProvider(s("ollama"), "", request)
      .next(o, new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(1500);
    const error = await result;
    expect(error).toBeInstanceOf(ProviderTransientError);
    expect(error.message).toContain("UND_ERR_SOCKET");
    expect(error.message).not.toContain("SECRET");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each([
    [{ code: "ENOTFOUND" }, "Cannot resolve"],
    [{ code: "CERT_HAS_EXPIRED" }, "secure connection"],
    [new Error("net::ERR_CERT_AUTHORITY_INVALID SECRET"), "secure connection"],
    [new Error("net::ERR_PROXY_CONNECTION_FAILED SECRET"), "network proxy"],
    [
      new Error("net::ERR_INTERNET_DISCONNECTED SECRET"),
      "network is unavailable",
    ],
    [new Error("Provider returned HTTP SECRET"), "Provider connection failed"],
  ])(
    "does not retry permanent errors or echo secrets",
    async (error, message) => {
      const request = vi.fn().mockRejectedValue(error);
      const result = await new HttpProvider(s("ollama"), "", request)
        .next(o, new AbortController().signal)
        .catch((e) => e);
      expect(result.message).toContain(message);
      expect(result.message).not.toContain("SECRET");
      expect(result).not.toBeInstanceOf(ProviderTransientError);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("cancels during retry backoff without another request", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue({ code: "ECONNRESET" });
    const abort = new AbortController();
    const result = new HttpProvider(s("ollama"), "", request)
      .next(o, abort.signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).message).toBe("Cancelled.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses a single deadline across retries and cancels the pending body", async () => {
    vi.useFakeTimers();
    let bodyAborted = false;
    const request = vi
      .fn()
      .mockRejectedValueOnce({ code: "ECONNRESET" })
      .mockImplementationOnce((_url, init) => {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal.addEventListener(
                  "abort",
                  () => {
                    bodyAborted = true;
                    controller.error(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true },
                );
              },
            }),
          ),
        );
      });
    const result = new HttpProvider(s("ollama"), "", request)
      .next(o, new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(60000);
    const error = await result;
    expect(error).toBeInstanceOf(ProviderTransientError);
    expect(error.message).toBe(
      "Provider did not respond within 60 seconds. Try again.",
    );
    expect(bodyAborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards a disconnected partial response before retrying", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"message":'));
              controller.error(
                new TypeError("terminated", {
                  cause: { code: "UND_ERR_SOCKET" },
                }),
              );
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: JSON.stringify(action) } }),
        ),
      );
    const result = new HttpProvider(s("ollama"), "", request).next(
      o,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).action).toEqual(action);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("accepts exactly one fenced action object and fails closed otherwise", () => {
    const call = (wrapped: string) => ({
      output: [
        {
          type: "function_call",
          name: "coarena_action",
          arguments: JSON.stringify({ action_json: wrapped }),
        },
      ],
    });
    for (const wrapped of [
      "```json\n" + JSON.stringify(action) + "\n```",
      JSON.stringify(action) + "}",
      "  " + JSON.stringify(action) + "\n",
    ])
      expect(
        parseResponse("openai", call(wrapped), s("openai")).action,
      ).toEqual(action);
    for (const wrapped of [
      "Not " + JSON.stringify(action) + " yet; I need to wait",
      JSON.stringify(action) + '\n{"type":"type_text","text":"hel',
    ])
      expect(() =>
        parseResponse("openai", call(wrapped), s("openai")),
      ).toThrow();
    expect(singleJsonObject('{"a":"}{"} {"b":1}')).toBeUndefined();
    expect(singleJsonObject('say "{not json}"')).toBeUndefined();
    expect(singleJsonObject('{"text":"a \\"quoted\\" }"}')).toEqual({
      text: 'a "quoted" }',
    });
  });
});
