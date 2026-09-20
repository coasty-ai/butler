import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { gzipSync } from "node:zlib";
import { defaultSettings, type Settings } from "../src/core/schema";
import { PROTECTED_SITE_REFUSAL } from "../src/core/policy";
import {
  RESERVED_PROVIDERS,
  TOOL_ID,
  TOOL_LIMITS,
  TOOL_REFUSALS,
  type ProviderResult,
  type ToolSpec,
  type ToolWords,
} from "../src/core/tools";
import { sanitizeResult } from "../src/tools/result";
import { FILES, LOCAL_SERVERS } from "../src/tools/providers";
import {
  WEB,
  WEB_ID,
  WEB_LIMITS,
  WEB_TEXT_CUT_MARKER,
  WEB_TITLE,
  WEB_TOOLS,
  WEB_TOOL_IDS,
  WEB_TOOL_NAMES,
  WEB_USER_AGENT,
  capText,
  checkArgs,
  createWebProvider,
  decodeEntities,
  htmlToText,
  normalizeAddress,
  plainText,
  privateAddress,
  protectedHost,
  shownHref,
  traceHost,
  webTarget,
  webToolSpec,
} from "../src/tools/providers/web";
import type { McpProvider } from "../src/tools/mcp";
import {
  createFixtureStore,
  isSideRequest,
  type FixtureStore,
} from "../src/gym/bench/fixtures";
import { FIXTURE_ORIGIN } from "../src/gym/bench/tools";

/**
 * The web page text tool against a local HTTP server on an ephemeral port
 * (never the network): the address rules and their fixed retries, the
 * loopback allowance the bench alone gets, redirects, the size, type, time
 * and credential floors, the HTML-to-text on synthetic markup, the maxChars
 * cut and its marker, the one header the fetch sends, and the trace that
 * carries the host and never the path. The fixture store's visit log shows
 * that a tool read of a bench page is a visit as the graders count them.
 */
const RULES = {
  protectedDomains: defaultSettings.protectedDomains,
  loopbackOrigins: [] as string[],
};
const signal = new AbortController().signal;
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Listings, page 1 &middot; benchnote0a1b</title>
<style>body { color: red }</style><script>window.secret = "sk-abcdefghijklmnop";</script></head>
<body>
<!-- a comment the model never sees -->
<nav><a href="/tok">Home</a> <a href="/tok/orders">Orders</a></nav>
<h1>Listings, page 1 &middot; benchnote0a1b</h1>
<p>Forty   listings,
  four pages.&nbsp;Prices in dollars &amp; cents &#169; 2026.</p>
