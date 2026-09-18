/**
 * Who is on the other end of a tailnet socket, according to the Tailscale
 * daemon on this Mac. The Standalone build publishes its LocalAPI port and a
 * same-user token under /Library/Tailscale (readable by admins); the App
 * Store and open-source builds are reached through the CLI. Every answer
 * is content-free: node ids, names, a login, flags. Never Funnel: this
 * module only reads the daemon's state and, when asked, requests the
 * certificate for this node's own name. Parsing is pure and pinned by
 * tests/remote-tailscale.test.ts; the I/O is injected.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, SelfInfo } from "../../src/remote/auth";
import {
  errorDetails,
  trace,
  type DiagnosticSink,
} from "../../src/core/diagnostics";

export type TailscaleKind = "standalone" | "appstore" | "cli" | "none";

export interface TailscaleDetect {
  kind: TailscaleKind;
  self?: SelfInfo;
  /** Why nothing usable was found, as a fixed code. */
  reason?:
    "not_installed" | "not_running" | "no_token" | "no_self" | "unreadable";
}

export interface IdentityProvider {
  detect(): Promise<TailscaleDetect>;
  /** whois for the peer behind a socket; undefined when the daemon has no answer. */
  identify(peer: {
    address: string;
    port: number;
  }): Promise<Identity | undefined>;
  /** tailscaled's Serve/Funnel config, or undefined when it cannot be read. */
  serveConfig(): Promise<unknown>;
  /** A certificate pair for this node's own name, or undefined. */
  cert(
    domain: string,
    minValidity: string,
  ): Promise<{ certPem: string; keyPem: string } | undefined>;
}

/** Where the Standalone build publishes its LocalAPI port and token. */
export const SHARED_DIR = "/Library/Tailscale";
/** Fixed CLI locations, never the PATH: Standalone, Homebrew, App Store. */
export const CLI_PATHS = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
] as const;
const CLI_TIMEOUT_MS = 5000;
const LOCALAPI_TIMEOUT_MS = 5000;
/**
 * A first issuance goes through Let's Encrypt's DNS-01 challenge and can
 * take up to a minute or so; the daemon holds the request open meanwhile,
 * so the status/whois timeout would cut every first attempt short.
 */
export const CERT_TIMEOUT_MS = 120_000;
const MAX_BODY = 4 * 1024 * 1024;

/** The I/O the provider needs; tests hand in fakes. */
export interface TailscaleIo {
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** One LocalAPI request over loopback; rejects on a network failure or after timeoutMs. */
  localApi(o: {
    port: number;
    token: string;
    path: string;
    timeoutMs: number;
  }): Promise<{ status: number; body: string }>;
  execFile(
    file: string,
    args: string[],
    o: { env?: Record<string, string>; timeoutMs: number },
  ): Promise<{ stdout: string }>;
  tempDir(): Promise<string>;
  remove(path: string): Promise<void>;
}

