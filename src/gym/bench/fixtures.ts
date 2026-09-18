import { createHash } from "node:crypto";
import { FIXTURE_HOST, FIXTURE_PORT, TOKEN_RE } from "./graders";
import type { FixtureEvidence, FixtureHandle } from "./types";

/**
 * The long suite's web pages. Every page is generated here, pure, from the
 * attempt's token and numbers drawn for that attempt, and served by
 * scripts/bench-fixtures.mjs on the loopback interface only. The pages carry
 * no external resource and no link off the token's own tree, so a run that
 * follows a link can only reach another benchmark page; the server adds a
 * Content-Security-Policy so a browser refuses anything else.
 *
 * Titles are "<Page> · <token>" so a window-title check works in any
 * browser. Numbers on a page are drawn per attempt: a remembered answer
 * cannot pass.
 */

// Defined beside the port in graders.ts, which the approval rule reads too.
export { FIXTURE_HOST };

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Every page's one stylesheet, inline. Table borders and padding matter: the
 * model reads these tables from screenshots, and cells run together without
 * them ("ORD-4471Dana Whitfield$4,980").
 */
export const PAGE_STYLE = `
body { font: 16px/1.5 -apple-system, Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 48rem; padding: 0 1rem; color: #111; background: #fff; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #bbb; padding: 0.4rem 0.8rem; text-align: left; }
nav a { margin-right: 1rem; }
label { display: block; margin: 0.8rem 0 0.2rem; }
input, textarea { font: inherit; width: 100%; max-width: 30rem; padding: 0.3rem; }
button { font: inherit; margin-top: 1rem; padding: 0.4rem 1rem; }
`;
/**
 * The CSP source that allows that stylesheet and no other inline style:
 * `default-src 'self'` alone would make the browser refuse it.
 */
export const PAGE_STYLE_SOURCE = `'sha256-${createHash("sha256").update(PAGE_STYLE).digest("base64")}'`;

/** One document: a title, a heading and the body. Inline style only. */
export function page(name: string, token: string, body: string): string {
  const title = `${escape(name)} · ${escape(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>
`;
}

const link = (token: string, path: string, label: string) =>
  `<a href="/${token}/${path}">${escape(label)}</a>`;

const nav = (token: string) =>
  `<nav>${[
    ["", "Home"],
    ["orders", "Orders"],
    ["prices", "Prices"],
    ["about", "About"],
    ["plans", "Plans"],
    ["team", "Team"],
    ["contact", "Contact"],
  ]
    .map(([path, label]) => link(token, path, label))
    .join(" ")}</nav>`;

/* ------------------------------------------------------------- drawing */

/** A whole number in [low, high]. */
export const between = (random: () => number, low: number, high: number) =>
  low + Math.floor(random() * (high - low + 1));

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Names that never collide with a real contact: two words from fixed pools. */
export const CUSTOMER_POOL = [
  "Dana Whitfield",
  "Priya Raman",
  "Marcus Oyelaran",
  "Ines Kowalczyk",
  "Tomas Lindqvist",
  "Noor Haddad",
  "Elena Vasquez",
  "Kenji Watanabe",
];
export const ITEM_POOL = [
  "Brass hinge",
  "Copper elbow",
  "Nylon washer",
  "Steel bracket",
  "Rubber gasket",
  "Oak dowel",
  "Ceramic fuse",
  "Zinc anode",
];
export const TEAM_POOL = [
  "Aurelio Bianchi",
  "Sanne de Vries",
  "Farah Nasser",
  "Oskar Nowak",
  "Mei Tanaka",
  "Rhys Llewellyn",
  "Yara Costa",
  "Ivo Petrov",
];

export interface OrderRow {
  id: string;
  customer: string;
  /** Whole dollars, so Calculator shows the same digits the page does. */
  total: number;
}

/** Five orders with distinct ids, customers and totals. */
export function drawOrders(random: () => number): OrderRow[] {
  const customers = shuffle(CUSTOMER_POOL, random).slice(0, 5);
  const totals = new Set<number>();
  while (totals.size < 5) totals.add(between(random, 120, 4980));
  const ids = new Set<string>();
  while (ids.size < 5) ids.add(`ORD-${between(random, 1000, 9999)}`);
  return [...ids].map((id, i) => ({
    id,
    customer: customers[i],
    total: [...totals][i],
  }));
}