<h2>Under the cap</h2>
<ul><li>item one</li><li hidden>never shown</li><li>item <b>two</b></li></ul>
<ol><li>first</li><li>second</li></ol>
<table><tr><th>Id</th><th>Price</th></tr><tr><td>LST-1</td><td>$12.00</td></tr><tr><td>LST-2</td><td>$7.50</td></tr></table>
<p>Page 1 of 4. <a href="/tok/listings/2">Next page</a> <a href="https://docs.example.org/x#top">Docs</a> <a href="mailto:a@b.co">Write</a> <a href="#top">Top</a> <a href="javascript:void(0)">Run</a> <a href="/tok/self">/tok/self</a></p>
<span aria-hidden="true">decoration</span><img src="x.png" alt="A chart of prices"><br>
<select><option>Red</option><option>Green</option></select>
<form><label>Name</label><input type="text" value="typed"><input type="submit" value="Submit"></form>
<div style="display:none">Visible in the DOM only</div>
</body></html>`;
const CHUNK = Buffer.alloc(64 * 1024, "a");
let server: Server;
let origin: string;
let port: number;
let seen: IncomingMessage[] = [];
let store: FixtureStore;
const traced: { event: string; data: Record<string, unknown> }[] = [];
const settings: Settings = { ...defaultSettings, privacy: "PRIVATE_BYOM" };
let provider: McpProvider;
const spec = (name: (typeof WEB_TOOL_NAMES)[number]): ToolSpec =>
  webToolSpec(name);
const call = (
  name: (typeof WEB_TOOL_NAMES)[number],
  args: Record<string, unknown>,
  o: { provider?: McpProvider; words?: ToolWords; signal?: AbortSignal } = {},
) =>
  (o.provider ?? provider).call(spec(name), args, {
    signal: o.signal ?? signal,
    timeoutMs: TOOL_LIMITS.callTimeoutMs,
    ...(o.words ? { words: o.words } : {}),
  });
const code = (result: ProviderResult) => /^([A-Z_]+):/.exec(result.raw)?.[1];
const body = (result: ProviderResult) =>
  result.raw.split("\n\n").slice(1).join("\n\n");
const make = (o: Partial<Parameters<typeof createWebProvider>[0]> = {}) => {
  const made = createWebProvider({
    home: "/nonexistent/home",
    settings: () => settings,
    loopbackOrigins: [origin],
    timeoutMs: 1500,
    trace: (event, data) => traced.push({ event, data }),
    ...o,
  });
  void made.start();
  return made;
};
const html = (
  res: ServerResponse,
  text: string,
  headers: Record<string, string> = {},
) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers,
  });
  res.end(text);
};
const stream = (
  res: ServerResponse,
  bytes: number,
  headers: Record<string, string>,
) => {
  res.on("error", () => {});
  res.writeHead(200, headers);
  let sent = 0;
  const push = () => {
    while (sent < bytes && res.writable) {
      sent += CHUNK.length;
      if (!res.write(CHUNK)) return void res.once("drain", push);
    }
    if (res.writable) res.end();
  };
  push();
};

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    req.on("error", () => {});
    const path = req.url ?? "/";
    if (path.startsWith("/benchnote")) {
      const out = store.respond({
        method: req.method ?? "GET",
        url: path,
        headers: req.headers,
      });
      res.writeHead(out.status, out.headers);
      return void res.end(out.body);
    }
    switch (path) {
      case "/page":
        return html(res, PAGE);
      case "/plain":
        res.writeHead(200, { "Content-Type": "text/plain" });
        return void res.end("line one\r\nline two   \r\n\r\nline four");
      case "/json":
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end('{"a":1}');
      case "/big":
        return stream(res, 2_500_000, {
          "Content-Type": "text/html",
          "Content-Length": String(2_500_000),
        });
      case "/stream-big":
        return stream(res, 2_500_000, { "Content-Type": "text/html" });
      case "/redirect":
        res.writeHead(302, { Location: "/page" });
        return void res.end();
      case "/redirect-loop":
        res.writeHead(302, { Location: "/redirect-loop" });
        return void res.end();
      case "/redirect-off":
        res.writeHead(302, { Location: "https://example.com/x" });
        return void res.end();
      case "/redirect-userinfo":
        res.writeHead(302, { Location: `http://u:p@127.0.0.1:${port}/page` });
        return void res.end();
      case "/redirect-local":
        res.writeHead(302, { Location: `http://127.0.0.1:${port + 1}/page` });
        return void res.end();
      case "/missing":
        res.writeHead(404, { "Content-Type": "text/html" });
        return void res.end("<p>gone</p>");
      case "/slow":
        return; // never answered; the client's deadline ends it
      case "/secret":
        return html(
          res,
          "<p>Your API key: sk-abcdefghijklmnopqrstuvwxyz1234 keep it safe</p>",
        );
      case "/gzip":
        res.writeHead(200, {
          "Content-Encoding": "gzip",
          "Content-Type": "text/html",
        });
        return void res.end(gzipSync(Buffer.from("<h1>Zipped</h1><p>ok</p>")));
      case "/latin1": {
        res.writeHead(200, { "Content-Type": "text/html; charset=iso-8859-1" });
        return void res.end(Buffer.from("<p>caf\xe9</p>", "latin1"));
      }
      case "/long": {
        const items = Array.from(
          { length: 2000 },
          (_, i) => `<li>listing ${i} at $${i}.00</li>`,
        ).join("");
        return html(res, `<title>Long</title><ul>${items}</ul>`);
      }
      default:
        res.writeHead(404);
        return void res.end();
    }
  });
  server.on("clientError", (_, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  store = createFixtureStore(port);
  provider = make();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await provider.close();
});