export function nodeTailscaleIo(): TailscaleIo {
  return {
    readlink: (path) => readlink(path),
    readFile: (path) => readFile(path, "utf8"),
    exists: (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    localApi: ({ port, token, path, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: `/localapi/v0/${path}`,
            method: "GET",
            timeout: timeoutMs,
            headers: {
              // The daemon insists on this host and refuses any browser-ish
              // request (an Origin or Referer header) outright.
              Host: "local-tailscaled.sock",
              Authorization:
                "Basic " + Buffer.from(`:${token}`).toString("base64"),
              "Sec-Tailscale": "localapi",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => {
              size += c.length;
              if (size > MAX_BODY) {
                req.destroy(new Error("LocalAPI response too large."));
                return;
              }
              chunks.push(c);
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
            res.on("error", reject);
          },
        );
        req.on("timeout", () => req.destroy(new Error("LocalAPI timed out.")));
        req.on("error", reject);
        req.end();
      }),
    execFile: (file, args, o) =>
      new Promise((resolve, reject) => {
        execFileCb(
          file,
          args,
          {
            env: o.env,
            timeout: o.timeoutMs,
            maxBuffer: MAX_BODY,
            windowsHide: true,
          },
          (error, stdout) => {
            if (error) reject(error);
            else resolve({ stdout: String(stdout) });
          },
        );
      }),
    tempDir: () => mkdtemp(join(tmpdir(), "oa-remote-cert-")),
    remove: (path) => rm(path, { recursive: true, force: true }),
  };
}

// MARK: parsing (pure)

/** The port behind the ipnport symlink: its target is the number itself. */
export function parseIpnPort(target: string): number | undefined {
  const port = Number(target.trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

const str = (v: unknown, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** SelfInfo from `status --json` (peers not needed), or undefined. */
export function parseStatus(json: unknown): SelfInfo | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const self = o.Self as Record<string, unknown> | undefined;
  if (!self || typeof self !== "object") return undefined;
  const nodeId = str(self.ID, 64);
  if (!nodeId) return undefined;
  const userId = self.UserID;
  const users = (o.User ?? {}) as Record<string, Record<string, unknown>>;
  const profile =
    userId !== undefined && users && typeof users === "object"
      ? users[String(userId)]
      : undefined;
  const ips = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.map((ip) => str(ip, 64)).filter(Boolean)
    : [];
  const certDomains = Array.isArray(o.CertDomains)
    ? o.CertDomains.map((d) => str(d, 253)).filter(Boolean)
    : [];
  return {
    nodeId,
    loginName: str(profile?.LoginName, 200),
    dnsName: str(self.DNSName, 253).replace(/\.$/, ""),
    ...(ips.find((ip) => ip.includes("."))
      ? { ipv4: ips.find((ip) => ip.includes("."))! }
      : {}),
    ...(ips.find((ip) => ip.includes(":"))
      ? { ipv6: ips.find((ip) => ip.includes(":"))! }
      : {}),
    certDomains,
    backendState: str(o.BackendState, 40),
  };
}

/**
 * An Identity from a WhoIsResponse. The CLI's `whois --json` and the
 * LocalAPI return the same shape: Node (StableID, ComputedName, Hostinfo,
 * Tags, Sharer) and UserProfile (LoginName). A tagged node has no person
 * behind it and a shared node belongs to another tailnet: both are flagged
 * here and refused by access().
 */
export function parseWhois(json: unknown): Identity | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const node = o.Node as Record<string, unknown> | undefined;
  const profile = o.UserProfile as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object") return undefined;
  const nodeId = str(node.StableID, 64);
  if (!nodeId) return undefined;
  const hostinfo = node.Hostinfo as Record<string, unknown> | undefined;
  const tags = Array.isArray(node.Tags) ? node.Tags.filter(Boolean) : [];
  const sharer = node.Sharer;
  return {
    nodeId,
    nodeName:
      str(node.ComputedName, 64) ||
      str(node.Name, 64).split(".")[0] ||
      str(hostinfo?.Hostname, 64),
    ...(str(hostinfo?.OS, 40) ? { os: str(hostinfo?.OS, 40) } : {}),
    loginName: str(profile?.LoginName, 200),
    tagged: tags.length > 0,
    shared:
      sharer !== undefined &&
      sharer !== null &&
      sharer !== 0 &&
      sharer !== "" &&
      sharer !== "0",
  };
}

/** A `type=pair` certificate body: the key PEM followed by the cert PEM. */
export function parseCertPair(
  body: string,
): { certPem: string; keyPem: string } | undefined {
  const blocks = body.match(
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  );
  if (!blocks) return undefined;
  const keyPem = blocks.find((b) => /PRIVATE KEY-----/.test(b));
  const certPem = blocks.find((b) => /BEGIN CERTIFICATE-----/.test(b));
  if (!keyPem || !certPem) return undefined;
  // Intermediates follow the leaf; keep the whole chain.
  const chain = blocks.filter((b) => /BEGIN CERTIFICATE-----/.test(b));
  return { certPem: chain.join("\n") + "\n", keyPem: keyPem + "\n" };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// MARK: the provider

export function createTailscaleProvider(o: {
  io?: TailscaleIo;
  sharedDir?: string;
  cliPaths?: readonly string[];
  trace?: DiagnosticSink;
}): IdentityProvider {
  const io = o.io ?? nodeTailscaleIo();
  const sharedDir = o.sharedDir ?? SHARED_DIR;
  const cliPaths = o.cliPaths ?? CLI_PATHS;
  const debug: DiagnosticSink = (event, data) => trace(o.trace, event, data);
  let local: { port: number; token: string } | undefined;
  let cli: string | undefined;

  /** The Standalone build's LocalAPI credentials, if this user may read them. */
  async function findLocalApi(): Promise<
    { port: number; token: string } | "no_token" | undefined
  > {
    let target: string;
    try {
      target = await io.readlink(join(sharedDir, "ipnport"));
    } catch {
      return undefined;
    }
    const port = parseIpnPort(target);
    if (!port) return undefined;
    try {
      const token = (
        await io.readFile(join(sharedDir, `sameuserproof-${port}`))
      ).trim();
      if (!/^[A-Za-z0-9]+$/.test(token)) return "no_token";
      return { port, token };
    } catch {
      // The file is root:admin 0640: a user outside the admin group cannot
      // read it and gets the CLI path instead.
      return "no_token";
    }
  }

  async function findCli(): Promise<string | undefined> {
    for (const path of cliPaths) if (await io.exists(path)) return path;
    return undefined;
  }

  const cliEnv = (path: string) =>
    path.includes(".app/") ? { TAILSCALE_BE_CLI: "1" } : undefined;

  async function runCli(
    args: string[],
    timeoutMs = CLI_TIMEOUT_MS,
  ): Promise<string | undefined> {
    if (!cli) return undefined;
    try {
      const { stdout } = await io.execFile(cli, args, {
        env: cliEnv(cli),
        timeoutMs,
      });
      return stdout;
    } catch (error) {
      debug("RemoteTailscaleCliFailed", {
        code: args[0],
        ...errorDetails(error),
      });
      return undefined;
    }
  }

  async function localGet(
    path: string,
    timeoutMs = LOCALAPI_TIMEOUT_MS,
  ): Promise<string | undefined> {
    if (!local) return undefined;
    try {
      const res = await io.localApi({ ...local, path, timeoutMs });
      if (res.status !== 200) {
        debug("RemoteTailscaleLocalApi", {
          code: path.split(/[/?]/)[0],
          httpStatus: res.status,
        });
        return undefined;
      }
      return res.body;
    } catch (error) {
      debug("RemoteTailscaleLocalApiFailed", errorDetails(error));
      return undefined;
    }
  }

  return {
    async detect() {
      local = undefined;
      cli = undefined;
      const found = await findLocalApi();
      let kind: TailscaleKind = "none";
      let reason: TailscaleDetect["reason"] = "not_installed";
      if (found && found !== "no_token") {
        local = found;
        kind = "standalone";
      } else {
        cli = await findCli();
        if (cli) kind = cli.includes(".app/") ? "appstore" : "cli";
        else if (found === "no_token") reason = "no_token";
      }
      if (kind === "none") return { kind, reason };
      const body = local
        ? await localGet("status?peers=false")
        : await runCli(["status", "--json", "--peers=false"]);
      if (body === undefined) return { kind, reason: "unreadable" };
      const self = parseStatus(parseJson(body));
      if (!self) return { kind, reason: "no_self" };
      if (self.backendState !== "Running")
        return { kind, self, reason: "not_running" };
      return { kind, self };
    },

    async identify(peer) {
      const addr = peer.address.replace(/^::ffff:/i, "").split("%")[0];
      const target = addr.includes(":")
        ? `[${addr}]:${peer.port}`
        : `${addr}:${peer.port}`;
      const body = local
        ? await localGet(`whois?addr=${encodeURIComponent(target)}`)
        : await runCli(["whois", "--json", addr]);
      if (body === undefined) return undefined;
      return parseWhois(parseJson(body));
    },

    async serveConfig() {
      const body = local
        ? await localGet("serve-config")
        : await runCli(["serve", "status", "--json"]);
      if (body === undefined) return undefined;
      const parsed = parseJson(body);
      // An empty config reads as null from both; treat it as "nothing".
      return parsed ?? {};
    },

    async cert(domain, minValidity) {
      if (!/^[a-z0-9.-]{1,253}$/i.test(domain)) return undefined;
      if (local) {
        const body = await localGet(
          `cert/${encodeURIComponent(domain)}?type=pair&min_validity=${encodeURIComponent(minValidity)}`,
          CERT_TIMEOUT_MS,
        );
        const pair = body === undefined ? undefined : parseCertPair(body);
        if (pair) return pair;
        // The same-user token may lack the cert permission: fall through to
        // the CLI, which the Standalone build installs unsandboxed.
        cli ??= await findCli();
      }
      if (!cli) return undefined;
      const dir = await io.tempDir();
      const certFile = join(dir, "cert.pem"),
        keyFile = join(dir, "key.pem");
      try {
        const out = await runCli(
          [
            "cert",
            "--cert-file",
            certFile,
            "--key-file",
            keyFile,
            `--min-validity=${minValidity}`,
            domain,
          ],
          CERT_TIMEOUT_MS,
        );
        if (out === undefined) return undefined;
        const certPem = await io.readFile(certFile);
        const keyPem = await io.readFile(keyFile);
        return parseCertPair(keyPem + "\n" + certPem);
      } catch (error) {
        debug("RemoteCertFailed", errorDetails(error));
        return undefined;
      } finally {
        await io.remove(dir).catch(() => {});
      }
    },
  };
}
