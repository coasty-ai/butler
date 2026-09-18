/**
 * The rules of the phone remote, with nothing that touches a socket: which
 * addresses the server may bind, who a connection is once Tailscale has
 * named it, what each phone may do, which approvals a phone may ever answer,
 * and the tokens, nonces and limits that keep a page on a phone honest. Pure
 * on purpose (no Node builtin, no Electron): electron/remote/server.ts runs
 * them, tests/remote-auth.test.ts pins them, and `now` and `random` are
 * always injected. See docs/REMOTE.md.
 */
import type { Action, RemoteDevice } from "../core/schema";
import { followUpApprovalAllowed, restrictedApproval } from "../voice/turns";

export type { RemoteDevice };

// MARK: addresses

/** Tailscale's IPv4 range, 100.64.0.0/10 (CGNAT space). */
export const TS_IPV4 =
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
/** Tailscale's IPv6 range, fd7a:115c:a1e0::/48. */
export const TS_IPV6_PREFIX = "fd7a:115c:a1e0:";

export interface Iface {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

/** Whether an address is inside Tailscale's ranges (a zone suffix is ignored). */
export function isTailscaleAddress(address: string): boolean {
  const bare = address.replace(/^::ffff:/i, "").split("%")[0];
  return TS_IPV4.test(bare) || bare.toLowerCase().startsWith(TS_IPV6_PREFIX);
}

/**
 * The only addresses the server may listen on: this node's own Tailscale
 * addresses. Never 0.0.0.0, ::, loopback or a LAN address, whatever the
 * interface list says; a machine without Tailscale gets nothing to bind.
 */
export function bindAddresses(ifaces: Iface[]): { v4?: string; v6?: string } {
  const out: { v4?: string; v6?: string } = {};
  for (const i of ifaces) {
    if (i.internal || !isTailscaleAddress(i.address)) continue;
    if (i.family === "IPv4" && !out.v4 && TS_IPV4.test(i.address))
      out.v4 = i.address;
    if (
      i.family === "IPv6" &&
      !out.v6 &&
      i.address.toLowerCase().startsWith(TS_IPV6_PREFIX)
    )
      out.v6 = i.address.split("%")[0];
  }
  return out;
}

// MARK: settings

/** Tailscale's own WireGuard port; a listener there would fight the daemon. */
export const TAILSCALE_UDP_PORT = 41641;

/**
 * Rejects a settings save the remote could not honour: Tailscale's own port,
 * or a phone allowed to approve without being allowed to control at all.
 * main.ts calls this in saveSettings, beside validateMessageSettings.
 */
export function validateRemoteSettings(s: {
  remoteEnabled: boolean;
  remotePort: number;
  remoteDevices: RemoteDevice[];
}): void {
  if (s.remotePort === TAILSCALE_UDP_PORT)
    throw new Error(
      `Port ${TAILSCALE_UDP_PORT} belongs to Tailscale itself. Pick another port for the phone remote.`,
    );
  if (s.remoteDevices.some((d) => d.approve && !d.control))
    throw new Error(
      "A phone can only approve steps when it is also allowed to control tasks.",
    );
}

// MARK: identity and access

/** What the daemon says about the peer behind a socket; content-free. */
export interface Identity {
  /** Node.StableID: stable across reconnects, the device's key in settings. */
  nodeId: string;
  /** Node.ComputedName, bounded. */
  nodeName: string;
  os?: string;
  /** UserProfile.LoginName: the Tailscale account behind the node. */
  loginName: string;
  /** Node.Tags non-empty: a server, not a person. */
  tagged: boolean;
  /** Node.Sharer set: shared into this tailnet from another one. */
  shared: boolean;
  /** The request came through Funnel (never expected; refused outright). */
  fromFunnel?: boolean;
}

export interface SelfInfo {
  nodeId: string;
  loginName: string;
  dnsName: string;
  ipv4?: string;
  ipv6?: string;
  certDomains: string[];
  backendState: string;
}

export const MAX_DEVICES = 12;
const MAX_NAME = 64;

export type Access = "denied" | "unpaired" | "control";
export type DenyCause =
  | "no_identity"
  | "self"
  | "tagged"
  | "shared"
  | "funnel"
  | "user"
  | "unknown_device"
  | "control_off";

/**
 * What a connection may do. Refused before any route: no identity, this
 * Mac's own node (a browser on the Mac is not the phone), tagged or shared
 * nodes (no person of ours behind them), Funnel, a different login.
 * "unpaired" is the right person on a phone the Mac has not allowed yet.
 */
export function access(
  id: Identity | undefined,
  s: { remoteUser: string; remoteDevices: RemoteDevice[] },
  self: SelfInfo,
): { access: Access; cause?: DenyCause; device?: RemoteDevice } {
  if (!id) return { access: "denied", cause: "no_identity" };
  if (id.fromFunnel) return { access: "denied", cause: "funnel" };
  if (id.nodeId === self.nodeId) return { access: "denied", cause: "self" };
  if (id.tagged) return { access: "denied", cause: "tagged" };
  if (id.shared) return { access: "denied", cause: "shared" };
  const user = (s.remoteUser || self.loginName).trim().toLowerCase();
  if (!user || id.loginName.trim().toLowerCase() !== user)
    return { access: "denied", cause: "user" };
  const device = s.remoteDevices.find((d) => d.id === id.nodeId);
  if (!device) return { access: "unpaired", cause: "unknown_device" };
  if (!device.control)
    return { access: "unpaired", cause: "control_off", device };
  return { access: "control", device };
}

/**
 * The device list after this identity connected: a new row with every
 * switch off, or the existing row's name and lastSeen refreshed. Bounded to
 * MAX_DEVICES by dropping the least recently seen unallowed rows first, so a
 * flood of new nodes can never push out a phone the user enabled.
 */
export function seen(
  devices: RemoteDevice[],
  id: Identity,
  now: number,
): RemoteDevice[] {
  const name = id.nodeName.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  const existing = devices.find((d) => d.id === id.nodeId);
  const next = existing
    ? devices.map((d) =>
        d.id === id.nodeId ? { ...d, name: name || d.name, lastSeen: now } : d,
      )
    : [
        ...devices,
        {
          id: id.nodeId,
          name: name || "Unnamed device",
          control: false,
          approve: false,
          firstSeen: now,
          lastSeen: now,
        },
      ];
  if (next.length <= MAX_DEVICES) return next;
  const rank = (d: RemoteDevice) => (d.control || d.approve ? 1 : 0);
  const keep = [...next].sort(
    (a, b) => rank(b) - rank(a) || b.lastSeen - a.lastSeen,
  );
  const kept = new Set(keep.slice(0, MAX_DEVICES).map((d) => d.id));
  return next.filter((d) => kept.has(d.id));
}

// MARK: approval tiers

export type RemoteTier = "routine" | "never";

/**
 * Words that keep a policy question on the Mac whatever a phone is allowed:
 * the follow-up window's restricted list (money, deletion, credentials,
 * accounts, installs, running programs, sending, signing, saving) plus the
 * questions a phone can never judge because the screen is not in front of
 * it. Anything the follow-up window may not approve, a phone may not either.
 */
export const NEVER_BY_PHONE =
  /\b(?:pay|money|charge|refund|deposit|withdraw\w*|wire|crypto|wallet|card|bank|shut down|restart|force quit|log ?out|sign (?:in|out|up)|password|passcode|credential\w*|2fa|otp|verification code|permission\w*|privacy|security|install\w*|uninstall\w*|update\w*|upgrade\w*|delet\w*|eras\w*|wipe|format|run\w*|execut\w*|script\w*|program\w*|terminal|shell|command|protected|setting\w*|preference\w*|subscri\w*|purchase\w*|checkout|order\w*|sign|accept|agree|authori[sz]\w*|consent)\b/i;

/**
 * Which tier a pending approval falls in for a phone, in order: a coding
 * agent's relayed request, a blind surface ("I can't see"), a settings
 * change or anything in the never list is Mac-only; only questions the
 * follow-up window may already answer (opening, quitting, benign
 * navigation) are routine. There is no third tier: sends, saves and their
 * kin stay on the Mac by decision.
 */
export function remoteApprovalTier(pending: {
  action?: Action;
  reason: string;
  relay?: unknown;
}): RemoteTier {
  const reason = pending.reason.trim();
  if (pending.relay) return "never";
  if (/I can[’']t see/i.test(reason)) return "never";
  if (/^Change this setting\?/i.test(reason)) return "never";
  if (restrictedApproval(reason) || NEVER_BY_PHONE.test(reason)) return "never";
  return followUpApprovalAllowed(reason) ? "routine" : "never";
}

/** Whether this device may answer "approve" for a question of this tier. */
export function approvalAllowed(tier: RemoteTier, d: RemoteDevice): boolean {
  return tier === "routine" && d.control && d.approve;
}

// MARK: nonces

export const NONCE_TTL_MS = 10 * 60 * 1000;

/**
 * One nonce per device per pending approval. An approve must present the
 * gate it saw and the nonce it was given for that gate; a nonce is single
 * use, dies with the gate, and never works from another device. Checking
 * and spending are separate steps: a tap the rules refuse for another
 * reason (the tier, the switches, someone at the Mac) leaves the nonce
 * good for the retry the phone is entitled to.
 */
export interface Nonces {
  issue(deviceId: string, gate: string, now: number): string;
  /** Whether the nonce would be accepted; changes nothing. */
  verify(
    deviceId: string,
    gate: string,
    nonce: string,
    now: number,
  ): "ok" | "unknown" | "used" | "stale" | "expired";
  /** Marks a nonce used, so the next verify says so. */
  spend(nonce: string): void;
  /** Forgets every nonce, or those for one gate. */
  withdraw(gate?: string): void;
}

export function createNonces(o: {
  random: () => string;
  ttlMs?: number;
}): Nonces {
  const ttl = o.ttlMs ?? NONCE_TTL_MS;
  const live = new Map<
    string,
    { deviceId: string; gate: string; at: number; used: boolean }
  >();
  return {
    issue(deviceId, gate, now) {
      // A device holds one nonce per gate: re-issuing replaces it.
      for (const [key, n] of live)
        if (n.deviceId === deviceId && n.gate === gate) live.delete(key);
      const nonce = o.random();
      live.set(nonce, { deviceId, gate, at: now, used: false });
      return nonce;
    },
    verify(deviceId, gate, nonce, now) {
      const n = live.get(nonce);
      if (!n || n.deviceId !== deviceId) return "unknown";
      if (n.used) return "used";
      if (now - n.at > ttl) {
        live.delete(nonce);
        return "expired";
      }
      if (n.gate !== gate) return "stale";
      return "ok";
    },
    spend(nonce) {
      const n = live.get(nonce);
      if (n) n.used = true;
    },
    withdraw(gate) {
      if (gate === undefined) live.clear();
      else for (const [key, n] of live) if (n.gate === gate) live.delete(key);
    },
  };
}

// MARK: approval verdicts

export type ApprovalVerdict =
  | "approve"
  | "skip"
  | "tier"
  | "not_armed"
  | "present"
  | "stale"
  | "replay"
  | "locked";

export const APPROVE_FAILURES_PER_10_MIN = 3;
export const APPROVE_LOCK_MS = 60 * 60 * 1000;

/**
 * Whether a phone's answer may reach the runner. Every refusal but "skip"
 * being fine is deliberate: a skip only pauses, so control alone allows it.
 * Order matters: a locked device learns nothing else; a replayed, forged
 * or cross-device nonce counts as a failure toward the lock (the caller
 * records it); a device without approve, or a Mac-only question, or
 * someone at the Mac, keeps the approval where it is. The nonce is spent
 * only by an answer that goes through, so a refused tap can be retried once
 * the reason has passed (the person left, the switch was ticked).
 */
export function approvalVerdict(i: {
  answer: "approve" | "skip";
  gate: string;
  nonce: string;
  /** The identity of the approval pending right now, if any. */
  currentGate?: string;
  pending?: { action?: Action; reason: string; relay?: unknown };
  device: RemoteDevice;
  presence: "present" | "away" | "unknown";
  nonces: Nonces;
  /** Failed approve verdicts for this device in the last ten minutes. */
  failures: number;
  now: number;
}): ApprovalVerdict {
  if (i.failures >= APPROVE_FAILURES_PER_10_MIN) return "locked";
  if (!i.currentGate || !i.pending || i.currentGate !== i.gate) return "stale";
  const nonce = i.nonces.verify(i.device.id, i.gate, i.nonce, i.now);
  if (nonce !== "ok") return nonce === "stale" ? "stale" : "replay";
  const verdict = ((): ApprovalVerdict => {
    if (i.answer === "skip") return "skip";
    const tier = remoteApprovalTier(i.pending);
    if (tier === "never") return "tier";
    if (!approvalAllowed(tier, i.device)) return "not_armed";
    if (i.presence === "present") return "present";
    return "approve";
  })();
  if (verdict === "approve" || verdict === "skip") i.nonces.spend(i.nonce);
  return verdict;
}

/**
 * Verdicts that count toward the failure lock: only a nonce this device was
 * never given, or already used. A stale gate is the ordinary outcome of the
 * Mac answering first and must never lock the phone out.
 */
export function approvalFailed(v: ApprovalVerdict): boolean {
  return v === "replay";
}

// MARK: sessions

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Reloads and tabs on one phone; the oldest token goes when exceeded. */
export const MAX_SESSIONS_PER_DEVICE = 4;

/** Bearer tokens for the page, in memory only; a lock or a forget revokes. */
export interface Sessions {
  issue(deviceId: string, now: number): { token: string };
  lookup(token: string, now: number): { deviceId: string } | undefined;
  revoke(deviceId?: string): void;
}

export function createSessions(o: {
  random: () => string;
  ttlMs?: number;
}): Sessions {
  const ttl = o.ttlMs ?? SESSION_TTL_MS;
  const live = new Map<string, { deviceId: string; at: number }>();
  return {
    issue(deviceId, now) {
      // A phone that keeps reloading cannot grow the table: the oldest of
      // its tokens goes once it holds the maximum.
      const mine = [...live].filter(([, s]) => s.deviceId === deviceId);
      while (mine.length >= MAX_SESSIONS_PER_DEVICE)
        live.delete(mine.shift()![0]);
      const token = o.random();
      live.set(token, { deviceId, at: now });
      return { token };
    },
    lookup(token, now) {
      if (!token) return undefined;
      const s = live.get(token);
      if (!s) return undefined;
      if (now - s.at > ttl) {
        live.delete(token);
        return undefined;
      }
      return { deviceId: s.deviceId };
    },
    revoke(deviceId) {
      if (deviceId === undefined) live.clear();
      else
        for (const [token, s] of live)
          if (s.deviceId === deviceId) live.delete(token);
    },
  };
}

/** Same length and same characters, without an early exit on the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// MARK: request checks

export const MAX_BODY_BYTES = 4096;

/**
 * The names this server answers to, and nothing a request could add: the
 * MagicDNS name and this node's own addresses (IPv6 bracketed, as a Host or
 * Origin carries it). Reflecting the request's own Host here would let a
 * page whose DNS was pointed at this Mac pass the Origin check.
 */
export function ownHosts(
  self: Pick<SelfInfo, "dnsName" | "ipv4" | "ipv6">,
): string[] {
  return [self.dnsName, self.ipv4, self.ipv6 ? `[${self.ipv6}]` : undefined]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
}

/**
 * Whether a request's Host header names this server: one of its own names,
 * with our port or none at all. Anything else is a request the page never
 * makes, whoever sent it.
 */
export function hostAllowed(
  host: string | undefined,
  hosts: string[],
  port: number,
): boolean {
  const h = (host ?? "").trim().toLowerCase();
  if (!h) return false;
  return hosts.some((n) => h === n || h === `${n}:${port}`);
}

/**
 * Cross-site defences for a state-changing request. The page's own script
 * sends a same-origin JSON POST with the session cookie and the same token
 * in a custom header; a page elsewhere on the phone (or on the Mac) has no
 * cookie under SameSite=Strict, cannot set the header without a preflight
 * that no CORS answer allows, and a plain form post carries the wrong
 * content type. Origin is checked against every name this server answers
 * to, since the phone may have opened the DNS name or an address.
 */
export function requestAllowed(
  r: {
    method: string;
    origin?: string;
    secFetchSite?: string;
    contentType?: string;
    tokenHeader?: string;
    cookieToken?: string;
    length?: number;
  },
  ownOrigins: string[],
): "ok" | "origin" | "site" | "content_type" | "token" | "too_large" {
  if (r.method !== "POST") return "ok";
  if (r.length !== undefined && r.length > MAX_BODY_BYTES) return "too_large";
  const origin = (r.origin ?? "").trim().toLowerCase().replace(/\/$/, "");
  if (!origin || !ownOrigins.some((o) => o.toLowerCase() === origin))
    return "origin";
  if (r.secFetchSite && r.secFetchSite.toLowerCase() !== "same-origin")
    return "site";
  if (!/^application\/json(?:\s*;.*)?$/i.test((r.contentType ?? "").trim()))
    return "content_type";
  if (
    !r.tokenHeader ||
    !r.cookieToken ||
    !constantTimeEqual(r.tokenHeader, r.cookieToken)
  )
    return "token";
  return "ok";
}

// MARK: rate limits

export const REMOTE_LIMITS = {
  sayPerMin: 10,
  sayPerHour: 60,
  controlPerMin: 20,
  approvePerMin: 6,
  framePerMin: 30,
  unauthPerMinPerIp: 10,
  ssePerDevice: 2,
  sseTotal: 6,
  sockets: 16,
} as const;

export type LimitClass = "say" | "control" | "approve" | "frame" | "unauth";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WINDOWS: Record<LimitClass, { max: number; ms: number }[]> = {
  say: [
    { max: REMOTE_LIMITS.sayPerMin, ms: MINUTE },
    { max: REMOTE_LIMITS.sayPerHour, ms: HOUR },
  ],
  control: [{ max: REMOTE_LIMITS.controlPerMin, ms: MINUTE }],
  approve: [{ max: REMOTE_LIMITS.approvePerMin, ms: MINUTE }],
  frame: [{ max: REMOTE_LIMITS.framePerMin, ms: MINUTE }],
  unauth: [{ max: REMOTE_LIMITS.unauthPerMinPerIp, ms: MINUTE }],
};
const FAILURE_WINDOW_MS = 10 * MINUTE;

/** Sliding windows per (key, class); approval failures and locks per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private failed = new Map<string, number[]>();
  private locks = new Map<string, number>();

  /** Records a hit and says whether it was within every window. */
  take(key: string, cls: LimitClass, now: number): boolean {
    const id = `${cls}:${key}`;
    const longest = Math.max(...WINDOWS[cls].map((w) => w.ms));
    const times = (this.hits.get(id) ?? []).filter((t) => now - t < longest);
    const allowed = WINDOWS[cls].every(
      (w) => times.filter((t) => now - t < w.ms).length < w.max,
    );
    if (allowed) times.push(now);
    this.hits.set(id, times);
    return allowed;
  }

  noteFailure(key: string, now: number): void {
    const times = (this.failed.get(key) ?? []).filter(
      (t) => now - t < FAILURE_WINDOW_MS,
    );
    times.push(now);
    this.failed.set(key, times);
    if (times.length >= APPROVE_FAILURES_PER_10_MIN)
      this.locks.set(key, now + APPROVE_LOCK_MS);
  }

  failures(key: string, now: number): number {
    // A lock outlives the ten-minute window it was earned in.
    if ((this.locks.get(key) ?? 0) > now) return APPROVE_FAILURES_PER_10_MIN;
    return (this.failed.get(key) ?? []).filter(
      (t) => now - t < FAILURE_WINDOW_MS,
    ).length;
  }

  lockedUntil(key: string): number {
    return this.locks.get(key) ?? 0;
  }

  /** Forgets one key (a forgotten device) or everything (a lock). */
  reset(key?: string): void {
    if (key === undefined) {
      this.hits.clear();
      this.failed.clear();
      this.locks.clear();
      return;
    }
    for (const id of [...this.hits.keys()])
      if (id.endsWith(`:${key}`)) this.hits.delete(id);
    this.failed.delete(key);
    this.locks.delete(key);
  }
}

// MARK: serve and funnel

/**
 * Whether tailscaled's own Serve or Funnel configuration would take or
 * expose our port: a TCP forward on it, a Web handler for our name on it,
 * or Funnel allowed for our name on it, in the background config or any
 * foreground one. The server refuses to start rather than share a port
 * with something that might be reachable from the internet.
 */
export function serveConflict(
  config: unknown,
  dnsName: string,
  port: number,
): { conflict: false } | { conflict: true; cause: "tcp" | "web" | "funnel" } {
  const hostPort = `${dnsName.replace(/\.$/, "")}:${port}`;
  const check = (
    c: unknown,
  ):
    | { conflict: false }
    | { conflict: true; cause: "tcp" | "web" | "funnel" } => {
    if (!c || typeof c !== "object") return { conflict: false };
    const o = c as Record<string, unknown>;
    const keysOf = (v: unknown) =>
      v && typeof v === "object" ? Object.keys(v as object) : [];
    const matches = (k: string) =>
      k === hostPort || k === String(port) || k.endsWith(`:${port}`);
    if (o.AllowFunnel && typeof o.AllowFunnel === "object") {
      for (const [k, v] of Object.entries(o.AllowFunnel as object))
        if (v === true && matches(k))
          return { conflict: true, cause: "funnel" };
    }
    if (keysOf(o.TCP).some((k) => k === String(port)))
      return { conflict: true, cause: "tcp" };
    if (keysOf(o.Web).some(matches)) return { conflict: true, cause: "web" };
    if (o.Foreground && typeof o.Foreground === "object")
      for (const inner of Object.values(o.Foreground as object)) {
        const r = check(inner);
        if (r.conflict) return r;
      }
    return { conflict: false };
  };
  return check(config);
}

/** Anything in tailscaled's config that lets the public internet in. */
export function funnelConfigured(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const o = config as Record<string, unknown>;
  const any = (v: unknown) =>
    !!v &&
    typeof v === "object" &&
    Object.values(v as object).some((x) => x === true);
  if (any(o.AllowFunnel)) return true;
  if (o.Foreground && typeof o.Foreground === "object")
    return Object.values(o.Foreground as object).some(funnelConfigured);
  return false;
}
