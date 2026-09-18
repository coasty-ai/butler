import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CERT_RETRIES_HOURLY,
  RemoteServer,
  type ListenerLike,
} from "../electron/remote/server";
import type {
  IdentityProvider,
  TailscaleDetect,
} from "../electron/remote/tailscale";
import type { Identity, SelfInfo } from "../src/remote/auth";
import { REMOTE_LIMITS } from "../src/remote/auth";
import { runView } from "../src/assistant/run-view";
import {
  defaultSettings,
  type Run,
  type Settings,
  type Snapshot,
} from "../src/core/schema";
import type { TurnPlanKind } from "../src/voice/turns";

const SELF: SelfInfo = {
  nodeId: "nMAC0001CNTRL",
  loginName: "nitish@example.com",
  dnsName: "mac.tail1234.ts.net",
  ipv4: "100.101.102.103",
  ipv6: "fd7a:115c:a1e0::1234",
  certDomains: [],
  backendState: "Running",
};
const PHONE: Identity = {
  nodeId: "nPHONE123CNTRL",
  nodeName: "iphone",
  loginName: "nitish@example.com",
  tagged: false,
  shared: false,
};
const IFACES = [
  {
    name: "lo0",
    address: "127.0.0.1",
    family: "IPv4" as const,
    internal: true,
  },
  {
    name: "en0",
    address: "192.168.1.20",
    family: "IPv4" as const,
    internal: false,
  },
  {
    name: "utun4",
    address: "100.101.102.103",
    family: "IPv4" as const,
    internal: false,
  },
  {
    name: "utun4",
    address: "fd7a:115c:a1e0::1234",
    family: "IPv6" as const,
    internal: false,
  },
];
const ORIGIN = "http://mac.tail1234.ts.net:41680";

type CertPair = { certPem: string; keyPem: string };

class FakeIdentity implements IdentityProvider {
  next: Identity | undefined = PHONE;
  detected: TailscaleDetect = { kind: "standalone", self: SELF };
  serve: unknown = {};
  /** When set, serveConfig() answers only once this settles. */
  holdServe?: Promise<unknown>;
  /** How often the daemon was asked who a peer is. */
  identified = 0;
  certCalls = 0;
  /** What a certificate request gets; nothing, by default. */
  certAnswer: () => Promise<CertPair | undefined> = async () => undefined;
  async detect() {
    return this.detected;
  }
  async identify() {
    this.identified++;
    return this.next;
  }
  async serveConfig() {
    if (this.holdServe) await this.holdServe;
    return this.serve;
  }
  cert() {
    this.certCalls++;
    return this.certAnswer();
  }
}

const run = (patch: Partial<Run> = {}): Run => ({
  id: "run-1",
  task: "quit Notes",
  createdAt: new Date().toISOString(),
  status: "confirming",
  privacy: "PRIVATE_BYOM",
  provider: "openai",
  model: "gpt",
  synthetic: false,
  actions: 1,
  frames: 1,
  usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  summary: "",
  ...patch,
});
const confirming = (reason = "Quit this application?"): Snapshot => ({
  run: run(),
  frame: null,
  events: [],
  pending: {
    action: { type: "hotkey", keys: ["CMD", "Q"], frame_id: "f" },
    reason,
  },
  message: "",
});
const idle: Snapshot = { run: null, frame: null, events: [], message: "" };

interface Harness {
  server: RemoteServer;
  identity: FakeIdentity;
  settings: Settings;
  /** A settings save from elsewhere (the form), applied to the live object. */
  set(patch: Partial<Settings>): void;
  hosts: string[];
  /** The TLS material each listener was created with, in bind order. */
  tls: ({ cert: string; key: string } | undefined)[];
  reals: Server[];
  traces: { event: string; data: Record<string, unknown> }[];
  calls: { converse: string[]; approve: boolean[]; control: string[] };
  snapshot: Snapshot;
  persisted: Partial<Settings>[];
  /** The sealed certificate records the server saved. */
  stored: string[];
  storedCert?: string;
  port(): number;
  presence: "present" | "away" | "unknown";
}