export interface PriceRow {
  id: string;
  name: string;
  unit: number;
}

/** Six items with distinct unit prices; the highest is the answer. */
export function drawPrices(random: () => number): PriceRow[] {
  const names = shuffle(ITEM_POOL, random).slice(0, 6);
  const units = new Set<number>();
  while (units.size < 6) units.add(between(random, 3, 97));
  return names.map((name, i) => ({
    id: `ITM-${100 + i * 7 + between(random, 0, 6)}`,
    name,
    unit: [...units][i],
  }));
}

export interface SheetNumbers {
  unit: number;
  quantity: number;
  product: number;
}
/** One line item whose product is a number Calculator would not show by chance. */
export function drawSheet(random: () => number): SheetNumbers {
  const unit = between(random, 11, 97);
  const quantity = between(random, 12, 48);
  return { unit, quantity, product: unit * quantity };
}

export interface AboutFacts {
  year: number;
  employees: number;
  offices: number;
}
/** Three numbers that cannot be confused: a year, a head count, a small count. */
export function drawAbout(random: () => number): AboutFacts {
  return {
    year: between(random, 1987, 2016),
    employees: between(random, 120, 980),
    offices: between(random, 3, 9),
  };
}

export interface Plan {
  name: string;
  price: number;
  per: "month" | "year";
}
export const PLAN_NAMES = ["Starter", "Team", "Studio"] as const;
/**
 * Three plans, one billed yearly, with distinct per-month costs at least a
 * dollar apart, so "cheapest per month" has one answer and needs a division.
 */
export function drawPlans(random: () => number): {
  plans: Plan[];
  cheapest: string;
} {
  for (;;) {
    const yearly = between(random, 0, 2);
    const plans: Plan[] = PLAN_NAMES.map((name, i) =>
      i === yearly
        ? { name, price: between(random, 60, 360), per: "year" }
        : { name, price: between(random, 5, 30), per: "month" },
    );
    const monthly = plans.map((plan) =>
      plan.per === "year" ? plan.price / 12 : plan.price,
    );
    const sorted = [...monthly].sort((a, b) => a - b);
    if (sorted[1] - sorted[0] < 1 || sorted[2] - sorted[1] < 1) continue;
    return { plans, cheapest: plans[monthly.indexOf(sorted[0])].name };
  }
}

export interface Person {
  name: string;
  role: string;
}
/** Four people, two of them engineers. */
export function drawTeam(random: () => number): {
  people: Person[];
  engineers: string[];
} {
  const names = shuffle(TEAM_POOL, random).slice(0, 4);
  const roles = shuffle(
    ["Engineer", "Engineer", "Designer", "Marketing"],
    random,
  );
  const people = names.map((name, i) => ({ name, role: roles[i] }));
  return {
    people,
    engineers: people.filter((p) => p.role === "Engineer").map((p) => p.name),
  };
}

/* --------------------------------------------------------------- pages */

const money = (dollars: number) => "$" + dollars.toLocaleString("en-US");

