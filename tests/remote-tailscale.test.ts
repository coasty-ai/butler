import { describe, expect, it, vi } from "vitest";
import {
  CERT_TIMEOUT_MS,
  CLI_PATHS,
  createTailscaleProvider,
  parseCertPair,
  parseIpnPort,
  parseStatus,
  parseWhois,
  type TailscaleIo,
} from "../electron/remote/tailscale";
import whois from "./fixtures/remote-whois.json";

const STATUS = {
  BackendState: "Running",
  Self: {
    ID: "nMAC0001CNTRL",
    UserID: 654321,
    HostName: "mac",
    DNSName: "mac.tail1234.ts.net.",
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1234"],
  },
  User: { "654321": { ID: 654321, LoginName: "nitish@example.com" } },
  CertDomains: ["mac.tail1234.ts.net"],
};
const KEY = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";
const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const CHAIN = "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----";

/** Fake I/O: a Standalone install with the LocalAPI files, or a CLI. */
function fakeIo(
  over: Partial<TailscaleIo> & { standalone?: boolean; cli?: boolean } = {},
) {
  const calls: {
    localApi: string[];
    exec: string[][];
    /** The timeout handed to each call, in order: LocalAPI then CLI. */
    timeouts: { call: string; ms: number }[];
  } = { localApi: [], exec: [], timeouts: [] };
  const io: TailscaleIo = {
    readlink: async (path) => {
      if (over.standalone && path.endsWith("/ipnport")) return "41112";
      throw new Error("ENOENT");
    },
    readFile: async (path) => {
      if (over.standalone && path.endsWith("sameuserproof-41112"))
        return "abc123def456\n";
      throw new Error("EACCES");
    },
    exists: async (path) => !!over.cli && path === CLI_PATHS[0],
    localApi: async ({ path, token, port, timeoutMs }) => {
      calls.localApi.push(path);
      calls.timeouts.push({ call: path.split(/[/?]/)[0], ms: timeoutMs });
      expect(token).toBe("abc123def456");
      expect(port).toBe(41112);
      if (path === "status?peers=false")
        return { status: 200, body: JSON.stringify(STATUS) };
      if (path.startsWith("whois?addr="))
        return { status: 200, body: JSON.stringify(whois) };
      if (path === "serve-config") return { status: 200, body: "null" };
      if (path.startsWith("cert/"))
        return { status: 200, body: KEY + "\n" + CERT + "\n" + CHAIN + "\n" };
      return { status: 404, body: "" };
    },
    execFile: async (_file, args, o) => {
      calls.exec.push(args);
      calls.timeouts.push({ call: args[0], ms: o.timeoutMs });
      if (args[0] === "status") return { stdout: JSON.stringify(STATUS) };
      if (args[0] === "whois") return { stdout: JSON.stringify(whois) };
      if (args[0] === "serve") return { stdout: "{}" };
      return { stdout: "" };
    },
    tempDir: async () => "/tmp/fake",
    remove: async () => {},
    ...over,
  };
  return { io, calls };
}

describe("parsing", () => {
  it("reads the port off the ipnport symlink target", () => {
    expect(parseIpnPort("41112")).toBe(41112);
    expect(parseIpnPort(" 41112\n")).toBe(41112);
    expect(parseIpnPort("port")).toBeUndefined();
    expect(parseIpnPort("0")).toBeUndefined();
  });

  it("takes self, login, addresses and cert domains from status", () => {
    expect(parseStatus(STATUS)).toEqual({
      nodeId: "nMAC0001CNTRL",
      loginName: "nitish@example.com",
      dnsName: "mac.tail1234.ts.net",
      ipv4: "100.101.102.103",
      ipv6: "fd7a:115c:a1e0::1234",
      certDomains: ["mac.tail1234.ts.net"],
      backendState: "Running",
    });
    expect(parseStatus({})).toBeUndefined();
    expect(parseStatus({ Self: {} })).toBeUndefined();
    expect(
      parseStatus({ ...STATUS, User: undefined, CertDomains: null })?.loginName,
    ).toBe("");
  });

  it("turns a whois answer into a content-free identity", () => {
    expect(parseWhois(whois)).toEqual({
      nodeId: "nPHONE123CNTRL",
      nodeName: "iphone",
      os: "iOS",
      loginName: "nitish@example.com",
      tagged: false,
      shared: false,
    });
    const tagged = { ...whois, Node: { ...whois.Node, Tags: ["tag:server"] } };
    expect(parseWhois(tagged)?.tagged).toBe(true);
    const shared = { ...whois, Node: { ...whois.Node, Sharer: 99 } };
    expect(parseWhois(shared)?.shared).toBe(true);
    expect(parseWhois({ Node: {} })).toBeUndefined();
    expect(parseWhois("nope")).toBeUndefined();
  });

  it("splits a pair body into key and chain", () => {
    expect(parseCertPair(KEY + "\n" + CERT + "\n" + CHAIN)).toEqual({
      certPem: CERT + "\n" + CHAIN + "\n",
      keyPem: KEY + "\n",
    });
    expect(parseCertPair(CERT)).toBeUndefined();
    expect(parseCertPair("")).toBeUndefined();
  });
});

