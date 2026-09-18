/**
 * The phone remote's server: listens only on this node's Tailscale
 * addresses, asks the daemon who is behind every socket, and serves one
 * page, one event stream and a handful of JSON routes to phones the user
 * allowed in Settings. The rules live in src/remote/auth.ts and the shapes
 * in src/remote/protocol.ts; this file is the plumbing between them, the
 * run (through callbacks main.ts provides) and Node's HTTP stack. It never
 * runs `tailscale serve` or `funnel`, refuses to start when either is
 * configured on its port, and keeps every trace content-free.
 */
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { Frame, Settings, Snapshot } from "../../src/core/schema";
import { scanText } from "../../src/core/sanitize";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../../src/core/diagnostics";
import type {
  ProgressReport,
  ProgressSink,
  RunView,
} from "../../src/assistant/types";
import { statusLine } from "../../src/assistant/run-view";
import { stepLine } from "../../src/assistant/steps";
import type { TurnPlanKind } from "../../src/voice/turns";
import {
  RateLimiter,
  REMOTE_LIMITS,
  access,
  approvalFailed,
  approvalVerdict,
  bindAddresses,
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
  type Access,
  type DenyCause,
  type Iface,
  type Identity,
  type LimitClass,
  type RemoteDevice,
  type SelfInfo,
} from "../../src/remote/auth";
import {
  CREDENTIAL_REFUSAL,
  approveBody,
  askBody,
  controlBody,
  encodeEvent,
  parseRoute,
  remoteReply,
  remoteView,
  sayBody,
  type RemoteEvent,
  type RemoteStatus,
  type Route,
} from "../../src/remote/protocol";
import type { Presence } from "../presence";
import type { IdentityProvider, TailscaleKind } from "./tailscale";
import { manifest, renderPage, unpairedPage } from "./page";

/** What the server needs from a listening socket; node's http.Server fits. */
export interface ListenerLike {
  listen(port: number, host: string, onListening: () => void): unknown;
  on(event: "error", fn: (error: Error) => void): unknown;
  on(event: "connection", fn: (socket: Socket) => void): unknown;
  close(onClosed?: () => void): unknown;
  closeAllConnections?(): void;
}

export interface RemoteServerOptions {
  settings: () => Settings;
  /** Persists what the server itself changes: device rows, the captured login, a lock. */
  persist: (
    patch: Partial<
      Pick<Settings, "remoteUser" | "remoteDevices" | "remoteEnabled">
    >,
  ) => void;
  identity: IdentityProvider;
  /** The sealed certificate record; absent keeps it in memory for this run. */
  certStore?: { load(): string | undefined; save(record: string): void };
  /** main.ts steerFromRemote: the plan the router chose and its fixed line. */
  converse: (
    text: string,
  ) => Promise<{ plan: TurnPlanKind; reply?: string; error?: string }>;
  control: {
    pause(): void;
    stop(): void;
    /** True only when a held run actually resumed. */
    resume(): Promise<boolean>;
    /** Answers the pending approval; false when nothing was pending any more. */
    approve(yes: boolean): Promise<boolean>;
    /** main.ts currentGate(): the identity of the pending approval. */
    gate(): string | undefined;
  };
  presence: () => Presence;
  runView: () => RunView;
  snapshot: () => Snapshot;
  /** The content-free thumbnail of a frame (main.ts uses nativeImage). */
  thumbnail?: (frame: Frame) => Buffer | undefined;
  interfaces?: () => Iface[];
  createServer?: (
    tls: { cert: string; key: string } | undefined,
    listener: RequestListener,
  ) => ListenerLike;
  /** Whether a peer address may be served at all; Tailscale ranges only. */
  peerAllowed?: (address: string) => boolean;
  now?: () => number;
  /** 32 hex characters of randomness. */
  random?: () => string;
  trace?: DiagnosticSink;
  pingMs?: number;
  /** 0 disables the re-detection watchdog (tests). */
  watchdogMs?: number;
}

export const PING_MS = 20_000;
export const WATCHDOG_MS = 60_000;
/** Identity of a long-lived stream is re-checked this often. */
const RECHECK_MS = 5 * 60_000;
const BODY_TIMEOUT_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CERT_MIN_VALIDITY = "336h";
const CERT_RENEW_BEFORE_MS = 14 * DAY_MS;
/** Failed issuances are retried hourly this many times, then daily. */
export const CERT_RETRIES_HOURLY = 3;
const SEEN_PERSIST_MS = 60_000;
const CSP = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;
const COOKIE = "oa_remote";