export const pages = {
  home: (token: string) =>
    page(
      "Home",
      token,
      `${nav(token)}<p>A small site the benchmark serves on this Mac. Nothing here leaves the machine.</p>`,
    ),
  // "Order" never appears as a word of its own on these pages: the policy
  // reads it on a clicked label as "Place this order?", which the harness
  // declines. "Orders" (the page) does not match.
  orders: (token: string, rows: OrderRow[], name = "Orders") =>
    page(
      name,
      token,
      `${nav(token)}<table><tr><th>ID</th><th>Customer</th><th>Total</th></tr>${rows
        .map(
          (row) =>
            `<tr><td>${link(token, `orders/${row.id}`, row.id)}</td><td>${escape(row.customer)}</td><td>${money(row.total)}</td></tr>`,
        )
        .join("")}</table>`,
    ),
  order: (token: string, row: OrderRow) =>
    page(
      row.id,
      token,
      `${nav(token)}<p>Customer: ${escape(row.customer)}</p><p>Total: ${money(row.total)}</p><p>${link(token, "orders", "Back to orders")}</p>`,
    ),
  prices: (token: string, rows: PriceRow[]) =>
    page(
      "Prices",
      token,
      `${nav(token)}<table><tr><th>Item</th><th>Unit price</th></tr>${rows
        .map(
          (row) =>
            `<tr><td>${link(token, `items/${row.id}`, row.name)}</td><td>${money(row.unit)}</td></tr>`,
        )
        .join("")}</table>`,
    ),
  item: (token: string, row: PriceRow) =>
    page(
      row.name,
      token,
      `${nav(token)}<p>Item ${escape(row.id)}, unit price ${money(row.unit)}.</p><p>${link(token, "prices", "Back to prices")}</p>`,
    ),
  sheet: (token: string, numbers: SheetNumbers) =>
    page(
      "Price sheet",
      token,
      `${nav(token)}<table><tr><th>Item</th><th>Unit price</th><th>Quantity</th></tr><tr><td>Widget</td><td>${numbers.unit}</td><td>${numbers.quantity}</td></tr></table>`,
    ),
  about: (token: string, facts: AboutFacts) =>
    page(
      "About",
      token,
      `${nav(token)}<p>Founded in ${facts.year}, the company has ${facts.employees} employees across ${facts.offices} offices.</p>`,
    ),
  plans: (token: string, plans: Plan[]) =>
    page(
      "Plans",
      token,
      `${nav(token)}<table><tr><th>Plan</th><th>Price</th></tr>${plans
        .map(
          (plan) =>
            `<tr><td>${escape(plan.name)}</td><td>${money(plan.price)} per ${plan.per}</td></tr>`,
        )
        .join("")}</table>`,
    ),
  team: (token: string, people: Person[]) =>
    page(
      "Team",
      token,
      `${nav(token)}<table><tr><th>Name</th><th>Role</th></tr>${people
        .map(
          (person) =>
            `<tr><td>${escape(person.name)}</td><td>${escape(person.role)}</td></tr>`,
        )
        .join("")}</table>`,
    ),
  contact: (token: string) =>
    page(
      "Contact",
      token,
      `${nav(token)}<form method="post" action="/${token}/contact"><label for="name">Name</label><input id="name" name="name" type="text"><label for="message">Message</label><textarea id="message" name="message" rows="4"></textarea><button type="submit">Submit</button></form>`,
    ),
  thanks: (token: string) =>
    page(
      "Thanks",
      token,
      `${nav(token)}<p>Thanks, your message was received by the benchmark.</p>`,
    ),
};

/* --------------------------------------------------------------- store */

export interface FixtureRequest {
  method: string;
  /** Path and query as the browser sent them ("/benchnote0a3f/orders?x=1"). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** A POST body, form-encoded. */
  body?: string;
}
export interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Headers every response carries; a page can load nothing but itself and its own stylesheet. */
export const FIXTURE_HEADERS: Record<string, string> = {
  "Content-Security-Policy": `default-src 'self'; style-src ${PAGE_STYLE_SOURCE}; form-action 'self'; base-uri 'none'`,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const header = (
  headers: FixtureRequest["headers"],
  name: string,
): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * A request the browser did not make for the person driving it: an omnibox
 * prediction, a prerender, a favicon or an image. Served nothing and never
 * logged, so `visits` holds only pages that were opened.
 */
export function isSideRequest(headers: FixtureRequest["headers"]): boolean {
  const purpose = (
    header(headers, "Sec-Purpose") ??
    header(headers, "Purpose") ??
    ""
  ).toLowerCase();
  if (/prefetch|prerender/.test(purpose)) return true;
  const accept = (header(headers, "Accept") ?? "*/*").toLowerCase();
  return !(accept.includes("text/html") || accept.includes("*/*"));
}

/** "/<token>/orders/ORD-1" -> { token, path: "/<token>/orders/ORD-1", key: "orders/ORD-1" }. */
export function routeOf(
  url: string,
): { token: string; path: string; key: string } | undefined {
  const raw = url.split("?")[0].split("#")[0];
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) return undefined;
  let token: string;
  try {
    token = decodeURIComponent(parts[0]);
  } catch {
    return undefined;
  }
  if (!TOKEN_RE.test(token)) return undefined;
  const key = parts.slice(1).join("/") || "home";
  return { token, path: `/${token}${key === "home" ? "" : "/" + key}`, key };
}

/**
 * Form fields as posted, first value per name, bounded. Built through a Map
 * so a field named "__proto__" or "constructor" is data, not the object's
 * prototype.
 */