function harness(
  over: Partial<Settings> = {},
  o: { peerAllowed?: boolean; now?: () => number } = {},
): Harness {
  // One object throughout: the callbacks below read h.snapshot and
  // h.presence as the test reassigns them.
  const h = {
    hosts: [] as string[],
    tls: [] as Harness["tls"],
    reals: [] as Server[],
    traces: [] as Harness["traces"],
    calls: {
      converse: [] as string[],
      approve: [] as boolean[],
      control: [] as string[],
    },
    snapshot: idle,
    persisted: [] as Partial<Settings>[],
    stored: [] as string[],
    presence: "away" as Harness["presence"],
  } as Harness;
  const identity = new FakeIdentity();
  const settings: Settings = {
    ...defaultSettings,
    remoteEnabled: true,
    remoteDevices: [
      {
        id: PHONE.nodeId,
        name: "iphone",
        control: true,
        approve: true,
        firstSeen: 1,
        lastSeen: 1,
      },
    ],
    ...over,
  };
  const state = { settings };
  const server = new RemoteServer({
    settings: () => state.settings,
    persist: (patch) => {
      h.persisted.push(patch);
      state.settings = { ...state.settings, ...patch };
    },
    identity,
    certStore: {
      load: () => h.storedCert,
      save: (record) => {
        h.stored.push(record);
      },
    },
    converse: async (text) => {
      h.calls.converse.push(text);
      return { plan: "start" as TurnPlanKind };
    },
    control: {
      pause: () => h.calls.control.push("pause"),
      stop: () => h.calls.control.push("stop"),
      resume: async () => {
        h.calls.control.push("resume");
        return true;
      },
      approve: async (yes) => {
        h.calls.approve.push(yes);
        return true;
      },
      gate: () =>
        h.snapshot.pending && h.snapshot.run
          ? JSON.stringify({
              run: h.snapshot.run.id,
              action: h.snapshot.pending.action,
            })
          : undefined,
    },
    presence: () => h.presence,
    runView: () =>
      runView(h.snapshot, { queued: [], watches: [], now: Date.now() }),
    snapshot: () => h.snapshot,
    thumbnail: () => Buffer.from("JPEG"),
    interfaces: () => IFACES,
    // The production factory binds the tailnet address; here the real
    // listener sits on loopback and only the requested host is recorded.
    createServer: (tls, listener): ListenerLike => {
      const real = createServer(listener);
      h.reals.push(real);
      h.tls.push(tls);
      return {
        listen: (_port, host, cb) => {
          h.hosts.push(host);
          real.listen(0, "127.0.0.1", cb);
        },
        on: (event: string, fn: (...args: any[]) => void) => real.on(event, fn),
        close: (cb?: () => void) => real.close(cb),
        closeAllConnections: () => real.closeAllConnections(),
      };
    },
    peerAllowed: o.peerAllowed === false ? undefined : () => true,
    ...(o.now ? { now: o.now } : {}),
    trace: (event, data) => h.traces.push({ event, data: data ?? {} }),
    pingMs: 40,
    watchdogMs: 0,
  });
  h.server = server;
  h.identity = identity;
  Object.defineProperty(h, "settings", { get: () => state.settings });
  h.set = (patch) => {
    state.settings = { ...state.settings, ...patch };
  };
  // The listener bound last is the live one after a rebind.
  h.port = () => (h.reals.at(-1)!.address() as { port: number }).port;
  return h;
}

