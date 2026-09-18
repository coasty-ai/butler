import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVE_FAILURES_PER_10_MIN,
  APPROVE_LOCK_MS,
  MAX_DEVICES,
  MAX_SESSIONS_PER_DEVICE,
  NEVER_BY_PHONE,
  NONCE_TTL_MS,
  RateLimiter,
  REMOTE_LIMITS,
  SESSION_TTL_MS,
  TAILSCALE_UDP_PORT,
  access,
  approvalAllowed,
  approvalFailed,
  approvalVerdict,
  bindAddresses,
  constantTimeEqual,
  createNonces,
  createSessions,
  funnelConfigured,
  hostAllowed,
  isTailscaleAddress,
  ownHosts,
  remoteApprovalTier,
  requestAllowed,
  seen,
  serveConflict,
  validateRemoteSettings,
  type Identity,
  type RemoteDevice,
  type SelfInfo,
} from "../src/remote/auth";
import {
  followUpApprovalAllowed,
  restrictedApproval,
} from "../src/voice/turns";
import { defaultSettings, settingsSchema } from "../src/core/schema";
import serveConfigs from "./fixtures/remote-serve-config.json";

const SELF: SelfInfo = {
  nodeId: "nMAC0001CNTRL",
  loginName: "nitish@example.com",
  dnsName: "mac.tail1234.ts.net",
  ipv4: "100.101.102.103",
  certDomains: ["mac.tail1234.ts.net"],
  backendState: "Running",
};
const PHONE: Identity = {
  nodeId: "nPHONE123CNTRL",
  nodeName: "iphone",
  os: "iOS",
  loginName: "nitish@example.com",
  tagged: false,
  shared: false,
};
const device = (patch: Partial<RemoteDevice> = {}): RemoteDevice => ({
  id: PHONE.nodeId,
  name: "iphone",
  control: true,
  approve: true,
  firstSeen: 1,
  lastSeen: 1,
  ...patch,
});
const settings = (devices: RemoteDevice[] = [], remoteUser = "") => ({
  remoteUser,
  remoteDevices: devices,
});
let counter = 0;
const random = () => (++counter).toString(16).padStart(32, "0");

describe("bind addresses", () => {
  const ifaces = [
    {
      name: "lo0",
      address: "127.0.0.1",
      family: "IPv4" as const,
      internal: true,
    },
    { name: "lo0", address: "::1", family: "IPv6" as const, internal: true },
    {
      name: "en0",
      address: "192.168.1.20",
      family: "IPv4" as const,
      internal: false,
    },
    {
      name: "en0",
      address: "fe80::1%en0",
      family: "IPv6" as const,
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
      address: "fd7a:115c:a1e0::1234%utun4",
      family: "IPv6" as const,
      internal: false,
    },
  ];

  it("picks only this node's Tailscale addresses", () => {
    expect(bindAddresses(ifaces)).toEqual({
      v4: "100.101.102.103",
      v6: "fd7a:115c:a1e0::1234",
    });
  });

  it("binds nothing without Tailscale, never a LAN or wildcard address", () => {
    expect(bindAddresses([])).toEqual({});
    expect(bindAddresses(ifaces.slice(0, 4))).toEqual({});
    expect(
      bindAddresses([
        { name: "any", address: "0.0.0.0", family: "IPv4", internal: false },
        { name: "any", address: "::", family: "IPv6", internal: false },
      ]),
    ).toEqual({});
  });

  it("knows the exact CGNAT and ULA ranges", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.254")).toBe(true);
    // Just outside 100.64.0.0/10.
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("100.63.255.255")).toBe(false);
    expect(isTailscaleAddress("fd7a:115c:a1e0:ab12::1")).toBe(true);
    expect(isTailscaleAddress("fd7a:115c:a1e1::1")).toBe(false);
    // IPv4-mapped form, as node reports a v4 peer on a v6 socket.
    expect(isTailscaleAddress("::ffff:100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("::ffff:192.168.0.1")).toBe(false);
    expect(
      bindAddresses([
        { name: "x", address: "100.128.0.1", family: "IPv4", internal: false },
      ]),
    ).toEqual({});
  });
});