export function parseForm(body: string | undefined): Record<string, string> {
  const fields = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(body ?? ""))
    if (name.length <= 64 && !fields.has(name) && fields.size < 32)
      fields.set(name, value.slice(0, 4096));
  return Object.fromEntries(fields);
}

/**
 * The shared navigation bar, cut down to the pages this token registered: a
 * task serves two or three pages, and a menu of links that answer "Not found"
 * would be the harness misleading the run, not a test of it.
 */
export function trimNav(html: string, keys: Set<string>): string {
  return html.replace(/<nav>(.*?)<\/nav>/s, (_, links: string) => {
    const kept = [...links.matchAll(/<a href="\/[^/"]+\/([^"]*)">[^<]*<\/a>/g)]
      .filter(([, key]) => keys.has(key || "home"))
      .map(([anchor]) => anchor);
    return kept.length ? `<nav>${kept.join(" ")}</nav>` : "";
  });
}

export interface FixtureStore {
  register(token: string, pages: Record<string, string>): void;
  read(token: string): FixtureEvidence;
  reset(token: string): void;
  /** Tokens with pages registered. */
  tokens(): string[];
  respond(request: FixtureRequest): FixtureResponse;
}

/**
 * Pages per token and what the server saw for each. Registering a token
 * again replaces its pages and forgets its log; reset keeps the pages.
 */
export function createFixtureStore(port: number = FIXTURE_PORT): FixtureStore {
  const registered = new Map<
    string,
    { pages: Record<string, string>; log: FixtureEvidence }
  >();
  const fresh = (): FixtureEvidence => ({ port, visits: [], submissions: [] });
  const html = (status: number, body: string): FixtureResponse => ({
    status,
    headers: { ...FIXTURE_HEADERS, "Content-Type": "text/html; charset=utf-8" },
    body,
  });
  const notFound = () =>
    html(404, page("Not found", "benchmark", "<p>No such page.</p>"));
  return {
    register(token, pages) {
      if (!TOKEN_RE.test(token)) throw new Error("Not a bench token.");
      const keys = new Set(Object.keys(pages));
      registered.set(token, {
        pages: Object.fromEntries(
          Object.entries(pages).map(([key, html]) => [
            key,
            trimNav(html, keys),
          ]),
        ),
        log: fresh(),
      });
    },
    read(token) {
      const entry = registered.get(token);
      return entry
        ? {
            port,
            visits: [...entry.log.visits],
            submissions: entry.log.submissions.map((s) => ({
              path: s.path,
              fields: { ...s.fields },
            })),
          }
        : fresh();
    },
    reset(token) {
      const entry = registered.get(token);
      if (entry) entry.log = fresh();
    },
    tokens: () => [...registered.keys()],
    respond(request) {
      const route = routeOf(request.url);
      const entry = route && registered.get(route.token);
      if (!route || !entry) return notFound();
      if (isSideRequest(request.headers))
        return { status: 204, headers: { ...FIXTURE_HEADERS }, body: "" };
      const method = request.method.toUpperCase();
      // Own keys only: "constructor" is not a page this token registered.
      const known = Object.hasOwn(entry.pages, route.key);
      if (method === "POST") {
        if (!known) return notFound();
        entry.log.submissions.push({
          path: route.path,
          fields: parseForm(request.body),
        });
        // A redirect, so the thanks page is a visit of its own and a reload
        // cannot submit twice.
        return {
          status: 303,
          headers: { ...FIXTURE_HEADERS, Location: `/${route.token}/thanks` },
          body: "",
        };
      }
      if (method !== "GET" && method !== "HEAD")
        return { status: 405, headers: { ...FIXTURE_HEADERS }, body: "" };
      const body = known ? entry.pages[route.key] : undefined;
      if (typeof body !== "string") return notFound();
      // A HEAD is a check, not a page someone opened.
      if (method === "GET" && entry.log.visits.length < 500)
        entry.log.visits.push(route.path);
      return html(200, method === "HEAD" ? "" : body);
    },
  };
}

/** The contract handle over a store, for a server bound to `port`. */
export function fixtureHandle(
  store: FixtureStore,
  port: number,
): FixtureHandle {
  const url = `http://${FIXTURE_HOST}:${port}`;
  return {
    port,
    url,
    register(token, pages) {
      store.register(token, pages);
      return `${url}/${token}`;
    },
    read: (token) => store.read(token),
    reset: (token) => store.reset(token),
  };
}