/** Polls until the condition holds; the server's background work is async. */
async function until(check: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settled = () => new Promise((r) => setImmediate(r));

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
/** One request on its own socket, so identity is decided afresh each time. */
function call(
  port: number,
  path: string,
  o: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: o.method ?? "GET",
        agent: false,
        headers: { host: "mac.tail1234.ts.net:41680", ...o.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}
const post = (
  port: number,
  path: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  call(port, path, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      cookie: `oa_remote=${token}`,
      "x-remote-token": token,
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** An open event stream with a queue of parsed events. */
function stream(port: number, token: string) {
  const queue: { type: string; data: any }[] = [];
  const waiting: ((e: { type: string; data: any }) => void)[] = [];
  let buffer = "";
  let socket: Socket | undefined;
  let status = 0;
  const ready = new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        agent: false,
        headers: {
          host: "mac.tail1234.ts.net:41680",
          cookie: `oa_remote=${token}`,
        },
      },
      (res) => {
        status = res.statusCode ?? 0;
        socket = res.socket;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let at: number;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const record = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const type = /^event: (.+)$/m.exec(record)?.[1];
            const data = /^data: (.+)$/m.exec(record)?.[1];
            if (!type || !data) continue;
            const event = { type, data: JSON.parse(data) };
            const next = waiting.shift();
            if (next) next(event);
            else queue.push(event);
          }
        });
        resolve();
      },
    );
    req.on("error", reject);
    req.end();
  });
  return {
    ready,
    status: () => status,
    next(type: string, timeoutMs = 1500): Promise<any> {
      const found = queue.findIndex((e) => e.type === type);
      if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0].data);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No ${type} event`)),
          timeoutMs,
        );
        const take = (e: { type: string; data: any }) => {
          if (e.type === type) {
            clearTimeout(timer);
            resolve(e.data);
          } else waiting.push(take);
        };
        waiting.push(take);
      });
    },
    close: () => socket?.destroy(),
    closed: () =>
      new Promise<void>((resolve) =>
        socket?.destroyed ? resolve() : socket?.on("close", () => resolve()),
      ),
  };
}

async function session(h: Harness) {
  const r = await call(h.port(), "/api/session");
  expect(r.status).toBe(200);
  const token = JSON.parse(r.body).token as string;
  return { token, cookie: String(r.headers["set-cookie"]) };
}

let live: Harness[] = [];
afterEach(() => {
  for (const h of live) h.server.close();
  live = [];
});
const up = async (
  over: Partial<Settings> = {},
  o: { peerAllowed?: boolean } = {},
) => {
  const h = harness(over, o);
  live.push(h);
  await h.server.configure();
  return h;
};

describe("binding", () => {
  it("listens only on this node's tailnet addresses", async () => {
    const h = await up();
    expect(h.hosts).toEqual(["100.101.102.103", "fd7a:115c:a1e0::1234"]);
    expect(h.server.status()).toMatchObject({
      state: "on",
      url: "http://mac.tail1234.ts.net:41680",
      https: false,
      tailscale: "standalone",
    });
    // The login is pinned on the first start.
    expect(h.persisted).toContainEqual({ remoteUser: "nitish@example.com" });
  });

  it("binds nothing without a tailnet address, without Tailscale, or when off", async () => {
    const lan = harness();
    live.push(lan);
    (lan.server as any).options.interfaces = () => IFACES.slice(0, 2);
    await lan.server.configure();
    expect(lan.hosts).toEqual([]);
    expect(lan.server.status()).toMatchObject({
      state: "off",
      reason: expect.stringMatching(/Tailscale address/),
    });

    const none = harness();
    live.push(none);
    none.identity.detected = { kind: "none", reason: "not_installed" };
    await none.server.configure();
    expect(none.hosts).toEqual([]);
    expect(none.server.status().reason).toMatch(/Standalone build/);

    const off = await up({ remoteEnabled: false });
    expect(off.hosts).toEqual([]);
    expect(off.server.status()).toMatchObject({ state: "off", enabled: false });
  });

  it("refuses to start when Serve or Funnel holds the port", async () => {
    const h = harness();
    live.push(h);
    h.identity.serve = { AllowFunnel: { "mac.tail1234.ts.net:41680": true } };
    await h.server.configure();
    expect(h.hosts).toEqual([]);
    expect(h.server.status().reason).toContain("41680");
    h.identity.serve = { TCP: { "41680": {} } };
    await h.server.configure();
    expect(h.hosts).toEqual([]);
  });
});

describe("identity at the door", () => {
  it("serves the page with a CSP to an allowed phone, the unpaired page to a stranger of ours, and 403 to the rest", async () => {
    const h = await up();
    const page = await call(h.port(), "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(
      /default-src 'none'; script-src 'nonce-[a-f0-9]{32}'/,
    );
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).not.toMatch(/https?:\/\/(?!mac)/);
    expect(page.body.split("\n").length).toBeLessThan(400);

    h.identity.next = { ...PHONE, nodeId: "nNEW", nodeName: "iPad" };
    const unpaired = await call(h.port(), "/");
    expect(unpaired.status).toBe(200);
    expect(unpaired.body).toContain("Not allowed yet");
    expect(unpaired.body).toContain("iPad");
    expect((await call(h.port(), "/api/session")).status).toBe(403);
    // The stranger is listed for the user, with every switch off.
    expect(h.settings.remoteDevices.find((d) => d.id === "nNEW")).toMatchObject(
      { control: false, approve: false },
    );

    h.identity.next = { ...PHONE, nodeId: SELF.nodeId };
    expect((await call(h.port(), "/")).status).toBe(403);
    h.identity.next = { ...PHONE, loginName: "someone@example.com" };
    expect((await call(h.port(), "/")).status).toBe(403);
    h.identity.next = { ...PHONE, tagged: true };
    expect((await call(h.port(), "/")).status).toBe(403);
    h.identity.next = undefined;
    expect((await call(h.port(), "/")).status).toBe(403);
    expect(
      h.traces
        .filter((t) => t.event === "RemoteDenied")
        .map((t) => t.data.cause),
    ).toEqual(["self", "user", "tagged", "no_identity"]);
  });

  it("answers only to its own names: a rebinding page's Host gets 421 before any route", async () => {
    const h = await up();
    const { token } = await session(h);
    h.snapshot = confirming();
    h.server.onSnapshot(h.snapshot);
    // A page whose DNS was pointed at this Mac is same-origin with it in the
    // phone's browser: the cookie, the header token and an Origin equal to
    // its own name all line up, and only the Host gives it away.
    const rebound = await post(
      h.port(),
      "/api/say",
      token,
      { text: "stop" },
      { host: "evil.example:41680", origin: "http://evil.example:41680" },
    );
    expect(rebound.status).toBe(421);
    expect(h.calls.converse).toEqual([]);
    // The GET routes it would read first are refused the same way.
    for (const path of ["/", "/api/session", "/api/events"])
      expect(
        (await call(h.port(), path, { headers: { host: "evil.example" } }))
          .status,
      ).toBe(421);
    expect(
      (await call(h.port(), "/api/session", { headers: { host: "" } })).status,
    ).toBe(421);
    // An address serves as the Origin as well as the MagicDNS name, and
    // every name of the Mac's own works as the Host, with or without the port.
    const viaAddress = await post(
      h.port(),
      "/api/ask",
      token,
      { kind: "status" },
      {
        host: "100.101.102.103:41680",
        origin: "http://100.101.102.103:41680",
      },
    );
    expect(viaAddress.status).toBe(200);
    for (const host of [
      "100.101.102.103:41680",
      "[fd7a:115c:a1e0::1234]:41680",
      "MAC.tail1234.ts.net:41680",
      "mac.tail1234.ts.net",
    ])
      expect(
        (await call(h.port(), "/api/session", { headers: { host } })).status,
      ).toBe(200);
    expect(
      h.traces
        .filter((t) => t.event === "RemoteDenied")
        .map((t) => t.data.cause),
    ).toEqual(["host", "host", "host", "host", "host"]);
  });

  it("never asks whois about a peer outside the tailnet ranges", async () => {
    const h = await up({}, { peerAllowed: false });
    // Loopback is not a Tailscale address: refused before identify runs.
    expect((await call(h.port(), "/")).status).toBe(403);
    expect(
      h.traces.some(
        (t) => t.event === "RemoteDenied" && t.data.cause === "no_identity",
      ),
    ).toBe(true);
  });

  it("a phone switched off in Settings gets the unpaired page and no session", async () => {
    const h = await up({
      remoteDevices: [
        {
          id: PHONE.nodeId,
          name: "iphone",
          control: false,
          approve: false,
          firstSeen: 1,
          lastSeen: 1,
        },
      ],
    });
    expect((await call(h.port(), "/")).body).toContain("Not allowed yet");
    expect((await call(h.port(), "/api/session")).status).toBe(403);
  });
});

describe("sessions and the event stream", () => {
  it("sets an HttpOnly strict cookie and streams status, steps and pings", async () => {
    const h = await up();
    const { token, cookie } = await session(h);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(cookie).toMatch(
      /^oa_remote=[a-f0-9]{32}; HttpOnly; SameSite=Strict; Path=\/api$/,
    );
    const s = stream(h.port(), token);
    await s.ready;
    expect(s.status()).toBe(200);
    const first = await s.next("status");
    expect(first.view).toMatchObject({
      running: false,
      status: "idle",
      presence: "away",
    });
    h.snapshot = {
      ...confirming(),
      run: run({ status: "executing" }),
      pending: undefined,
      events: [
        {
          event_id: "e1",
          run_id: "run-1",
          sequence_number: 1,
          monotonic_timestamp: 1,
          wall_clock_timestamp: new Date().toISOString(),
          schema_version: 1,
          type: "ActionExecuted",
          data: {
            action: { type: "type_text", text: "hunter2!", frame_id: "f" },
          },
        },
      ],
    };
    h.server.onSnapshot(h.snapshot);
    expect((await s.next("progress")).line).toBe("typed 8 characters");
    expect((await s.next("status")).view).toMatchObject({
      running: true,
      status: "working",
      steps: 1,
    });
    expect(await s.next("ping")).toMatchObject({ at: expect.any(Number) });
    s.close();
  });

  it("asks the daemon again every five minutes on a long stream, and cuts a peer it stops vouching for", async () => {
    const clock = { at: Date.now() };
    const h = harness({}, { now: () => clock.at });
    live.push(h);
    await h.server.configure();
    const { token } = await session(h);
    const s = stream(h.port(), token);
    await s.ready;
    await s.next("status");
    // One whois per socket: the session's and the stream's.
    expect(h.identity.identified).toBe(2);
    await s.next("ping");
    await s.next("ping");
    expect(h.identity.identified).toBe(2);
    clock.at += 5 * 60_000;
    await until(() => h.identity.identified === 3);
    expect(s.status()).toBe(200);
    // The daemon no longer knows the peer: the stream ends at the next check.
    h.identity.next = undefined;
    clock.at += 5 * 60_000;
    await s.closed();
    expect(h.identity.identified).toBe(4);
    expect(
      h.traces.filter((t) => t.event === "RemoteSse").map((t) => t.data.code),
    ).toEqual(["open", "close"]);
  });

  it("a wrong or missing cookie gets no stream, and streams are capped per device", async () => {
    const h = await up();
    const bad = stream(h.port(), "f".repeat(32));
    await bad.ready;
    expect(bad.status()).toBe(403);
    const { token } = await session(h);
    const opened = [];
    for (let i = 0; i <= REMOTE_LIMITS.ssePerDevice; i++) {
      const s = stream(h.port(), token);
      await s.ready;
      opened.push(s);
    }
    expect(opened.map((s) => s.status())).toEqual([200, 200, 429]);
    for (const s of opened) s.close();
  });
});

describe("approvals", () => {
  it("approves a routine step once with the gate-bound nonce, and refuses a replay", async () => {
    const h = await up();
    const { token } = await session(h);
    const s = stream(h.port(), token);
    await s.ready;
    await s.next("status");
    h.snapshot = confirming();
    h.server.onSnapshot(h.snapshot);
    const { view } = await s.next("status");
    expect(view.pending).toMatchObject({
      tier: "routine",
      allowed: true,
      reason: "Quit this application?",
      what: "pressing CMD+Q",
    });
    const { gate, nonce } = view.pending;
    const ok = await post(h.port(), "/api/approve", token, {
      gate,
      nonce,
      answer: "approve",
    });
    expect(JSON.parse(ok.body)).toEqual({
      verdict: "approve",
      reply: "Approved.",
    });
    expect(h.calls.approve).toEqual([true]);
    const again = await post(h.port(), "/api/approve", token, {
      gate,
      nonce,
      answer: "approve",
    });
    expect(JSON.parse(again.body).verdict).toBe("replay");
    expect(h.calls.approve).toEqual([true]);
    expect(
      h.traces.filter((t) => t.event === "RemoteApproval").map((t) => t.data),
    ).toEqual([
      {
        verdict: "approve",
        tier: "routine",
        device: expect.stringMatching(/^d[a-f0-9]{8}$/),
      },
      {
        verdict: "replay",
        tier: "routine",
        device: expect.stringMatching(/^d[a-f0-9]{8}$/),
      },
    ]);
    s.close();
  });

  it("never approves a restricted question, while a skip still goes through", async () => {
    const h = await up();
    const { token } = await session(h);
    const s = stream(h.port(), token);
    await s.ready;
    await s.next("status");
    h.snapshot = confirming("Send this message?");
    h.server.onSnapshot(h.snapshot);
    const { view } = await s.next("status");
    expect(view.pending).toMatchObject({ tier: "never", allowed: false });
    const { gate, nonce } = view.pending;
    const refused = await post(h.port(), "/api/approve", token, {
      gate,
      nonce,
      answer: "approve",
    });
    expect(JSON.parse(refused.body)).toEqual({
      verdict: "tier",
      reply: "Approve this one on the Mac.",
    });
    expect(h.calls.approve).toEqual([]);
    // The refusal spent nothing: the next status for the same gate carries
    // the same nonce, and a Skip with it goes through.
    h.server.onSnapshot({ ...h.snapshot });
    expect((await s.next("status")).view.pending.nonce).toBe(nonce);
    const skip = await post(h.port(), "/api/approve", token, {
      gate,
      nonce,
      answer: "skip",
    });
    expect(JSON.parse(skip.body)).toEqual({
      verdict: "skip",
      reply: "Skipped. The task is paused.",
    });
    expect(h.calls.approve).toEqual([false]);
    // Now it is spent.
    expect(
      JSON.parse(
        (
          await post(h.port(), "/api/approve", token, {
            gate,
            nonce,
            answer: "skip",
          })
        ).body,
      ).verdict,
    ).toBe("replay");
    expect(h.calls.approve).toEqual([false]);
    s.close();
  });

  it("refuses without the approve switch and while someone is at the Mac", async () => {
    const h = await up({
      remoteDevices: [
        {
          id: PHONE.nodeId,
          name: "iphone",
          control: true,
          approve: false,
          firstSeen: 1,
          lastSeen: 1,
        },
      ],
    });
    const { token } = await session(h);
    const s = stream(h.port(), token);
    await s.ready;
    await s.next("status");
    h.snapshot = confirming();
    h.server.onSnapshot(h.snapshot);
    const { view } = await s.next("status");
    expect(view.pending.allowed).toBe(false);
    const { gate, nonce } = view.pending;
    expect(
      JSON.parse(
        (
          await post(h.port(), "/api/approve", token, {
            gate,
            nonce,
            answer: "approve",
          })
        ).body,
      ).verdict,
    ).toBe("not_armed");
    // A skip only pauses and needs only control; the refused Approve left
    // the nonce good for it.
    expect(
      JSON.parse(
        (
          await post(h.port(), "/api/approve", token, {
            gate,
            nonce,
            answer: "skip",
          })
        ).body,
      ).verdict,
    ).toBe("skip");
    expect(h.calls.approve).toEqual([false]);

    const armed = await up();
    const a = await session(armed);
    const as = stream(armed.port(), a.token);
    await as.ready;
    await as.next("status");
    armed.snapshot = confirming();
    armed.presence = "present";
    armed.server.onSnapshot(armed.snapshot);
    const p = (await as.next("status")).view.pending;
    const tap = async () =>
      JSON.parse(
        (
          await post(armed.port(), "/api/approve", a.token, {
            gate: p.gate,
            nonce: p.nonce,
            answer: "approve",
          })
        ).body,
      ).verdict;
    expect(await tap()).toBe("present");
    expect(armed.calls.approve).toEqual([]);
    // Once they leave, the same card (a reopened stream after iOS
    // backgrounding gets the same nonce) approves without a new question.
    armed.presence = "away";
    armed.server.onSnapshot({ ...armed.snapshot });
    expect((await as.next("status")).view.pending.nonce).toBe(p.nonce);
    expect(await tap()).toBe("approve");
    expect(armed.calls.approve).toEqual([true]);
    expect(await tap()).toBe("replay");
    expect(
      armed.traces
        .filter((t) => t.event === "RemoteApproval")
        .map((t) => t.data.verdict),
    ).toEqual(["present", "approve", "replay"]);
    s.close();
    as.close();
  });

  it("locks a phone after three replays, never after stale answers", async () => {
    const stale = await up();
    const st = await session(stale);
    stale.snapshot = confirming();
    stale.server.onSnapshot(stale.snapshot);
    // Approving at the Mac a beat before the phone is the ordinary race:
    // the gate the card named is gone. Three of those must not lock.
    for (let i = 0; i < 3; i++)
      expect(
        JSON.parse(
          (
            await post(stale.port(), "/api/approve", st.token, {
              gate: "0".repeat(32),
              nonce: "1".repeat(32),
              answer: "approve",
            })
          ).body,
        ).verdict,
      ).toBe("stale");
    const ss = stream(stale.port(), st.token);
    await ss.ready;
    const card = (await ss.next("status")).view.pending;
    expect(
      JSON.parse(
        (
          await post(stale.port(), "/api/approve", st.token, {
            gate: card.gate,
            nonce: card.nonce,
            answer: "approve",
          })
        ).body,
      ).verdict,
    ).toBe("approve");
    ss.close();

    const replay = await up();
    const rt = await session(replay);
    const rs = stream(replay.port(), rt.token);
    await rs.ready;
    await rs.next("status");
    replay.snapshot = confirming();
    replay.server.onSnapshot(replay.snapshot);
    const { gate, nonce } = (await rs.next("status")).view.pending;
    // Nonces this phone was never given, for the live gate, are the attack.
    for (let i = 0; i < 3; i++)
      expect(
        JSON.parse(
          (
            await post(replay.port(), "/api/approve", rt.token, {
              gate,
              nonce: "f".repeat(32),
              answer: "approve",
            })
          ).body,
        ).verdict,
      ).toBe("replay");
    expect((await rs.next("notice")).text).toMatch(/locked for an hour/);
    expect(
      JSON.parse(
        (
          await post(replay.port(), "/api/approve", rt.token, {
            gate,
            nonce,
            answer: "approve",
          })
        ).body,
      ),
    ).toEqual({
      verdict: "locked",
      reply: "Approvals from this phone are locked for an hour.",
    });
    expect(replay.calls.approve).toEqual([]);
    rs.close();
  });

  it("drops a POST without the header token, with a foreign origin, or as a form", async () => {
    const h = await up();
    const { token } = await session(h);
    h.snapshot = confirming();
    h.server.onSnapshot(h.snapshot);
    const body = {
      gate: "a".repeat(32),
      nonce: "b".repeat(32),
      answer: "approve",
    };
    const noHeader = await call(h.port(), "/api/approve", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: `oa_remote=${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(noHeader.status).toBe(403);
    expect(
      (
        await post(h.port(), "/api/approve", token, body, {
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(h.port(), "/api/approve", token, body, {
          "content-type": "application/x-www-form-urlencoded",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(h.port(), "/api/approve", token, body, {
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(403);
    expect(h.calls.approve).toEqual([]);
    // With everything right, the made-up nonce is merely stale.
    expect(
      JSON.parse((await post(h.port(), "/api/approve", token, body)).body)
        .verdict,
    ).toBe("stale");
  });
});

describe("say, control and ask", () => {
  it("refuses credentials before the router sees them, and keeps text out of traces", async () => {
    const h = await up();
    const { token } = await session(h);
    const secret = "password: hunter2!! now";
    const r = await post(h.port(), "/api/say", token, { text: secret });
    expect(JSON.parse(r.body).reply).toMatch(/on the Mac/);
    expect(h.calls.converse).toEqual([]);
    const lines = [
      "open Notes and write hello",
      "how's it going?",
      "stop",
      "yes",
      "send the deck to dana@example.com",
    ];
    for (const text of lines) await post(h.port(), "/api/say", token, { text });
    expect(h.calls.converse).toEqual(lines);
    const traced = JSON.stringify(h.traces);
    for (const text of [secret, ...lines]) expect(traced).not.toContain(text);
    expect(traced).not.toContain("hunter2");
    expect(traced).not.toContain(PHONE.loginName);
    expect(traced).not.toContain(PHONE.nodeId);
    expect(traced).not.toContain(token);
    expect(h.traces.filter((t) => t.event === "RemoteSay")).toHaveLength(
      lines.length + 1,
    );
  });

  it("stops, pauses, continues and answers status with fixed lines", async () => {
    const h = await up();
    const { token } = await session(h);
    expect(
      JSON.parse(
        (await post(h.port(), "/api/control", token, { kind: "stop" })).body,
      ),
    ).toEqual({ ok: true, reply: "Stopped." });
    expect(
      JSON.parse(
        (await post(h.port(), "/api/control", token, { kind: "pause" })).body,
      ),
    ).toEqual({ ok: true, reply: "Paused." });
    expect(
      JSON.parse(
        (await post(h.port(), "/api/control", token, { kind: "continue" }))
          .body,
      ),
    ).toEqual({ ok: true, reply: "Continuing." });
    expect(h.calls.control).toEqual(["stop", "pause", "resume"]);
    expect(
      JSON.parse(
        (await post(h.port(), "/api/ask", token, { kind: "status" })).body,
      ).reply,
    ).toBe("Nothing’s running right now.");
    expect(
      (await post(h.port(), "/api/control", token, { kind: "approve" })).status,
    ).toBe(400);
    expect((await post(h.port(), "/api/audio", token, {})).status).toBe(501);
  });

  it("serves a thumbnail only for the current frame and only with screenshots on", async () => {
    const h = await up();
    const { token } = await session(h);
    h.snapshot = {
      ...confirming(),
      frame: {
        id: "frame-1",
        sha256: "x",
        image: "data:image/png;base64,AAAA",
        capturedAt: 1,
        synthetic: false,
        geometry: {
          display_id: 1,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          native_width: 1,
          native_height: 1,
          model_width: 1,
          model_height: 1,
          scale_factor: 1,
        },
      },
    };
    const headers = { cookie: `oa_remote=${token}` };
    expect(
      (await call(h.port(), "/api/frame/frame-1.jpg", { headers })).status,
    ).toBe(404);
    const on = await up({ remoteScreenshots: "thumbnail" });
    const t = await session(on);
    on.snapshot = h.snapshot;
    const ok = await call(on.port(), "/api/frame/frame-1.jpg", {
      headers: { cookie: `oa_remote=${t.token}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/jpeg");
    expect(ok.body).toBe("JPEG");
    expect(
      (
        await call(on.port(), "/api/frame/frame-2.jpg", {
          headers: { cookie: `oa_remote=${t.token}` },
        })
      ).status,
    ).toBe(404);
    expect((await call(on.port(), "/api/frame/frame-1.jpg")).status).toBe(403);
  });
});

describe("configure in flight", () => {
  it("binds nothing when a lock lands while the daemon is being asked", async () => {
    const h = harness();
    live.push(h);
    let release!: (v: unknown) => void;
    h.identity.holdServe = new Promise((r) => (release = r));
    const configuring = h.server.configure();
    // detect() has answered; serveConfig() is the await in flight.
    await settled();
    h.server.lock();
    expect(h.persisted).toContainEqual({ remoteEnabled: false });
    release({});
    await configuring;
    expect(h.hosts).toEqual([]);
    expect(h.server.status()).toMatchObject({
      state: "off",
      enabled: false,
      locked: true,
    });
    expect(h.server.status().url).toBeUndefined();
  });

  it("binds nothing when the setting went off meanwhile, and a quit leaves nothing bound", async () => {
    const off = harness();
    live.push(off);
    let release!: (v: unknown) => void;
    off.identity.holdServe = new Promise((r) => (release = r));
    const configuring = off.server.configure();
    await settled();
    off.set({ remoteEnabled: false });
    release({});
    await configuring;
    expect(off.hosts).toEqual([]);
    expect(off.server.status()).toMatchObject({ state: "off", enabled: false });

    const quit = harness();
    live.push(quit);
    quit.identity.holdServe = new Promise((r) => (release = r));
    const closing = quit.server.configure();
    await settled();
    quit.server.close();
    release({});
    await closing;
    expect(quit.hosts).toEqual([]);
    expect(quit.server.status().state).toBe("off");
  });
});

describe("certificate", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const certPem = readFileSync(join(here, "fixtures/remote-cert.pem"), "utf8");
  // The fake listener never terminates TLS, so no real key is needed.
  const pair: CertPair = {
    certPem,
    keyPem:
      "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n",
  };
  const tls = { cert: pair.certPem, key: pair.keyPem };
  const withDomain = (h: Harness) => {
    h.identity.detected = {
      kind: "standalone",
      self: { ...SELF, certDomains: ["mac.tail1234.ts.net"] },
    };
  };

  it("comes up over plain HTTP at once and rebinds with TLS when the certificate arrives", async () => {
    const h = harness();
    live.push(h);
    withDomain(h);
    let issue!: (v: CertPair) => void;
    h.identity.certAnswer = () => new Promise((r) => (issue = r));
    await h.server.configure();
    // The bind did not wait for DNS-01.
    expect(h.server.status()).toMatchObject({
      state: "on",
      https: false,
      url: "http://mac.tail1234.ts.net:41680",
      note: expect.stringMatching(/Waiting for the HTTPS certificate/),
    });
    expect(h.tls).toEqual([undefined, undefined]);
    expect(h.identity.certCalls).toBe(1);
    // A watchdog tick meanwhile does not ask again.
    await h.server.configure();
    expect(h.identity.certCalls).toBe(1);
    issue(pair);
    await until(() => h.server.status().https);
    expect(h.server.status()).toMatchObject({
      state: "on",
      https: true,
      url: "https://mac.tail1234.ts.net:41680",
      certExpires: expect.any(Number),
    });
    expect(h.tls.slice(2)).toEqual([tls, tls]);
    expect(h.stored).toHaveLength(1);
    expect(JSON.parse(h.stored[0])).toMatchObject({
      domain: "mac.tail1234.ts.net",
      certPem,
    });
    expect(h.traces.some((t) => t.event === "RemoteCertIssued")).toBe(true);
    // Fresh for years: later ticks leave it alone.
    await h.server.configure();
    expect(h.identity.certCalls).toBe(1);
    expect(h.tls).toHaveLength(4);
    expect(
      String((await call(h.port(), "/api/session")).headers["set-cookie"]),
    ).toMatch(/; Secure$/);
  });

  it("a certificate the daemon already holds is serving by the time configure returns", async () => {
    const h = harness();
    live.push(h);
    withDomain(h);
    h.identity.certAnswer = async () => pair;
    await h.server.configure();
    // Bound over HTTP for an instant, then rebound: no minute-long wait
    // for the watchdog.
    expect(h.server.status()).toMatchObject({ state: "on", https: true });
    expect(h.tls).toEqual([undefined, undefined, tls, tls]);
    expect(h.identity.certCalls).toBe(1);
  });

  it("uses a stored certificate without asking for one", async () => {
    const h = harness();
    live.push(h);
    withDomain(h);
    h.storedCert = JSON.stringify({ domain: "mac.tail1234.ts.net", ...pair });
    await h.server.configure();
    expect(h.server.status()).toMatchObject({ state: "on", https: true });
    expect(h.identity.certCalls).toBe(0);
    expect(h.tls).toEqual([tls, tls]);
  });

  it("backs off after a failed issuance: hourly a few times, then daily", async () => {
    const clock = { at: Date.now() };
    const h = harness({}, { now: () => clock.at });
    live.push(h);
    withDomain(h);
    h.identity.certAnswer = async () => {
      throw new Error("ACME says no");
    };
    await h.server.configure();
    await settled();
    expect(h.identity.certCalls).toBe(1);
    expect(h.server.status()).toMatchObject({
      state: "on",
      https: false,
      note: expect.stringMatching(/last request failed/),
    });
    expect(h.traces.filter((t) => t.event === "RemoteCertFailed")).toHaveLength(
      1,
    );
    // The next minute's tick waits; each hour brings one more try...
    await h.server.configure();
    expect(h.identity.certCalls).toBe(1);
    const HOUR = 60 * 60 * 1000;
    for (let n = 2; n <= CERT_RETRIES_HOURLY + 1; n++) {
      clock.at += HOUR;
      await h.server.configure();
      await settled();
      expect(h.identity.certCalls).toBe(n);
    }
    // ...until the hourly tries are spent and it becomes a daily one.
    clock.at += HOUR;
    await h.server.configure();
    await settled();
    expect(h.identity.certCalls).toBe(CERT_RETRIES_HOURLY + 1);
    clock.at += 24 * HOUR;
    await h.server.configure();
    await settled();
    expect(h.identity.certCalls).toBe(CERT_RETRIES_HOURLY + 2);
    // Still bound over HTTP throughout, never rebound.
    expect(h.tls).toEqual([undefined, undefined]);
  });
});

describe("lock", () => {
  it("ends every stream, revokes sessions, turns the setting off and answers 403 afterwards", async () => {
    const h = await up();
    const { token } = await session(h);
    const port = h.port();
    const s = stream(port, token);
    await s.ready;
    await s.next("status");
    h.server.lock();
    expect((await s.next("notice")).text).toBe("Remote locked from the Mac.");
    await s.closed();
    expect(h.persisted).toContainEqual({ remoteEnabled: false });
    expect(h.server.status()).toMatchObject({
      state: "off",
      locked: true,
      enabled: false,
    });
    // The listener is gone: nothing answers on the old port.
    await expect(call(port, "/api/session")).rejects.toThrow();
  });

  it("a session opened by one phone is useless from another allowed phone", async () => {
    const tablet = {
      id: "nTABLET",
      name: "ipad",
      control: true,
      approve: true,
      firstSeen: 1,
      lastSeen: 1,
    };
    const h = await up({
      remoteDevices: [
        {
          id: PHONE.nodeId,
          name: "iphone",
          control: true,
          approve: true,
          firstSeen: 1,
          lastSeen: 1,
        },
        tablet,
      ],
    });
    const { token } = await session(h);
    h.identity.next = { ...PHONE, nodeId: tablet.id, nodeName: "ipad" };
    expect(
      (await post(h.port(), "/api/ask", token, { kind: "status" })).status,
    ).toBe(403);
    const s = stream(h.port(), token);
    await s.ready;
    expect(s.status()).toBe(403);
    h.identity.next = PHONE;
    expect(
      (await post(h.port(), "/api/ask", token, { kind: "status" })).status,
    ).toBe(200);
  });

  it("forgetting a device revokes its session at once", async () => {
    const h = await up();
    const { token } = await session(h);
    expect(
      (await post(h.port(), "/api/ask", token, { kind: "status" })).status,
    ).toBe(200);
    h.server.revokeDevice(PHONE.nodeId);
    expect(
      (await post(h.port(), "/api/ask", token, { kind: "status" })).status,
    ).toBe(403);
  });
});