describe("access", () => {
  it.each([
    ["no identity", undefined, settings(), "denied", "no_identity"],
    [
      "funnel",
      { ...PHONE, fromFunnel: true },
      settings([device()]),
      "denied",
      "funnel",
    ],
    [
      "this Mac's own node",
      { ...PHONE, nodeId: SELF.nodeId },
      settings([device({ id: SELF.nodeId })]),
      "denied",
      "self",
    ],
    [
      "a tagged node",
      { ...PHONE, tagged: true },
      settings([device()]),
      "denied",
      "tagged",
    ],
    [
      "a shared node",
      { ...PHONE, shared: true },
      settings([device()]),
      "denied",
      "shared",
    ],
    [
      "another login",
      { ...PHONE, loginName: "someone@example.com" },
      settings([device()]),
      "denied",
      "user",
    ],
    [
      "a login the Mac pinned",
      PHONE,
      settings([device()], "other@example.com"),
      "denied",
      "user",
    ],
    ["an unknown device", PHONE, settings(), "unpaired", "unknown_device"],
    [
      "control off",
      PHONE,
      settings([device({ control: false })]),
      "unpaired",
      "control_off",
    ],
    ["an allowed phone", PHONE, settings([device()]), "control", undefined],
  ] as const)("%s", (_name, identity, s, expected, cause) => {
    const result = access(identity, s, SELF);
    expect(result.access).toBe(expected);
    expect(result.cause).toBe(cause);
  });

  it("compares logins case-insensitively and never without one", () => {
    expect(
      access(
        { ...PHONE, loginName: "Nitish@Example.com" },
        settings([device()]),
        SELF,
      ).access,
    ).toBe("control");
    expect(
      access(PHONE, settings([device()]), { ...SELF, loginName: "" }).access,
    ).toBe("denied");
  });
});

describe("seen", () => {
  it("appends a new device with every switch off", () => {
    expect(seen([], PHONE, 100)).toEqual([
      {
        id: PHONE.nodeId,
        name: "iphone",
        control: false,
        approve: false,
        firstSeen: 100,
        lastSeen: 100,
      },
    ]);
  });

  it("refreshes lastSeen and the name, keeping the switches", () => {
    const rows = seen(
      [device({ lastSeen: 1 })],
      { ...PHONE, nodeName: "Nitish’s iPhone" },
      200,
    );
    expect(rows).toEqual([device({ name: "Nitish’s iPhone", lastSeen: 200 })]);
  });

  it("caps at twelve, dropping the least recently seen unallowed rows first", () => {
    let rows: RemoteDevice[] = [device({ id: "allowed", lastSeen: 0 })];
    for (let i = 0; i < MAX_DEVICES; i++)
      rows = seen(
        rows,
        { ...PHONE, nodeId: `n${i}`, nodeName: `n${i}` },
        i + 1,
      );
    expect(rows).toHaveLength(MAX_DEVICES);
    // The allowed row is the oldest and still there; n0 (oldest stranger) went.
    expect(rows.map((d) => d.id)).toContain("allowed");
    expect(rows.map((d) => d.id)).not.toContain("n0");
  });
});