describe("the provider", () => {
  it("prefers the Standalone LocalAPI and identifies peers through whois", async () => {
    const { io, calls } = fakeIo({ standalone: true, cli: true });
    const provider = createTailscaleProvider({ io });
    const detected = await provider.detect();
    expect(detected.kind).toBe("standalone");
    expect(detected.self?.dnsName).toBe("mac.tail1234.ts.net");
    expect(
      await provider.identify({ address: "100.64.0.5", port: 54321 }),
    ).toMatchObject({
      nodeId: "nPHONE123CNTRL",
      loginName: "nitish@example.com",
    });
    expect(calls.localApi).toContain("whois?addr=100.64.0.5%3A54321");
    // An IPv4-mapped v6 peer is asked about as v4; a v6 peer is bracketed.
    await provider.identify({ address: "::ffff:100.64.0.5", port: 1 });
    await provider.identify({ address: "fd7a:115c:a1e0::5", port: 2 });
    expect(calls.localApi.slice(-2)).toEqual([
      "whois?addr=100.64.0.5%3A1",
      "whois?addr=%5Bfd7a%3A115c%3Aa1e0%3A%3A5%5D%3A2",
    ]);
    expect(await provider.serveConfig()).toEqual({});
    expect(await provider.cert("mac.tail1234.ts.net", "336h")).toEqual({
      certPem: CERT + "\n" + CHAIN + "\n",
      keyPem: KEY + "\n",
    });
    expect(calls.exec).toEqual([]);
  });

  it("falls back to the CLI when the token is unreadable, and to none without either", async () => {
    const cli = fakeIo({
      standalone: true,
      cli: true,
      readFile: async () => {
        throw new Error("EACCES");
      },
    });
    const provider = createTailscaleProvider({ io: cli.io });
    expect((await provider.detect()).kind).toBe("cli");
    await provider.identify({ address: "100.64.0.5", port: 1 });
    expect(cli.calls.exec).toEqual([
      ["status", "--json", "--peers=false"],
      ["whois", "--json", "100.64.0.5"],
    ]);
    const none = fakeIo({
      standalone: true,
      readFile: async () => {
        throw new Error("EACCES");
      },
    });
    expect(await createTailscaleProvider({ io: none.io }).detect()).toEqual({
      kind: "none",
      reason: "no_token",
    });
    expect(await createTailscaleProvider({ io: fakeIo().io }).detect()).toEqual(
      { kind: "none", reason: "not_installed" },
    );
  });

  it("reports a stopped daemon and a failed status read as not usable", async () => {
    const stopped = fakeIo({
      standalone: true,
      localApi: async () => ({
        status: 200,
        body: JSON.stringify({ ...STATUS, BackendState: "Stopped" }),
      }),
    });
    expect(
      (await createTailscaleProvider({ io: stopped.io }).detect()).reason,
    ).toBe("not_running");
    const down = fakeIo({
      standalone: true,
      localApi: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(
      (await createTailscaleProvider({ io: down.io }).detect()).reason,
    ).toBe("unreadable");
    const forbidden = fakeIo({
      standalone: true,
      localApi: async () => ({ status: 403, body: "" }),
    });
    const provider = createTailscaleProvider({ io: forbidden.io });
    await provider.detect();
    expect(
      await provider.identify({ address: "100.64.0.5", port: 1 }),
    ).toBeUndefined();
  });

  it("gives a certificate request minutes, and everything else seconds", async () => {
    // A first issuance goes through DNS-01 and can take a minute; the
    // status/whois timeout would cut every first attempt short.
    expect(CERT_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
    const standalone = fakeIo({ standalone: true });
    const viaApi = createTailscaleProvider({ io: standalone.io });
    await viaApi.detect();
    await viaApi.identify({ address: "100.64.0.5", port: 1 });
    await viaApi.cert("mac.tail1234.ts.net", "336h");
    expect(standalone.calls.timeouts).toEqual([
      { call: "status", ms: 5000 },
      { call: "whois", ms: 5000 },
      { call: "cert", ms: CERT_TIMEOUT_MS },
    ]);
    const cli = fakeIo({ cli: true });
    const viaCli = createTailscaleProvider({ io: cli.io });
    await viaCli.detect();
    await viaCli.cert("mac.tail1234.ts.net", "336h");
    expect(cli.calls.timeouts).toEqual([
      { call: "status", ms: 5000 },
      { call: "cert", ms: CERT_TIMEOUT_MS },
    ]);
  });

  it("waits out a slow issuance instead of giving up at the status timeout", async () => {
    vi.useFakeTimers();
    try {
      const { io } = fakeIo({
        standalone: true,
        cli: true,
        localApi: ({ path, timeoutMs }) =>
          new Promise((resolve, reject) => {
            if (!path.startsWith("cert/"))
              return resolve({ status: 200, body: JSON.stringify(STATUS) });
            // The daemon answers after six seconds; a client that gives up
            // at five never sees it.
            const done = setTimeout(
              () => resolve({ status: 200, body: KEY + "\n" + CERT + "\n" }),
              6000,
            );
            setTimeout(() => {
              clearTimeout(done);
              reject(new Error("LocalAPI timed out."));
            }, timeoutMs);
          }),
        // The CLI fallback is not what should carry the day here.
        execFile: async () => ({ stdout: "" }),
      });
      const provider = createTailscaleProvider({ io });
      await provider.detect();
      const pending = provider.cert("mac.tail1234.ts.net", "336h");
      await vi.advanceTimersByTimeAsync(6000);
      expect(await pending).toEqual({
        certPem: CERT + "\n",
        keyPem: KEY + "\n",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never runs funnel or serve commands beyond reading the status", async () => {
    const { io, calls } = fakeIo({ cli: true });
    const provider = createTailscaleProvider({ io });
    await provider.detect();
    await provider.serveConfig();
    await provider.cert("mac.tail1234.ts.net", "336h");
    for (const args of calls.exec) {
      expect(args[0]).not.toBe("funnel");
      if (args[0] === "serve")
        expect(args.slice(1)).toEqual(["status", "--json"]);
    }
    expect(calls.exec.some((a) => a[0] === "cert")).toBe(true);
  });
});