describe("the web tool as a local server", () => {
  it("is reserved, listed after the files tool, and its two tools are trusted, local, closed-world reads with their own result cap", () => {
    expect(RESERVED_PROVIDERS.has("web")).toBe(true);
    expect(LOCAL_SERVERS).toEqual([FILES, WEB]);
    expect(WEB.id).toBe(WEB_ID);
    expect(WEB.title).toBe(WEB_TITLE);
    expect(WEB.enabled(settings)).toBe(true);
    expect(
      WEB.enabled({ ...settings, tools: { ...settings.tools, web: false } }),
    ).toBe(false);
    expect(WEB_TOOL_IDS).toEqual([
      "web__read_page_text",
      "web__read_current_page",
    ]);
    for (const name of WEB_TOOL_NAMES) {
      const s = webToolSpec(name);
      expect(s.id).toMatch(TOOL_ID);
      expect(s).toMatchObject({
        provider: "web",
        title: "Web",
        tier: "read",
        trusted: true,
        local: true,
        openWorld: false,
        undoable: false,
        longRunning: false,
        transport: "builtin",
        dateKeys: [],
        trace: { tool: name, server: "web" },
        resultChars: WEB_LIMITS.resultChars,
      });
      expect(WEB_TOOLS[name].does.length).toBeLessThanOrEqual(200);
      expect(WEB_TOOLS[name].params.length).toBeLessThanOrEqual(300);
    }
    // The registry lets the model read the whole text at its cap and the facts line.
    expect(WEB_LIMITS.resultChars).toBeGreaterThan(WEB_LIMITS.maxChars + 300);
    expect(WEB_LIMITS.defaultChars).toBe(12_000);
    expect(WEB_LIMITS.maxChars).toBe(30_000);
    expect(WEB_LIMITS.responseBytes).toBe(2 * 1024 * 1024);
    expect(WEB_LIMITS.timeoutMs).toBe(10_000);
    expect(WEB_LIMITS.redirects).toBe(3);
    expect(WEB_USER_AGENT).toMatch(/^Butler\//);
    expect(WEB_TEXT_CUT_MARKER).toBe(
      "[page text cut at maxChars; the rest was not read]",
    );
    // The bench's one allowance is the fixture server's origin.
    expect(FIXTURE_ORIGIN).toBe("http://127.0.0.1:47831");
  });
});

describe("address rules", () => {
  const judge = (value: unknown, loopbackOrigins: string[] = []) =>
    webTarget(value, { ...RULES, loopbackOrigins });
  const problem = (value: unknown, loopbackOrigins: string[] = []) =>
    (judge(value, loopbackOrigins) as { problem?: string }).problem;
  const host = (value: unknown, loopbackOrigins: string[] = []) =>
    (judge(value, loopbackOrigins) as { host?: string }).host;
  it("takes http and https only, a host, no credentials, and a bare address with the scheme it implies", () => {
    expect(host("https://example.com/a?b=c")).toBe("example.com");
    expect(host("http://Example.COM/")).toBe("example.com");
    expect(problem(undefined)).toBe("BAD_URL");
    expect(problem(42)).toBe("BAD_URL");
    expect(problem("")).toBe("BAD_URL");
    expect(problem("   ")).toBe("BAD_URL");
    expect(
      problem(`https://example.com/${"a".repeat(WEB_LIMITS.urlChars)}`),
    ).toBe("BAD_URL");
    expect(problem("https://example.com/a\nb")).toBe("BAD_URL");
    expect(problem("ftp://example.com/x")).toBe("BAD_URL");
    expect(problem("file:///etc/hosts")).toBe("BAD_URL");
    expect(problem("javascript:alert(1)")).toBe("BAD_URL");
    expect(problem("data:text/html,hi")).toBe("BAD_URL");
    expect(problem("http://user:pw@example.com/")).toBe("BAD_URL");
    expect(problem("http://user@example.com/")).toBe("BAD_URL");
    // The bench writes its site without a scheme (siteOf); a public host gets https.
    expect(normalizeAddress("example.com/path?x=1")).toBe(
      "https://example.com/path?x=1",
    );
    expect(normalizeAddress("127.0.0.1:47831/benchnote0a1b/listings")).toBe(
      "http://127.0.0.1:47831/benchnote0a1b/listings",
    );
    expect(normalizeAddress("HTTP://x.example/")).toBe("HTTP://x.example/");
    expect(normalizeAddress("not an address")).toBe("not an address");
    expect(host("example.com/path")).toBe("example.com");
  });
  it("refuses a protected host, as open_url does, and never asks", () => {
    expect(problem("https://paypal.com/signin")).toBe("PROTECTED_SITE");
    expect(problem("https://www.chase.com/")).toBe("PROTECTED_SITE");
    expect(problem("https://LOGIN.GOV")).toBe("PROTECTED_SITE");
    expect(problem("https://notpaypal.com/")).toBeUndefined();
    expect(problem("https://paypal.com.evil.example/")).toBeUndefined();
    expect(
      protectedHost("a.b.mychart.com", defaultSettings.protectedDomains),
    ).toBe(true);
    expect(
      protectedHost("mychart.com.au", defaultSettings.protectedDomains),
    ).toBe(false);
    // The retries policy sends back are fixed sentences, not questions.
    expect(TOOL_REFUSALS.protected_site).toBe(
      `No input was sent. ${PROTECTED_SITE_REFUSAL}`,
    );
    expect(TOOL_REFUSALS.protected_site).not.toMatch(/\?/);
    expect(TOOL_REFUSALS.bad_url).toMatch(/^No input was sent\./);
    expect(TOOL_REFUSALS.bad_url).not.toMatch(/\?/);
    expect(TOOL_REFUSALS.no_page).toMatch(/^No input was sent\./);
  });
  it("refuses this Mac and private networks by name and by address, except an origin the registry allows", () => {
    for (const address of [
      "http://127.0.0.1/x",
      "http://127.9.9.9/",
      "http://localhost:8080/",
      "http://[::1]/",
      "http://[::]/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://224.0.0.1/",
      "http://intranet/",
      "http://printer.local/",
      "http://db.internal/",
      "http://router.lan/",
      "http://nas.home.arpa/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
    ])
      expect(problem(address), address).toBe("LOCAL_ADDRESS");
    expect(problem("http://172.32.0.1/")).toBeUndefined();
    expect(problem("http://8.8.8.8/")).toBeUndefined();
    expect(problem("https://example.com/")).toBeUndefined();
    const fixture = ["http://127.0.0.1:47831"];
    expect(host("http://127.0.0.1:47831/benchnote0a1b/listings", fixture)).toBe(
      "127.0.0.1",
    );
    expect(host("127.0.0.1:47831/benchnote0a1b/listings/2", fixture)).toBe(
      "127.0.0.1",
    );
    // The allowance is the whole origin: another port, the bare host or https is not it.
    expect(problem("http://127.0.0.1:47832/x", fixture)).toBe("LOCAL_ADDRESS");
    expect(problem("http://127.0.0.1/x", fixture)).toBe("LOCAL_ADDRESS");
    expect(problem("https://127.0.0.1:47831/x", fixture)).toBe("LOCAL_ADDRESS");
    expect(problem("http://localhost:47831/x", fixture)).toBe("LOCAL_ADDRESS");
    expect(privateAddress("example.com")).toBe(false);
    expect(privateAddress("")).toBe(true);
    expect(privateAddress("example.com.")).toBe(false);
  });
  it("traces the registrable domain or a word for a literal address, never the host whole", () => {
    expect(traceHost("www.example.com")).toBe("example.com");
    expect(traceHost("a.b.c.example.com")).toBe("example.com");
    expect(traceHost("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(traceHost("shop.example.com.au")).toBe("example.com.au");
    expect(traceHost("example.com")).toBe("example.com");
    expect(traceHost("Example.ORG.")).toBe("example.org");
    expect(traceHost("127.0.0.1")).toBe("loopback");
    expect(traceHost("[::1]")).toBe("loopback");
    expect(traceHost("10.1.2.3")).toBe("private");
    expect(traceHost("8.8.8.8")).toBe("ip");
    expect(traceHost("[2001:db8::1]")).toBe("ip");
  });
});

describe("checkArgs", () => {
  const problem = (
    name: string,
    args: Record<string, unknown>,
    words?: ToolWords,
  ) =>
    checkArgs(name, args, RULES, words) as { problem?: string; code?: string };
  it("takes the tool's own keys, an integer maxChars clamped into its range, and the page in front from the words", () => {
    expect(
      problem("read_text_file", { url: "https://example.com" }),
    ).toMatchObject({ problem: "invalid_args", code: "BAD_ARGS" });
    expect(problem("read_page_text", {})).toMatchObject({
      problem: "invalid_args",
    });
    expect(
      problem("read_page_text", { url: "https://example.com", path: "x" }),
    ).toMatchObject({ problem: "invalid_args" });
    expect(
      problem("read_page_text", {
        url: "https://example.com",
        maxChars: "12000",
      }),
    ).toMatchObject({ problem: "invalid_args" });
    expect(
      problem("read_page_text", { url: "https://example.com", maxChars: 1.5 }),
    ).toMatchObject({ problem: "invalid_args" });
    expect(
      problem("read_page_text", { url: "https://example.com", maxChars: 0 }),
    ).toMatchObject({ problem: "invalid_args" });
    const ok = (args: Record<string, unknown>, words?: ToolWords) =>
      checkArgs("read_page_text", args, RULES, words) as {
        maxChars: number;
        target: { host: string };
      };
    expect(ok({ url: "https://example.com" }).maxChars).toBe(
      WEB_LIMITS.defaultChars,
    );
    expect(ok({ url: "https://example.com", maxChars: 50 }).maxChars).toBe(
      WEB_LIMITS.minChars,
    );
    expect(ok({ url: "https://example.com", maxChars: 99_999 }).maxChars).toBe(
      WEB_LIMITS.maxChars,
    );
    expect(ok({ url: "https://example.com", maxChars: 5000 }).maxChars).toBe(
      5000,
    );
    expect(
      problem("read_page_text", { url: "https://paypal.com" }),
    ).toMatchObject({ problem: "protected_site", code: "PROTECTED_SITE" });
    expect(
      problem("read_page_text", { url: "http://10.0.0.1/" }),
    ).toMatchObject({ problem: "bad_url", code: "LOCAL_ADDRESS" });
    expect(
      problem("read_page_text", { url: "ftp://x.example/" }),
    ).toMatchObject({ problem: "bad_url", code: "BAD_URL" });
    // read_current_page reads the frame's address, never an argument.
    expect(problem("read_current_page", {})).toMatchObject({
      problem: "no_page",
      code: "NO_PAGE",
    });
    expect(
      problem("read_current_page", {}, { userWords: "read it" }),
    ).toMatchObject({ problem: "no_page" });
    expect(
      problem(
        "read_current_page",
        { url: "https://example.com" },
        { pageAddress: "https://example.com" },
      ),
    ).toMatchObject({ problem: "invalid_args" });
    expect(
      problem("read_current_page", {}, { pageAddress: "https://paypal.com/x" }),
    ).toMatchObject({ problem: "protected_site" });
    expect(
      problem("read_current_page", {}, { pageAddress: "http://127.0.0.1:9/x" }),
    ).toMatchObject({ problem: "bad_url" });
    const current = checkArgs("read_current_page", { maxChars: 300 }, RULES, {
      pageAddress: "https://example.com/a/b",
    }) as { target: { host: string }; maxChars: number };
    expect(current.target.host).toBe("example.com");
    expect(current.maxChars).toBe(300);
  });
  it("prepares a fixed retry for a refused address and the web_read question for an accepted one", () => {
    expect(
      provider.prepare(spec("read_page_text"), { url: "ftp://x.example" }),
    ).toEqual({ ok: false, problem: "bad_url" });
    expect(
      provider.prepare(spec("read_page_text"), { url: "https://paypal.com" }),
    ).toEqual({ ok: false, problem: "protected_site" });
    expect(
      provider.prepare(spec("read_page_text"), { url: "http://10.0.0.1/" }),
    ).toEqual({ ok: false, problem: "bad_url" });
    expect(provider.prepare(spec("read_current_page"), {})).toEqual({
      ok: false,
      problem: "no_page",
    });
    expect(
      provider.prepare(spec("read_page_text"), {
        url: "https://example.com/deep/path?q=1",
      }),
    ).toEqual({
      ok: true,
      question: { kind: "web_read", host: "example.com" },
      groundText: ["example.com"],
      argsBytes: JSON.stringify({ url: "https://example.com/deep/path?q=1" })
        .length,
    });
    expect(
      provider.prepare(
        spec("read_current_page"),
        {},
        { pageAddress: `${origin}/page` },
      ),
    ).toMatchObject({
      ok: true,
      question: { kind: "web_read", host: "127.0.0.1" },
    });
    // The protected list is read live from settings.
    const strict = make({
      settings: () => ({ ...settings, protectedDomains: ["example.com"] }),
    });
    expect(
      strict.prepare(spec("read_page_text"), {
        url: "https://www.example.com/",
      }),
    ).toEqual({ ok: false, problem: "protected_site" });
  });
});

describe("HTML to text", () => {
  it("keeps headings, paragraphs, list items, table rows and links with their addresses, and drops the noise", () => {
    const { title, text } = htmlToText(PAGE, new URL(`${origin}/tok/listings`));
    expect(title).toBe("Listings, page 1 · benchnote0a1b");
    const lines = text.split("\n");
    expect(lines).toContain("# Listings, page 1 · benchnote0a1b");
    expect(lines).toContain(
      "Forty listings, four pages. Prices in dollars & cents © 2026.",
    );
    expect(lines).toContain("## Under the cap");
    expect(lines).toContain("- item one");
    expect(lines).toContain("- item two");
    expect(lines).toContain("1. first");
    expect(lines).toContain("2. second");
    expect(lines).toContain("Id | Price");
    expect(lines).toContain("LST-1 | $12.00");
    expect(lines).toContain("LST-2 | $7.50");
    // A link's address follows its text when it is not the text: the next
    // page can be read by the tool. Other schemes and fragments show text only.
    expect(lines).toContain(
      "Page 1 of 4. Next page (/tok/listings/2) Docs (https://docs.example.org/x) Write Top Run /tok/self",
    );
    expect(lines).toContain("A chart of prices");
    // A form's label is a line; a submit button's value is text, a text field's value is not.
    expect(lines).toContain("Name");
    expect(lines).toContain("Submit");
    for (const gone of [
      "color: red",
      "window.secret",
      "sk-abcdefghijklmnop",
      "a comment",
      "Home",
      "Orders",
      "never shown",
      "decoration",
      "Red",
      "Green",
      "typed",
    ])
      expect(text, gone).not.toContain(gone);
    // Inline style hiding is not read (the page's words win over its CSS).
    expect(text).toContain("Visible in the DOM only");
    expect(text).not.toMatch(/ {2}/);
    expect(text).not.toMatch(/\n{3}/);
    expect(text).not.toContain("<");
  });
  it("decodes character references and resolves link addresses against the page", () => {
    expect(
      decodeEntities(
        "a &amp; b &lt; c &gt; &quot;d&quot; &#39;e&#39; &#x41;&#66; &nbsp;f &mdash; &bogus; &#xD800;",
      ),
    ).toBe("a & b < c > \"d\" 'e' AB  f — &bogus; ");
    const base = new URL("https://shop.example.com/tok/vendors?page=1");
    expect(shownHref("/tok/vendors/acme", base)).toBe("/tok/vendors/acme");
    expect(shownHref("details?x=1#frag", base)).toBe("/tok/details?x=1");
    expect(shownHref("https://other.example.org/p#f", base)).toBe(
      "https://other.example.org/p",
    );
    expect(shownHref("http://shop.example.com/tok/x", base)).toBe(
      "http://shop.example.com/tok/x",
    );
    expect(shownHref("#top", base)).toBeUndefined();
    expect(shownHref("mailto:a@b.co", base)).toBeUndefined();
    expect(shownHref("javascript:void(0)", base)).toBeUndefined();
    expect(shownHref("", base)).toBeUndefined();
    expect(shownHref(undefined, base)).toBeUndefined();
    expect(shownHref("/x", undefined)).toBeUndefined();
    expect(shownHref(`/${"a".repeat(400)}`, base)).toHaveLength(
      WEB_LIMITS.hrefChars,
    );
    // A link with no text shows its address; one whose text is the address shows it once.
    const { text } = htmlToText(
      '<p><a href="/a"></a> and <a href="/b">/b</a> and <a href="/c">see /c here</a></p>',
      base,
    );
    expect(text).toBe("/a and /b and see /c here");
  });
  it("reads plain text as lines and cuts at maxChars with the marker last", () => {
    expect(plainText("a  \r\nb\r\n\r\nc\n").text).toBe("a\nb\n\nc");
    expect(capText("short", 200)).toEqual({ text: "short", truncated: false });
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const cut = capText(long, 1000);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(1000);
    expect(cut.text.endsWith(`\n${WEB_TEXT_CUT_MARKER}`)).toBe(true);
    expect(cut.text.startsWith("line 0\nline 1")).toBe(true);
    // Exactly at the cap is whole.
    expect(capText("x".repeat(1000), 1000).truncated).toBe(false);
  });
});

describe("the fetch", () => {
  it("reads a page by GET with the one header, no cookie and no credential, and hands back its text and facts", async () => {
    traced.length = 0;
    seen = [];
    const result = await call("read_page_text", { url: `${origin}/page` });
    expect(result.code).toBe("ok");
    expect(result.items).toBe(1);
    expect(result.raw.split("\n")[0]).toBe(
      `Page: Listings, page 1 · benchnote0a1b — 127.0.0.1, ${body(result).length} characters of text.`,
    );
    expect(body(result)).toContain("## Under the cap");
    expect(body(result)).toContain("LST-2 | $7.50");
    expect(body(result)).toContain("Next page (/tok/listings/2)");
    expect(result.facts).toEqual({
      kind: "page",
      title: "Listings, page 1 · benchnote0a1b",
      host: "127.0.0.1",
      chars: body(result).length,
      truncated: false,
    });
    expect(result.verified).toBeUndefined();
    expect(result.undoToken).toBeUndefined();
    const request = seen.find((r) => r.url === "/page")!;
    expect(request.method).toBe("GET");
    expect(request.headers["user-agent"]).toBe(WEB_USER_AGENT);
    for (const header of [
      "cookie",
      "authorization",
      "accept",
      "accept-encoding",
      "accept-language",
      "referer",
      "origin",
    ])
      expect(request.headers[header], header).toBeUndefined();
    expect(Object.keys(request.headers).sort()).toEqual([
      "connection",
      "host",
      "user-agent",
    ]);
    // The trace: the tool, the outcome, the size and the host as a word; never the path.
    expect(traced).toEqual([
      {
        event: "WebPageRead",
        data: {
          tool: "read_page_text",
          server: "web",
          outcome: "ok",
          resultBytes: Buffer.byteLength(PAGE),
          host: "loopback",
        },
      },
    ]);
    expect(JSON.stringify(traced)).not.toContain("/page");
    // Through the registry's sanitiser at the tool's own cap, the text survives whole.
    const bounded = sanitizeResult(result.raw, 1, WEB_LIMITS.resultChars);
    expect(bounded.text).toContain("LST-2 | $7.50");
    expect(bounded.text).not.toContain("[+");
    // At the default cap a long body is cut; at the tool's own it is not.
    const longBody = `${result.raw}\n${"z".repeat(3000)}`;
    expect(sanitizeResult(longBody, 1).text).toHaveLength(
      TOOL_LIMITS.resultChars +
        ` [+${longBody.length - TOOL_LIMITS.resultChars} chars]`.length,
    );
    expect(
      sanitizeResult(longBody, 1, WEB_LIMITS.resultChars).text,
    ).toHaveLength(longBody.length);
  });
  it("reads a plain-text page, a compressed page and a Latin-1 page", async () => {
    const plain = await call("read_page_text", { url: `${origin}/plain` });
    expect(plain.code).toBe("ok");
    expect(body(plain)).toBe("line one\nline two\n\nline four");
    expect(plain.raw.split("\n")[0]).toBe(
      `Page: (untitled) — 127.0.0.1, ${body(plain).length} characters of text.`,
    );
    const zipped = await call("read_page_text", { url: `${origin}/gzip` });
    expect(zipped.code).toBe("ok");
    expect(body(zipped)).toBe("# Zipped\nok");
    const latin = await call("read_page_text", { url: `${origin}/latin1` });
    expect(body(latin)).toBe("café");
  });
  it("reads the page in front from the frame's address and refuses without one", async () => {
    const result = await call(
      "read_current_page",
      { maxChars: 300 },
      { words: { pageAddress: `${origin}/page` } },
    );
    expect(result.code).toBe("ok");
    expect(result.facts).toMatchObject({
      kind: "page",
      host: "127.0.0.1",
      truncated: true,
    });
    expect(body(result).length).toBeLessThanOrEqual(300);
    expect(body(result).endsWith(WEB_TEXT_CUT_MARKER)).toBe(true);
    const none = await call("read_current_page", {});
    expect(none.code).toBe("error");
    expect(code(none)).toBe("NO_PAGE");
    const protectedPage = await call(
      "read_current_page",
      {},
      { words: { pageAddress: "https://paypal.com/x" } },
    );
    expect(code(protectedPage)).toBe("PROTECTED_SITE");
    expect(protectedPage.raw).toContain(PROTECTED_SITE_REFUSAL);
  });
  it("refuses loopback without the allowance, an address that resolves inward, and lets the allowed origin through", async () => {
    const strict = make({ loopbackOrigins: [] });
    const refused = await call(
      "read_page_text",
      { url: `${origin}/page` },
      { provider: strict },
    );
    expect(refused.code).toBe("error");
    expect(code(refused)).toBe("LOCAL_ADDRESS");
    // A public-looking name that DNS answers with a loopback address (the
    // rebinding shape): the guarded lookup refuses before any connection.
    const lookup: LookupFunction = (_hostname, options, callback) =>
      callback(
        null,
        (options as { all?: boolean }).all
          ? [{ address: "127.0.0.1", family: 4 }]
          : "127.0.0.1",
        4,
      );
    const rebinding = make({ loopbackOrigins: [], lookup });
    seen = [];
    const inward = await call(
      "read_page_text",
      { url: `http://rebind.example:${port}/page` },
      { provider: rebinding },
    );
    expect(code(inward)).toBe("LOCAL_ADDRESS");
    expect(seen).toEqual([]);
    // The same name with its origin allowed reads the page (the lookup is what connected it).
    const allowed = make({
      loopbackOrigins: [`http://rebind.example:${port}`],
      lookup,
    });
    const read = await call(
      "read_page_text",
      { url: `http://rebind.example:${port}/page` },
      { provider: allowed },
    );
    expect(read.code).toBe("ok");
    expect(read.facts).toMatchObject({ host: "rebind.example" });
    expect(traced.at(-1)!.data).toMatchObject({
      outcome: "ok",
      host: "rebind.example",
    });
    await Promise.all([strict.close(), rebinding.close(), allowed.close()]);
  });
  it("follows a same-host redirect, and refuses more than three, another host, or a target the rules refuse", async () => {
    const followed = await call("read_page_text", {
      url: `${origin}/redirect`,
    });
    expect(followed.code).toBe("ok");
    expect(body(followed)).toContain("## Under the cap");
    expect(
      code(await call("read_page_text", { url: `${origin}/redirect-loop` })),
    ).toBe("TOO_MANY_REDIRECTS");
    expect(
      code(await call("read_page_text", { url: `${origin}/redirect-off` })),
    ).toBe("REDIRECT_OFF_HOST");
    expect(
      code(
        await call("read_page_text", { url: `${origin}/redirect-userinfo` }),
      ),
    ).toBe("BAD_URL");
    // Same host, another port: not the allowed origin any more.
    expect(
      code(await call("read_page_text", { url: `${origin}/redirect-local` })),
    ).toBe("LOCAL_ADDRESS");
  });
  it("refuses a body over 2 MiB by its length or as it streams, a type that is not text, a status that is not success, and a fetch that outlasts its budget", async () => {
    expect(code(await call("read_page_text", { url: `${origin}/big` }))).toBe(
      "TOO_LARGE",
    );
    expect(
      code(await call("read_page_text", { url: `${origin}/stream-big` })),
    ).toBe("TOO_LARGE");
    expect(code(await call("read_page_text", { url: `${origin}/json` }))).toBe(
      "NOT_TEXT",
    );
    const missing = await call("read_page_text", { url: `${origin}/missing` });
    expect(code(missing)).toBe("HTTP_ERROR");
    expect(missing.raw).toContain("404");
    const quick = make({ timeoutMs: 250 });
    const startedAt = Date.now();
    const slow = await call(
      "read_page_text",
      { url: `${origin}/slow` },
      { provider: quick },
    );
    expect(code(slow)).toBe("TIMEOUT");
    expect(Date.now() - startedAt).toBeLessThan(1500);
    // The run's abort signal ends a fetch as interrupted.
    const aborter = new AbortController();
    setTimeout(() => aborter.abort(), 50);
    const interrupted = await call(
      "read_page_text",
      { url: `${origin}/slow` },
      { signal: aborter.signal },
    );
    expect(interrupted).toEqual({ code: "interrupted", raw: "", items: 0 });
    // A host nothing answers for is a failed fetch with its code, not a throw.
    const gone = make({
      loopbackOrigins: [],
      lookup: (_h, _o, callback) =>
        callback(
          Object.assign(new Error("nope"), { code: "ENOTFOUND" }),
          "",
          4,
        ),
    });
    const failed = await call(
      "read_page_text",
      { url: "https://nowhere.example/" },
      { provider: gone },
    );
    expect(code(failed)).toBe("FETCH_FAILED");
    expect(failed.raw).toContain("ENOTFOUND");
    await Promise.all([quick.close(), gone.close()]);
  });
  it("cuts at maxChars with the marker last and says so in the facts line", async () => {
    const result = await call("read_page_text", {
      url: `${origin}/long`,
      maxChars: 1000,
    });
    expect(result.code).toBe("ok");
    const text = body(result);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.endsWith(WEB_TEXT_CUT_MARKER)).toBe(true);
    expect(text.startsWith("- listing 0 at $0.00\n- listing 1 at $1.00")).toBe(
      true,
    );
    expect(result.raw.split("\n")[0]).toMatch(
      /^Page: Long — 127\.0\.0\.1, \d+ characters of text, cut at 1000; call again with a larger maxChars \(up to 30000\) to read the rest\.$/,
    );
    expect(result.facts).toMatchObject({
      kind: "page",
      title: "Long",
      truncated: true,
      chars: text.length,
    });
    const whole = await call("read_page_text", {
      url: `${origin}/long`,
      maxChars: 60_000,
    });
    expect(whole.facts).toMatchObject({ truncated: true });
    expect(body(whole).length).toBeLessThanOrEqual(WEB_LIMITS.maxChars);
  });
  it("drops a page that holds a credential, with the code and no text", async () => {
    traced.length = 0;
    const result = await call("read_page_text", { url: `${origin}/secret` });
    expect(result.code).toBe("error");
    expect(code(result)).toBe("CREDENTIAL");
    expect(result.raw).not.toContain("sk-");
    expect(traced.at(-1)).toMatchObject({
      event: "WebPageRead",
      data: { outcome: "CREDENTIAL", host: "loopback" },
    });
  });
  it("answers a bad argument at call time with the code, and has nothing to undo", async () => {
    expect(
      code(await call("read_page_text", { url: "ftp://x.example/" })),
    ).toBe("BAD_URL");
    expect(
      code(await call("read_page_text", { url: "https://paypal.com/" })),
    ).toBe("PROTECTED_SITE");
    expect(code(await call("read_page_text", {}))).toBe("BAD_ARGS");
    expect(code(await provider.undo("anything", signal))).toBe("NOT_FOUND");
    const off = make();
    await off.close();
    expect(
      await off.call(
        spec("read_page_text"),
        { url: `${origin}/page` },
        { signal, timeoutMs: 1000 },
      ),
    ).toEqual({ code: "unavailable", raw: "", items: 0 });
    expect(
      off.prepare(spec("read_page_text"), { url: `${origin}/page` }),
    ).toEqual({ ok: false, problem: "unavailable" });
  });
});

describe("the bench", () => {
  it("counts a tool read of a fixture page as a visit, since visits are the server's own GET log", async () => {
    const token = "benchnote0a1b";
    store.register(token, {
      listings:
        "<title>Listings · benchnote0a1b</title><h1>Listings</h1><table><tr><td>LST-1</td><td>$9</td></tr></table>",
      "listings/2": "<h1>Page 2</h1>",
    });
    seen = [];
    const result = await call("read_page_text", {
      url: `127.0.0.1:${port}/${token}/listings`,
    });
    expect(result.code).toBe("ok");
    expect(body(result)).toContain("LST-1 | $9");
    expect(store.read(token).visits).toEqual([`/${token}/listings`]);
    // The tool sends no Accept header, which the store reads as */*: a page someone opened, not a side request.
    expect(isSideRequest(seen[0].headers)).toBe(false);
    await call("read_page_text", {
      url: `http://127.0.0.1:${port}/${token}/listings/2`,
    });
    expect(store.read(token).visits).toEqual([
      `/${token}/listings`,
      `/${token}/listings/2`,
    ]);
    // An unregistered page is the fixture's own 404, reported as such.
    expect(
      code(await call("read_page_text", { url: `${origin}/${token}/nowhere` })),
    ).toBe("HTTP_ERROR");
  });
});