describe("approval tiers", () => {
  const source = readFileSync(
    new URL("../src/core/policy.ts", import.meta.url),
    "utf8",
  );
  const questions = [
    ...source.matchAll(/"([A-Z][^"\n]*\?(?: [^"\n]*)?)"/g),
  ].map((m) => m[1]);
  const extra = [
    "Quit this application?",
    "Open Notes?",
    "Open Safari?",
    "Activate this control?",
    "Click “Learn more”?",
    "Click “Next page”?",
    "Click “Send”?",
    "Click “Delete”?",
    "Click “Allow”?",
    "Open Settings?",
    "Open Terminal?",
  ];

  it("routine is never wider than the follow-up window", () => {
    expect(questions.length).toBeGreaterThan(20);
    for (const reason of [...questions, ...extra]) {
      const tier = remoteApprovalTier({ reason });
      if (tier === "routine")
        expect([reason, followUpApprovalAllowed(reason)]).toEqual([
          reason,
          true,
        ]);
      if (!followUpApprovalAllowed(reason))
        expect([reason, tier]).toEqual([reason, "never"]);
    }
  });

  it.each([
    "Send this message?",
    "Delete this item?",
    "Approve this transaction?",
    "Place this order?",
    "Run or reload in this application?",
    "Open this item? It may run a program.",
    "Install this software?",
    "Sign out of this account?",
    "Change these account or security settings?",
    "Restart, shut down or force quit?",
    "Save these changes?",
    "Share or upload this item?",
    "Open a protected website?",
    "Change this setting?",
    "Change this subscription?",
    "Accept or sign this?",
    "This shortcut may send or delete content. Allow it?",
    "Type text with line breaks or tabs? Line breaks may send a message and tabs may move focus.",
    "Click “Continue”?",
    "Click “Log in”?",
    "Discard the coding agent's changes?",
    "I can’t see this window. Click at this position in Spotify?",
    // Even the follow-up window's own allow-list bends to the never list.
    "Open Settings?",
    "Open Terminal?",
  ])("%j is never approvable from a phone", (reason) => {
    expect(remoteApprovalTier({ reason })).toBe("never");
    // Everything the follow-up window refuses, the phone refuses too.
    expect(
      restrictedApproval(reason) ||
        NEVER_BY_PHONE.test(reason) ||
        !followUpApprovalAllowed(reason),
    ).toBe(true);
  });

  it.each([
    "Quit this application?",
    "Open Notes?",
    "Activate this control?",
    "Click “Learn more”?",
    "Click “Next page”?",
  ])("%j is routine", (reason) => {
    expect(remoteApprovalTier({ reason })).toBe("routine");
  });

  it("a coding agent's relayed request is never phone-approvable", () => {
    expect(
      remoteApprovalTier({
        reason: "Quit this application?",
        relay: { id: "r1" },
      }),
    ).toBe("never");
  });

  it("approvalAllowed needs both switches and a routine tier", () => {
    expect(approvalAllowed("routine", device())).toBe(true);
    expect(approvalAllowed("routine", device({ approve: false }))).toBe(false);
    expect(approvalAllowed("routine", device({ control: false }))).toBe(false);
    expect(approvalAllowed("never", device())).toBe(false);
  });
});

describe("nonces", () => {
  it("are per device, gate-bound, single use and expire", () => {
    const nonces = createNonces({ random });
    const n = nonces.issue("phone", "gateA", 1000);
    expect(nonces.verify("other", "gateA", n, 1001)).toBe("unknown");
    expect(nonces.verify("phone", "gateB", n, 1001)).toBe("stale");
    expect(nonces.verify("phone", "gateA", n, 1001)).toBe("ok");
    // Checking spends nothing: a refused tap keeps its nonce for the retry.
    expect(nonces.verify("phone", "gateA", n, 1002)).toBe("ok");
    nonces.spend(n);
    expect(nonces.verify("phone", "gateA", n, 1002)).toBe("used");
    const late = nonces.issue("phone", "gateA", 2000);
    expect(nonces.verify("phone", "gateA", late, 2000 + NONCE_TTL_MS + 1)).toBe(
      "expired",
    );
    expect(nonces.verify("phone", "gateA", "nope", 2000)).toBe("unknown");
  });

  it("are withdrawn when the gate changes", () => {
    const nonces = createNonces({ random });
    const n = nonces.issue("phone", "gateA", 1000);
    nonces.withdraw("gateA");
    expect(nonces.verify("phone", "gateA", n, 1001)).toBe("unknown");
    const m = nonces.issue("phone", "gateB", 1000);
    nonces.withdraw();
    expect(nonces.verify("phone", "gateB", m, 1001)).toBe("unknown");
  });
});

describe("approval verdicts", () => {
  const pending = {
    action: {
      type: "hotkey" as const,
      keys: ["CMD" as const, "Q" as const],
      frame_id: "f",
    },
    reason: "Quit this application?",
  };
  const setup = (over: Partial<Parameters<typeof approvalVerdict>[0]> = {}) => {
    const nonces = createNonces({ random });
    const nonce = nonces.issue(PHONE.nodeId, "gate1", 1000);
    return {
      nonces,
      input: {
        answer: "approve" as const,
        gate: "gate1",
        nonce,
        currentGate: "gate1",
        pending,
        device: device(),
        presence: "away" as const,
        nonces,
        failures: 0,
        now: 1001,
        ...over,
      },
    };
  };

  it("approves a routine question from an armed phone while nobody is at the Mac", () => {
    expect(approvalVerdict(setup().input)).toBe("approve");
  });

  it("refuses while someone is present, and takes the same answer once they leave", () => {
    const { input } = setup({ presence: "present" });
    expect(approvalVerdict(input)).toBe("present");
    expect(approvalVerdict(input)).toBe("present");
    expect(approvalVerdict({ ...input, presence: "away" })).toBe("approve");
    expect(approvalVerdict({ ...input, presence: "away" })).toBe("replay");
    expect(approvalVerdict(setup({ presence: "unknown" }).input)).toBe(
      "approve",
    );
  });

  it("refuses restricted questions whatever the phone is allowed, and a skip still goes through", () => {
    const { input } = setup({
      pending: { ...pending, reason: "Send this message?" },
    });
    expect(approvalVerdict(input)).toBe("tier");
    // The refusal spent nothing: the same nonce skips, once.
    expect(approvalVerdict({ ...input, answer: "skip" })).toBe("skip");
    expect(approvalVerdict({ ...input, answer: "skip" })).toBe("replay");
    const relay = setup({ pending: { ...pending, relay: { id: "r" } } });
    expect(approvalVerdict(relay.input)).toBe("tier");
  });

  it("refuses a phone without the approve switch, but lets it skip with the same nonce", () => {
    const { input } = setup({ device: device({ approve: false }) });
    expect(approvalVerdict(input)).toBe("not_armed");
    expect(approvalVerdict({ ...input, answer: "skip" })).toBe("skip");
    // The switch ticked meanwhile does not revive a spent nonce.
    expect(approvalVerdict({ ...input, device: device() })).toBe("replay");
    // A skip still needs its own valid nonce.
    expect(
      approvalVerdict(setup({ answer: "skip", nonce: "0".repeat(32) }).input),
    ).toBe("replay");
  });

  it("a changed or vanished gate is stale, a reused nonce a replay; only replays count", () => {
    expect(approvalVerdict(setup({ currentGate: "gate2" }).input)).toBe(
      "stale",
    );
    expect(approvalVerdict(setup({ currentGate: undefined }).input)).toBe(
      "stale",
    );
    expect(approvalVerdict(setup({ pending: undefined }).input)).toBe("stale");
    const { input } = setup();
    expect(approvalVerdict(input)).toBe("approve");
    expect(approvalVerdict(input)).toBe("replay");
    // A nonce this device was never given is a replay too; a nonce for
    // another gate presented with the current one is merely stale.
    expect(approvalVerdict({ ...input, nonce: "f".repeat(32) })).toBe("replay");
    const cross = setup();
    const theirs = cross.nonces.issue("someone-else", "gate1", 1000);
    expect(approvalVerdict({ ...cross.input, nonce: theirs })).toBe("replay");
    // A stale gate is the ordinary race with the Mac and never locks the
    // phone out; only a replayed, forged or cross-device nonce does.
    expect(approvalFailed("replay")).toBe(true);
    expect(approvalFailed("stale")).toBe(false);
    expect(approvalFailed("tier")).toBe(false);
    expect(approvalFailed("not_armed")).toBe(false);
    expect(approvalFailed("present")).toBe(false);
    expect(approvalFailed("locked")).toBe(false);
  });

  it("locks after three failures, before anything else is learned", () => {
    expect(
      approvalVerdict(setup({ failures: APPROVE_FAILURES_PER_10_MIN }).input),
    ).toBe("locked");
    expect(
      approvalVerdict(
        setup({ failures: APPROVE_FAILURES_PER_10_MIN - 1 }).input,
      ),
    ).toBe("approve");
  });
});

describe("sessions", () => {
  it("expire after twelve hours and revoke per device", () => {
    const sessions = createSessions({ random });
    const a = sessions.issue("phone", 0).token;
    const b = sessions.issue("tablet", 0).token;
    expect(sessions.lookup(a, SESSION_TTL_MS - 1)).toEqual({
      deviceId: "phone",
    });
    expect(sessions.lookup(a, SESSION_TTL_MS + 1)).toBeUndefined();
    expect(sessions.lookup("", 0)).toBeUndefined();
    sessions.revoke("phone");
    expect(sessions.lookup(b, 1)).toEqual({ deviceId: "tablet" });
    sessions.revoke();
    expect(sessions.lookup(b, 1)).toBeUndefined();
  });

  it("keeps at most four tokens per device, dropping the oldest", () => {
    const sessions = createSessions({ random });
    const tokens = Array.from(
      { length: MAX_SESSIONS_PER_DEVICE + 1 },
      (_, i) => sessions.issue("phone", i).token,
    );
    expect(sessions.lookup(tokens[0], 10)).toBeUndefined();
    for (const token of tokens.slice(1))
      expect(sessions.lookup(token, 10)).toEqual({ deviceId: "phone" });
    // Another device's tokens are not counted against it.
    expect(sessions.lookup(sessions.issue("tablet", 11).token, 12)).toEqual({
      deviceId: "tablet",
    });
    expect(sessions.lookup(tokens[1], 13)).toEqual({ deviceId: "phone" });
  });

  it("compares tokens in constant time by value", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("request checks", () => {
  const own = [
    "https://mac.tail1234.ts.net:41680",
    "https://100.101.102.103:41680",
  ];
  const good = {
    method: "POST",
    origin: "https://mac.tail1234.ts.net:41680",
    secFetchSite: "same-origin",
    contentType: "application/json",
    tokenHeader: "t".repeat(32),
    cookieToken: "t".repeat(32),
    length: 40,
  };

  it("accepts a same-origin JSON post with matching cookie and header", () => {
    expect(requestAllowed(good, own)).toBe("ok");
    expect(
      requestAllowed({ ...good, origin: "https://100.101.102.103:41680" }, own),
    ).toBe("ok");
    expect(requestAllowed({ ...good, secFetchSite: undefined }, own)).toBe(
      "ok",
    );
    expect(
      requestAllowed(
        { ...good, contentType: "application/json; charset=utf-8" },
        own,
      ),
    ).toBe("ok");
  });

  it.each([
    ["a foreign origin", { origin: "https://evil.example" }, "origin"],
    ["no origin", { origin: undefined }, "origin"],
    ["a cross-site fetch", { secFetchSite: "cross-site" }, "site"],
    [
      "a form post",
      { contentType: "application/x-www-form-urlencoded" },
      "content_type",
    ],
    ["a missing header token", { tokenHeader: undefined }, "token"],
    ["a mismatched header token", { tokenHeader: "u".repeat(32) }, "token"],
    ["no cookie", { cookieToken: undefined }, "token"],
    ["a body over 4 KB", { length: 4097 }, "too_large"],
  ] as const)("rejects %s", (_name, patch, expected) => {
    expect(requestAllowed({ ...good, ...patch }, own)).toBe(expected);
  });

  it("does not gate GETs, which change nothing", () => {
    expect(requestAllowed({ method: "GET" }, own)).toBe("ok");
  });

  it("knows its own names and accepts a Host only among them", () => {
    const hosts = ownHosts({ ...SELF, ipv6: "fd7a:115c:a1e0::1234" });
    expect(hosts).toEqual([
      "mac.tail1234.ts.net",
      "100.101.102.103",
      "[fd7a:115c:a1e0::1234]",
    ]);
    expect(ownHosts({ dnsName: "", ipv4: "100.64.0.9" })).toEqual([
      "100.64.0.9",
    ]);
    for (const host of [
      "mac.tail1234.ts.net:41680",
      "MAC.tail1234.ts.net:41680",
      "mac.tail1234.ts.net",
      "100.101.102.103:41680",
      "[fd7a:115c:a1e0::1234]:41680",
      "[fd7a:115c:a1e0::1234]",
    ])
      expect(hostAllowed(host, hosts, 41680)).toBe(true);
    // A rebinding page carries its own name; a wrong port, no Host, or a
    // name with ours as a prefix or suffix is not ours either.
    for (const host of [
      "evil.example:41680",
      "evil.example",
      "mac.tail1234.ts.net:41681",
      "mac.tail1234.ts.net.evil.example:41680",
      "evilmac.tail1234.ts.net:41680",
      "100.101.102.1030:41680",
      "",
      undefined,
    ])
      expect(hostAllowed(host, hosts, 41680)).toBe(false);
  });
});

describe("rate limiter", () => {
  it("counts per class and key inside sliding windows", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < REMOTE_LIMITS.sayPerMin; i++)
      expect(limiter.take("phone", "say", i)).toBe(true);
    expect(limiter.take("phone", "say", 100)).toBe(false);
    // Another key and another class are unaffected.
    expect(limiter.take("tablet", "say", 100)).toBe(true);
    expect(limiter.take("phone", "control", 100)).toBe(true);
    // A minute later the window has slid.
    expect(limiter.take("phone", "say", 60_001)).toBe(true);
  });

  it("caps unauthenticated hits per address", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < REMOTE_LIMITS.unauthPerMinPerIp; i++)
      expect(limiter.take("100.64.0.9", "unauth", i)).toBe(true);
    expect(limiter.take("100.64.0.9", "unauth", 11)).toBe(false);
  });

  it("locks a device for an hour after three failed approvals", () => {
    const limiter = new RateLimiter();
    limiter.noteFailure("phone", 0);
    limiter.noteFailure("phone", 1);
    expect(limiter.failures("phone", 2)).toBe(2);
    limiter.noteFailure("phone", 2);
    expect(limiter.failures("phone", 3)).toBe(APPROVE_FAILURES_PER_10_MIN);
    expect(limiter.lockedUntil("phone")).toBe(2 + APPROVE_LOCK_MS);
    // The lock outlives the ten-minute failure window.
    expect(limiter.failures("phone", 20 * 60_000)).toBe(
      APPROVE_FAILURES_PER_10_MIN,
    );
    expect(limiter.failures("phone", 2 + APPROVE_LOCK_MS + 1)).toBe(0);
    limiter.noteFailure("phone", APPROVE_LOCK_MS + 10);
    limiter.reset("phone");
    expect(limiter.failures("phone", APPROVE_LOCK_MS + 11)).toBe(0);
  });
});