interface Client {
  deviceId: string;
  res: ServerResponse;
  socket: Socket;
  checkedAt: number;
}

const REASONS = {
  not_installed:
    "Tailscale isn’t installed on this Mac. Install the Standalone build from tailscale.com and sign in on this Mac and your phone.",
  no_token:
    "Tailscale is installed, but this macOS user can’t read its local API. Sign in as an administrator, or install the Tailscale command-line tool.",
  not_running: "Tailscale isn’t running or isn’t signed in on this Mac.",
  unreadable: "Tailscale isn’t running or isn’t signed in on this Mac.",
  no_self: "Tailscale isn’t running or isn’t signed in on this Mac.",
  no_address: "This Mac has no Tailscale address right now.",
} as const;

const APPROVAL_REPLIES: Record<string, string> = {
  tier: "Approve this one on the Mac.",
  not_armed:
    "Approvals from this phone are off. Turn them on in Settings on the Mac.",
  present: "Someone’s using the Mac; approve it there.",
  stale: "That question has changed. Check the current one.",
  replay: "That answer was already used.",
  locked: "Approvals from this phone are locked for an hour.",
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export class RemoteServer implements ProgressSink {
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly sessions;
  private readonly nonces;
  private readonly limiter = new RateLimiter();
  private readonly clients = new Set<Client>();
  private readonly sockets = new Set<Socket>();
  private readonly identities = new WeakMap<
    Socket,
    Promise<Identity | undefined>
  >();
  private listeners: ListenerLike[] = [];
  private boundKey = "";
  private self?: SelfInfo;
  private kind: TailscaleKind = "none";
  private https = false;
  private certExpires?: number;
  private cert?: { cert: string; key: string };
  private certAttempt?: Promise<void>;
  private certFailures = 0;
  /** No issuance before this time: failed attempts back off. */
  private certRetryAt = 0;
  private url?: string;
  private reason?: string;
  private note?: string;
  private state: RemoteStatus["state"] = "off";
  private locked = false;
  private configuring?: Promise<void>;
  private again = false;
  private watchdog?: ReturnType<typeof setInterval>;
  private pinger?: ReturnType<typeof setInterval>;
  private seq = 0;
  private gateId?: string;
  /** This gate's nonce per device, shared by that device's streams. */
  private deviceNonces = new Map<string, string>();
  private lastEventSeq = 0;
  private lastRunId = "";
  private frameCache?: { id: string; jpeg: Buffer };
  private closed = false;

  constructor(private readonly options: RemoteServerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(16).toString("hex"));
    this.sessions = createSessions({ random: this.random });
    this.nonces = createNonces({ random: this.random });
  }

  private debug: DiagnosticSink = (event, data) =>
    trace(this.options.trace, event, data);

  private get settings() {
    return this.options.settings();
  }

  /** The request handler, exposed so tests can serve it on loopback. */
  readonly listener: RequestListener = (req, res) => {
    void this.handle(req, res).catch((error) => {
      this.debug("RemoteRequestFailed", errorDetails(error));
      if (!res.headersSent) this.reply(res, 500);
      else res.end();
    });
  };

  // MARK: lifecycle

  /** Applies the settings: detects Tailscale, binds or closes, arms the watchdog. */
  configure(): Promise<void> {
    // One at a time: the watchdog, a settings save and a certificate that
    // arrived may overlap. A call during a run asks for one more run, so a
    // change the running one already decided against is not lost.
    if (this.configuring) {
      this.again = true;
      return this.configuring;
    }
    this.configuring = (async () => {
      do {
        this.again = false;
        await this.reconfigure();
      } while (this.again && !this.closed);
    })().finally(() => {
      this.configuring = undefined;
    });
    return this.configuring;
  }

  private async reconfigure(): Promise<void> {
    if (this.closed) return;
    if (!this.settings.remoteEnabled) {
      this.turnOff();
      return;
    }
    this.locked = false;
    this.startWatchdog();
    // The daemon and the serve config are asked asynchronously; a lock, a
    // quit or a settings save can land meanwhile, and a stale answer must
    // never bind a listener the newer state closed.
    const stale = () =>
      this.closed || this.locked || !this.settings.remoteEnabled;
    const detected = await this.options.identity.detect();
    if (stale()) return this.standDown();
    this.kind = detected.kind;
    this.self = detected.self;
    if (detected.kind === "none" || !detected.self || detected.reason) {
      this.off(REASONS[detected.reason ?? "not_running"]);
      return;
    }
    const self = detected.self;
    const s = this.settings;
    // Pin the allowed login the first time, so a later re-login on the Mac
    // cannot silently widen who may connect.
    if (!s.remoteUser && self.loginName)
      this.options.persist({ remoteUser: self.loginName });
    const addresses = bindAddresses(
      this.options.interfaces?.() ?? osInterfaces(),
    );
    const hosts = [addresses.v4, addresses.v6].filter((h): h is string => !!h);
    if (!hosts.length) {
      this.off(REASONS.no_address);
      return;
    }
    const serve = await this.options.identity.serveConfig();
    if (stale()) return this.standDown();
    const conflict = serveConflict(serve, self.dnsName, s.remotePort);
    if (conflict.conflict) {
      this.off(
        `Remote is off because Tailscale Serve or Funnel is configured on port ${s.remotePort}. Run “tailscale serve reset” or pick another port.`,
      );
      return;
    }
    this.note = funnelConfigured(serve)
      ? "Tailscale Funnel is on for another port on this Mac. The remote never uses it, but check that nothing else is published."
      : undefined;
    this.ensureCert(self);
    // One certificate for the whole bind: an issuance landing between the
    // v4 and v6 listeners must not split them, and the follow-up run this
    // arrival asks for rebinds both.
    const cert = this.cert;
    const key = `${hosts.join(",")}|${s.remotePort}|${cert ? sha256(cert.cert) : "http"}`;
    if (this.listeners.length && key === this.boundKey) {
      this.state = "on";
      return;
    }
    this.stopListening();
    try {
      for (const host of hosts) {
        await this.listen(host, s.remotePort, cert);
        if (stale()) return this.standDown();
      }
    } catch (error) {
      this.stopListening();
      const code =
        (error as NodeJS.ErrnoException)?.code ?? "it could not listen";
      this.state = "error";
      this.reason = `The remote could not listen on port ${s.remotePort} (${code}).`;
      this.debug("RemoteListenFailed", errorDetails(error));
      return;
    }
    this.boundKey = key;
    this.https = !!cert;
    const scheme = this.https ? "https" : "http";
    this.url = `${scheme}://${self.dnsName || addresses.v4}:${s.remotePort}`;
    this.state = "on";
    this.reason = undefined;
    if (!this.https) this.note = this.plainHttpNote(self);
    this.debug("RemoteTailscale", { kind: this.kind, state: "on" });
  }

  /** The remote is off in settings: nothing bound, nothing watched. */
  private turnOff() {
    this.stopListening();
    this.state = "off";
    this.reason = undefined;
    this.url = undefined;
    this.stopWatchdog();
  }

  /**
   * A reconfigure overtaken by a lock or a quit leaves their work alone; one
   * overtaken by the setting going off finishes the job that save asked for.
   */
  private standDown() {
    if (!this.closed && !this.locked) this.turnOff();
  }

  private plainHttpNote(self: SelfInfo): string {
    if (!self.certDomains.length)
      return "No HTTPS certificate yet: turn on MagicDNS and HTTPS Certificates in the Tailscale admin console for a padlock and Home Screen support. Until then the page is served over plain HTTP inside your tailnet, which WireGuard already encrypts.";
    return `Waiting for the HTTPS certificate from Tailscale${
      this.certFailures
        ? " (the last request failed; it is retried automatically)"
        : ""
    }. Until it arrives the page is served over plain HTTP inside your tailnet, which WireGuard already encrypts, and the address moves to https when it does.`;
  }

  private off(reason: string) {
    this.stopListening();
    this.state = "off";
    this.reason = reason;
    this.url = undefined;
    this.debug("RemoteTailscale", { kind: this.kind, state: "off" });
  }

  private listen(
    host: string,
    port: number,
    tls: { cert: string; key: string } | undefined,
  ): Promise<void> {
    const create: NonNullable<RemoteServerOptions["createServer"]> =
      this.options.createServer ??
      ((tls, listener) => {
        const server = tls
          ? createHttpsServer(
              { cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" },
              listener,
            )
          : createHttpServer(listener);
        server.requestTimeout = BODY_TIMEOUT_MS;
        server.headersTimeout = 15_000;
        server.maxHeadersCount = 64;
        return server;
      });
    const server = create(tls, this.listener);
    server.on("connection", (socket) => this.accept(socket));
    this.listeners.push(server);
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, host, () => resolve());
    });
  }

  private accept(socket: Socket) {
    if (this.sockets.size >= REMOTE_LIMITS.sockets) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }

  private stopListening() {
    for (const c of [...this.clients]) this.dropClient(c);
    for (const server of this.listeners) {
      server.closeAllConnections?.();
      server.close();
    }
    this.listeners = [];
    this.boundKey = "";
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.stopPinger();
  }

  private startWatchdog() {
    const ms = this.options.watchdogMs ?? WATCHDOG_MS;
    if (this.watchdog || !ms) return;
    this.watchdog = setInterval(() => void this.configure(), ms);
    this.watchdog.unref?.();
  }

  private stopWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /** Cuts every phone off at once and turns the remote off in settings. */
  lock() {
    this.locked = true;
    this.broadcast({ type: "notice", text: "Remote locked from the Mac." });
    this.stopListening();
    this.sessions.revoke();
    this.nonces.withdraw();
    this.limiter.reset();
    this.state = "off";
    this.url = undefined;
    this.stopWatchdog();
    this.options.persist({ remoteEnabled: false });
    this.debug("RemoteLocked");
  }

  /** A device the user forgot or switched off loses its sessions now. */
  revokeDevice(deviceId: string) {
    this.sessions.revoke(deviceId);
    this.deviceNonces.delete(deviceId);
    this.limiter.reset(deviceId);
    for (const c of [...this.clients])
      if (c.deviceId === deviceId) this.dropClient(c);
  }

  close() {
    this.closed = true;
    this.stopWatchdog();
    this.stopListening();
    this.sessions.revoke();
    this.state = "off";
  }

  status(): RemoteStatus {
    const s = this.settings;
    return {
      enabled: s.remoteEnabled,
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.note ? { note: this.note } : {}),
      ...(this.url ? { url: this.url } : {}),
      tailscale: this.kind,
      ...(this.self?.loginName || s.remoteUser
        ? { user: s.remoteUser || this.self?.loginName }
        : {}),
      https: this.https,
      ...(this.certExpires ? { certExpires: this.certExpires } : {}),
      devices: s.remoteDevices.map((d) => ({ ...d })),
      connected: [...new Set([...this.clients].map((c) => c.deviceId))],
      locked: this.locked,
    };
  }

  // MARK: certificate

  /**
   * Loads the stored certificate and, when there is none or it is due for
   * renewal, starts an issuance in the background. Never awaited by the
   * bind: a first issuance can take a minute, so the page comes up over
   * plain HTTP and rebinds with TLS when the certificate arrives. Failed
   * attempts back off (hourly, then daily) instead of retrying on every
   * watchdog tick.
   */
  private ensureCert(self: SelfInfo) {
    if (!self.certDomains.length) {
      this.cert = undefined;
      this.certExpires = undefined;
      return;
    }
    const domain = self.certDomains[0];
    if (!this.cert) this.loadStoredCert(domain);
    const remaining = (this.certExpires ?? 0) - this.now();
    if (this.cert && remaining <= 0) {
      // A dead certificate is worse than none: plain HTTP until renewed.
      this.cert = undefined;
      this.certExpires = undefined;
    }
    if (this.cert && remaining > CERT_RENEW_BEFORE_MS) return;
    if (this.certAttempt || this.now() < this.certRetryAt) return;
    this.certAttempt = this.issueCert(domain).finally(() => {
      this.certAttempt = undefined;
    });
  }

  private async issueCert(domain: string) {
    try {
      const pair = await this.options.identity.cert(domain, CERT_MIN_VALIDITY);
      if (!pair) throw new Error("No certificate was issued.");
      const expires = certExpiry(pair.certPem);
      if (!expires || expires <= this.now())
        throw new Error("The issued certificate is not valid.");
      this.cert = { cert: pair.certPem, key: pair.keyPem };
      this.certExpires = expires;
      this.certFailures = 0;
      this.certRetryAt = 0;
      this.options.certStore?.save(
        JSON.stringify({ domain, certPem: pair.certPem, keyPem: pair.keyPem }),
      );
      this.debug("RemoteCertIssued");
      // The bound key includes the certificate, so this rebinds with TLS
      // (or does nothing, if the remote went off meanwhile).
      await this.configure();
    } catch (error) {
      // Keep serving the old certificate while it lasts.
      this.debug("RemoteCertFailed", errorDetails(error));
      this.certFailures++;
      this.certRetryAt =
        this.now() +
        (this.certFailures <= CERT_RETRIES_HOURLY ? HOUR_MS : DAY_MS);
      if (this.state === "on" && !this.https && this.self)
        this.note = this.plainHttpNote(this.self);
    }
  }

  private loadStoredCert(domain: string) {
    try {
      const raw = this.options.certStore?.load();
      if (!raw) return;
      const record = JSON.parse(raw) as {
        domain?: string;
        certPem?: string;
        keyPem?: string;
      };
      if (record.domain !== domain || !record.certPem || !record.keyPem) return;
      const expires = certExpiry(record.certPem);
      if (!expires || expires <= this.now()) return;
      this.cert = { cert: record.certPem, key: record.keyPem };
      this.certExpires = expires;
    } catch (error) {
      this.debug("RemoteCertUnreadable", errorDetails(error));
    }
  }

  // MARK: run events

  onSnapshot(s: Snapshot) {
    const gate = this.options.control.gate();
    const gateId = gate ? sha256(gate).slice(0, 32) : undefined;
    if (gateId !== this.gateId) {
      if (this.gateId) this.nonces.withdraw(this.gateId);
      this.deviceNonces.clear();
      this.gateId = gateId;
    }
    if (s.frame?.id !== this.frameCache?.id) this.frameCache = undefined;
    if (!this.clients.size) {
      this.trackSteps(s);
      return;
    }
    // Steps that ran since the last snapshot, as content-free lines.
    for (const line of this.trackSteps(s))
      this.broadcast({ type: "progress", line, at: this.now() });
    this.seq++;
    for (const c of this.clients) this.sendStatus(c, s);
  }

  /** New ActionExecuted lines since the last call; resets on a new run. */
  private trackSteps(s: Snapshot): string[] {
    if (!s.run) return [];
    if (s.run.id !== this.lastRunId) {
      this.lastRunId = s.run.id;
      this.lastEventSeq = 0;
    }
    const lines: string[] = [];
    for (const e of s.events) {
      if (e.sequence_number <= this.lastEventSeq) continue;
      this.lastEventSeq = e.sequence_number;
      if (e.type !== "ActionExecuted") continue;
      const line = stepLine(e.data.action as Parameters<typeof stepLine>[0]);
      if (line) lines.push(line);
    }
    return lines;
  }

  onProgress(r: ProgressReport) {
    if (!r.send) return;
    this.broadcast({ type: "progress", line: r.text, at: r.at });
  }

  private nonceFor(deviceId: string): string | undefined {
    if (!this.gateId) return undefined;
    let nonce = this.deviceNonces.get(deviceId);
    if (!nonce) {
      nonce = this.nonces.issue(deviceId, this.gateId, this.now());
      this.deviceNonces.set(deviceId, nonce);
    }
    return nonce;
  }

  private viewFor(deviceId: string, s: Snapshot) {
    const device = this.settings.remoteDevices.find((d) => d.id === deviceId);
    return remoteView(this.options.runView(), s, {
      gate: this.gateId,
      nonce: this.nonceFor(deviceId),
      device,
      screenshots: this.settings.remoteScreenshots,
      presence: this.options.presence(),
      locked: this.locked,
      seq: this.seq,
    });
  }

  private sendStatus(c: Client, s: Snapshot) {
    this.write(c, { type: "status", view: this.viewFor(c.deviceId, s) });
  }

  private write(c: Client, e: RemoteEvent) {
    try {
      c.res.write(encodeEvent(e));
    } catch {
      this.dropClient(c);
    }
  }

  private broadcast(e: RemoteEvent) {
    for (const c of this.clients) this.write(c, e);
  }

  private dropClient(c: Client) {
    if (!this.clients.delete(c)) return;
    try {
      c.res.end();
    } catch {}
    this.debug("RemoteSse", { code: "close", device: deviceCode(c.deviceId) });
    if (!this.clients.size) this.stopPinger();
  }

  private startPinger() {
    if (this.pinger) return;
    this.pinger = setInterval(
      () => void this.ping(),
      this.options.pingMs ?? PING_MS,
    );
    this.pinger.unref?.();
  }

  private stopPinger() {
    clearInterval(this.pinger);
    this.pinger = undefined;
  }

  private async ping() {
    const now = this.now();
    for (const c of [...this.clients]) {
      if (now - c.checkedAt >= RECHECK_MS) {
        // A long-lived stream is re-identified: the daemon is asked again
        // (the cached whois is dropped first), so a device the user switched
        // off, or a peer the daemon no longer vouches for, is cut.
        c.checkedAt = now;
        this.identities.delete(c.socket);
        const a = await this.accessOf(c.socket);
        if (a.access !== "control" || a.device?.id !== c.deviceId) {
          this.dropClient(c);
          continue;
        }
      }
      this.write(c, { type: "ping", at: now });
    }
  }

  // MARK: requests

  private identityOf(socket: Socket): Promise<Identity | undefined> {
    let cached = this.identities.get(socket);
    if (!cached) {
      const address = socket.remoteAddress ?? "";
      const allowed = this.options.peerAllowed ?? isTailscaleAddress;
      cached = allowed(address)
        ? this.options.identity
            .identify({ address, port: socket.remotePort ?? 0 })
            .catch((error) => {
              this.debug("RemoteWhoisFailed", errorDetails(error));
              return undefined;
            })
        : Promise.resolve(undefined);
      this.identities.set(socket, cached);
    }
    return cached;
  }

  private async accessOf(socket: Socket): Promise<{
    access: Access;
    cause?: DenyCause;
    device?: RemoteDevice;
    identity?: Identity;
  }> {
    const id = await this.identityOf(socket);
    if (!this.self) return { access: "denied", cause: "no_identity" };
    const a = access(id, this.settings, this.self);
    if (id && a.access !== "denied") this.noteSeen(id);
    return { ...a, identity: id };
  }

  private noteSeen(id: Identity) {
    const now = this.now();
    const devices = this.settings.remoteDevices;
    const existing = devices.find((d) => d.id === id.nodeId);
    if (
      existing &&
      now - existing.lastSeen < SEEN_PERSIST_MS &&
      existing.name === id.nodeName.replace(/\s+/g, " ").trim().slice(0, 64)
    )
      return;
    this.options.persist({ remoteDevices: seen(devices, id, now) });
  }

  private reply(
    res: ServerResponse,
    status: number,
    body?: string | Buffer,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(this.https
        ? { "Strict-Transport-Security": "max-age=31536000" }
        : {}),
      ...(body === undefined
        ? {}
        : { "Content-Length": Buffer.byteLength(body) }),
      ...headers,
    });
    res.end(body);
  }

  private json(
    res: ServerResponse,
    status: number,
    value: unknown,
    headers = {},
  ) {
    this.reply(res, status, JSON.stringify(value), {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    });
  }

  /** The names this server answers to; never anything the request supplied. */
  private ownNames(): string[] {
    return this.self ? ownHosts(this.self) : [];
  }

  private ownOrigins(): string[] {
    const port = this.settings.remotePort;
    const scheme = this.https ? "https" : "http";
    return this.ownNames().map((n) => `${scheme}://${n}:${port}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const started = this.now();
    const socket = req.socket;
    const peer = socket.remoteAddress ?? "";
    const a = await this.accessOf(socket);
    const device = a.device;
    const done = (code: number, route?: Route) =>
      this.debug("RemoteRequest", {
        ...(route ? { route } : {}),
        httpStatus: code,
        durationMs: this.now() - started,
        ...(device ? { device: deviceCode(device.id) } : {}),
      });
    if (a.access === "denied" || this.locked) {
      // Unauthenticated peers are counted per address and dropped hard.
      if (!this.limiter.take(peer, "unauth", started)) {
        socket.destroy();
        return;
      }
      this.debug("RemoteDenied", { cause: this.locked ? "locked" : a.cause });
      this.reply(res, 403);
      done(403);
      return;
    }
    // A request for any name but ours never came from the page: a site
    // whose DNS was pointed at this Mac (rebinding) would otherwise be
    // same-origin with it in the phone's browser and pass every check.
    if (
      !hostAllowed(
        header(req, "host"),
        this.ownNames(),
        this.settings.remotePort,
      )
    ) {
      this.debug("RemoteDenied", { cause: "host" });
      this.reply(res, 421);
      done(421);
      return;
    }
    const parsed = parseRoute(req.method ?? "GET", req.url ?? "/");
    if (!parsed) {
      this.reply(res, 404);
      done(404);
      return;
    }
    const { route } = parsed;
    const macName = this.self?.dnsName.split(".")[0] || "this Mac";
    if (a.access === "unpaired") {
      if (route === "page") {
        const nonce = this.random();
        this.reply(
          res,
          200,
          unpairedPage({
            nonce,
            macName,
            deviceName: device?.name || a.identity?.nodeName || "this phone",
          }),
          {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": CSP(nonce),
          },
        );
        done(200, route);
        return;
      }
      this.reply(res, 403);
      done(403, route);
      return;
    }
    const deviceId = device!.id;
    if (route === "page") {
      const nonce = this.random();
      this.reply(res, 200, renderPage({ nonce, macName }), {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CSP(nonce),
      });
      done(200, route);
      return;
    }
    if (route === "manifest") {
      this.reply(res, 200, manifest(macName), {
        "Content-Type": "application/manifest+json; charset=utf-8",
      });
      done(200, route);
      return;
    }
    if (route === "session") {
      const { token } = this.sessions.issue(deviceId, started);
      this.json(
        res,
        200,
        {
          token,
          device: {
            name: device!.name,
            control: device!.control,
            approve: device!.approve,
          },
          mac: { name: macName },
          screenshots: this.settings.remoteScreenshots,
          // Phase 2: hold-to-talk uploads. Nothing is wired yet.
          mic: false,
        },
        {
          "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api${this.https ? "; Secure" : ""}`,
        },
      );
      done(200, route);
      return;
    }
    // Everything else needs the cookie session, bound to this same device.
    const cookieToken = cookieValue(req.headers.cookie, COOKIE);
    const session = this.sessions.lookup(cookieToken, started);
    if (!session || session.deviceId !== deviceId) {
      this.reply(res, 403);
      done(403, route);
      return;
    }
    if (route === "events") {
      await this.openStream(req, res, device!, socket, started);
      done(200, route);
      return;
    }
    if (route === "frame") {
      if (!this.limiter.take(deviceId, "frame", started)) {
        this.reply(res, 429);
        done(429, route);
        return;
      }
      const jpeg = this.frameFor(parsed.frameId!);
      if (!jpeg) this.reply(res, 404);
      else this.reply(res, 200, jpeg, { "Content-Type": "image/jpeg" });
      done(jpeg ? 200 : 404, route);
      return;
    }
    // POST routes: cross-site checks, then the rate class, then the body.
    const length = Number(req.headers["content-length"]);
    const check = requestAllowed(
      {
        method: req.method ?? "",
        origin: header(req, "origin"),
        secFetchSite: header(req, "sec-fetch-site"),
        contentType: header(req, "content-type"),
        tokenHeader: header(req, "x-remote-token"),
        cookieToken,
        ...(Number.isFinite(length) ? { length } : {}),
      },
      this.ownOrigins(),
    );
    if (check !== "ok") {
      this.debug("RemoteDenied", { cause: check });
      this.reply(res, check === "too_large" ? 413 : 403);
      done(check === "too_large" ? 413 : 403, route);
      return;
    }
    if (route === "audio") {
      // Phase 2 stub: no audio path exists yet, and never will approve.
      this.json(res, 501, { error: "Talking from the phone is coming later." });
      done(501, route);
      return;
    }
    const cls: LimitClass =
      route === "say" ? "say" : route === "approve" ? "approve" : "control";
    if (!this.limiter.take(deviceId, cls, started)) {
      this.reply(res, 429);
      done(429, route);
      return;
    }
    const body = await readJson(req);
    if (body === undefined) {
      this.reply(res, 400);
      done(400, route);
      return;
    }
    try {
      const result = await this.act(route, body, device!);
      this.json(res, 200, result);
      done(200, route);
    } catch {
      this.reply(res, 400);
      done(400, route);
    }
  }

  private async act(route: Route, body: unknown, device: RemoteDevice) {
    const now = this.now();
    switch (route) {
      case "say": {
        const { text } = sayBody.parse(body);
        if (scanText(text).some((f) => f.action === "BLOCK_UPLOAD")) {
          this.debug("RemoteSay", { plan: "refused", textLength: text.length });
          return { reply: CREDENTIAL_REFUSAL };
        }
        const r = await this.options.converse(text);
        this.debug("RemoteSay", { plan: r.plan, textLength: text.length });
        return {
          plan: r.plan,
          reply: r.reply ?? r.error ?? remoteReply(r.plan),
        };
      }
      case "control": {
        const { kind } = controlBody.parse(body);
        if (kind === "stop") {
          this.options.control.stop();
          return { ok: true, reply: remoteReply("stop") };
        }
        if (kind === "pause") {
          this.options.control.pause();
          return { ok: true, reply: remoteReply("pause") };
        }
        const view = this.options.runView();
        if (view.status === "waiting_for_approval")
          return { ok: false, reply: "It’s waiting for your OK, not paused." };
        const resumed = await this.options.control.resume();
        return {
          ok: resumed,
          reply: resumed ? remoteReply("resume") : "Nothing was paused.",
        };
      }
      case "approve": {
        const { gate, nonce, answer } = approveBody.parse(body);
        const snapshot = this.options.snapshot();
        const pending = snapshot.pending;
        const verdict = approvalVerdict({
          answer,
          gate,
          nonce,
          currentGate: this.gateId,
          pending,
          device,
          presence: this.options.presence(),
          nonces: this.nonces,
          failures: this.limiter.failures(device.id, now),
          now,
        });
        if (approvalFailed(verdict)) {
          this.limiter.noteFailure(device.id, now);
          if (this.limiter.lockedUntil(device.id) > now)
            for (const c of this.clients)
              if (c.deviceId === device.id)
                this.write(c, {
                  type: "notice",
                  text: APPROVAL_REPLIES.locked,
                });
        }
        this.debug("RemoteApproval", {
          verdict,
          ...(pending ? { tier: remoteApprovalTier(pending) } : {}),
          device: deviceCode(device.id),
        });
        if (verdict === "approve" || verdict === "skip") {
          const ok = await this.options.control.approve(verdict === "approve");
          return {
            verdict,
            reply: !ok
              ? APPROVAL_REPLIES.stale
              : verdict === "approve"
                ? "Approved."
                : "Skipped. The task is paused.",
          };
        }
        return { verdict, reply: APPROVAL_REPLIES[verdict] };
      }
      case "ask": {
        askBody.parse(body);
        return { reply: statusLine(this.options.runView()) };
      }
      default:
        throw new Error("No such route.");
    }
  }

  private async openStream(
    req: IncomingMessage,
    res: ServerResponse,
    device: RemoteDevice,
    socket: Socket,
    now: number,
  ) {
    const mine = [...this.clients].filter((c) => c.deviceId === device.id);
    if (
      mine.length >= REMOTE_LIMITS.ssePerDevice ||
      this.clients.size >= REMOTE_LIMITS.sseTotal
    ) {
      this.reply(res, 429);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const client: Client = { deviceId: device.id, res, socket, checkedAt: now };
    this.clients.add(client);
    this.debug("RemoteSse", { code: "open", device: deviceCode(device.id) });
    req.on("close", () => this.dropClient(client));
    this.sendStatus(client, this.options.snapshot());
    this.startPinger();
  }

  private frameFor(id: string): Buffer | undefined {
    if (this.settings.remoteScreenshots === "off") return undefined;
    const s = this.options.snapshot();
    const frame = s.frame;
    if (!frame || frame.id !== id || frame.synthetic || !s.run)
      return undefined;
    if (this.frameCache?.id === id) return this.frameCache.jpeg;
    const jpeg = this.options.thumbnail?.(frame);
    if (!jpeg) return undefined;
    this.frameCache = { id, jpeg };
    return jpeg;
  }
}

// MARK: helpers

function osInterfaces(): Iface[] {
  const out: Iface[] = [];
  for (const [name, list] of Object.entries(networkInterfaces()))
    for (const i of list ?? [])
      out.push({
        name,
        address: i.address,
        family: i.family === "IPv6" ? "IPv6" : "IPv4",
        internal: i.internal,
      });
  return out;
}

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function cookieValue(cookie: string | undefined, name: string): string {
  for (const part of (cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=").trim();
  }
  return "";
}

/** The device as traces name it: never the node id itself. */
export function deviceCode(nodeId: string): string {
  return "d" + sha256(nodeId).slice(0, 8);
}

/** When a PEM certificate stops being valid, in epoch milliseconds. */
export function certExpiry(certPem: string): number | undefined {
  try {
    const at = Date.parse(new X509Certificate(certPem).validTo);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON body of at most 4 KB, or undefined when it is not one. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      resolve(undefined);
    }, BODY_TIMEOUT_MS);
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4096) {
        clearTimeout(timer);
        req.destroy();
        resolve(undefined);
      } else chunks.push(c);
    });
    req.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}