describe("serve and funnel conflicts", () => {
  const dns = "mac.tail1234.ts.net";
  const cases = serveConfigs as Record<string, unknown>;

  it.each([
    ["empty", { conflict: false }],
    ["null", { conflict: false }],
    ["tcp", { conflict: true, cause: "tcp" }],
    ["web", { conflict: true, cause: "web" }],
    ["funnel", { conflict: true, cause: "funnel" }],
    ["foregroundFunnel", { conflict: true, cause: "funnel" }],
    ["foregroundTcp", { conflict: true, cause: "tcp" }],
    ["otherPort", { conflict: false }],
  ])("%s", (name, expected) => {
    expect(serveConflict(cases[name], dns, 41680)).toEqual(expected);
  });

  it("notices Funnel anywhere in the config", () => {
    expect(funnelConfigured(cases.empty)).toBe(false);
    expect(funnelConfigured(cases.otherPort)).toBe(true);
    expect(funnelConfigured(cases.foregroundFunnel)).toBe(true);
    expect(funnelConfigured(cases.tcp)).toBe(false);
  });
});

describe("remote settings", () => {
  it("parses a legacy config with the remote off and no phones", () => {
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    for (const key of [
      "remoteEnabled",
      "remotePort",
      "remoteUser",
      "remoteScreenshots",
      "remoteDevices",
    ])
      delete legacy[key];
    expect(settingsSchema.parse(legacy)).toMatchObject({
      remoteEnabled: false,
      remotePort: 41680,
      remoteUser: "",
      remoteScreenshots: "off",
      remoteDevices: [],
    });
  });

  it("only knows off and thumbnail screenshots, and at most twelve phones", () => {
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        remoteScreenshots: "full",
      }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        remoteScreenshots: "thumbnail",
      }).success,
    ).toBe(true);
    const many = Array.from({ length: MAX_DEVICES + 1 }, (_, i) =>
      device({ id: `n${i}` }),
    );
    expect(
      settingsSchema.safeParse({ ...defaultSettings, remoteDevices: many })
        .success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ ...defaultSettings, remotePort: 80 }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        remoteDevices: [{ ...device(), extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it("refuses Tailscale's own port and approve without control", () => {
    expect(() =>
      validateRemoteSettings({
        ...defaultSettings,
        remotePort: TAILSCALE_UDP_PORT,
      }),
    ).toThrow(/41641/);
    expect(() =>
      validateRemoteSettings({
        ...defaultSettings,
        remoteDevices: [device({ control: false, approve: true })],
      }),
    ).toThrow(/control/);
    expect(() =>
      validateRemoteSettings({ ...defaultSettings, remoteDevices: [device()] }),
    ).not.toThrow();
  });
});

describe("module boundaries", () => {
  it("keeps src/remote free of Node builtins and Electron", () => {
    const dir = fileURLToPath(new URL("../src/remote/", import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      expect(
        specifiers.filter((s) => s.startsWith("node:") || s === "electron"),
      ).toEqual([]);
    }
  });
});
