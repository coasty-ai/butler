/**
 * The user's site recipes file (.data/design/modules.md §2 `recipes`):
 * `~/Library/Application Support/coarena-open-assist/recipes.json`, an array
 * of SiteRecipe entries merged over the built-in table by key, so a user
 * may add a site the table lacks or replace a built-in's templates. Pure:
 * electron/recipes.ts reads and watches the file and installs the merge.
 *
 * Every entry is validated on its own and a bad one is rejected by index
 * with a code, never silently dropped and never able to spoil its
 * neighbours. What a template may be is what keeps a recipe URL safe: https
 * only, exactly one `{q}` placeholder, no credentials, and its host exactly
 * the entry's `host`, so a recipe can reach its own site and nothing else;
 * the home page must be https on the host or under the domain. Names are
 * how people say the site (lowercase words), at most 8 of at most 40
 * characters; the key follows the action schema's siteKey rule so a
 * streamed step can carry it; at most 100 entries.
 */
import { z } from "zod";
import { RECIPES, type SiteRecipe } from "./recipes";

export const RECIPES_FILE_LIMITS = {
  entries: 100,
  name: 40,
  names: 8,
  url: 2000,
} as const;
/** The name of the file under the app's data folder (app.getPath("userData")). */
export const RECIPES_FILE_NAME = "recipes.json";

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    "a host name",
  );
const shortText = z.string().trim().min(1).max(RECIPES_FILE_LIMITS.name);
/** The wire shape of one entry; `app` marks an application (nothing is built). */
export const recipeEntrySchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_-]*$/, "a short site code"),
    label: shortText,
    names: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .min(1)
          .max(RECIPES_FILE_LIMITS.name)
          .regex(/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u, "spoken words"),
      )
      .min(1)
      .max(RECIPES_FILE_LIMITS.names),
    domain: hostname,
    host: hostname,
    home: z.string().trim().min(8).max(RECIPES_FILE_LIMITS.url),
    templates: z
      .object({
        search: z.string().trim().max(RECIPES_FILE_LIMITS.url).optional(),
        directions: z.string().trim().max(RECIPES_FILE_LIMITS.url).optional(),
      })
      .strict()
      .default({}),
    app: shortText.optional(),
  })
  .strict();
export type RecipeEntry = z.infer<typeof recipeEntrySchema>;

/** Why one entry was rejected; a code for the pane and the trace, never the entry. */
export type RecipeRejection =
  | "not_object"
  | "key"
  | "label"
  | "names"
  | "domain"
  | "host"
  | "home"
  | "templates"
  | "app"
  | "home_scheme"
  | "home_host"
  | "template_scheme"
  | "template_placeholder"
  | "template_credentials"
  | "template_host"
  | "duplicate_key"
  | "too_many"
  | "invalid";
export type RecipesFileError = "not_json" | "not_array";
export interface RecipesFileParse {
  entries: SiteRecipe[];
  rejected: { index: number; code: RecipeRejection }[];
  /** The file as a whole could not be read as an array: nothing loaded. */
  error?: RecipesFileError;
}

const FIELD_CODES = new Set<RecipeRejection>([
  "key",
  "label",
  "names",
  "domain",
  "host",
  "home",
  "templates",
  "app",
]);
/** A parsed https address without credentials, query or fragment surprises, or undefined. */
function httpsUrl(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !url.hostname) return undefined;
  return url;
}
const underDomain = (host: string, domain: string) =>
  host === domain || host.endsWith("." + domain);

/** One entry checked field by field, then its addresses against its host. */
export function checkRecipeEntry(
  raw: unknown,
): { ok: true; recipe: SiteRecipe } | { ok: false; code: RecipeRejection } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, code: "not_object" };
  const parsed = recipeEntrySchema.safeParse(raw);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return {
      ok: false,
      code: FIELD_CODES.has(field as RecipeRejection)
        ? (field as RecipeRejection)
        : "invalid",
    };
  }
  const e = parsed.data;
  const home = httpsUrl(e.home);
  if (!home) return { ok: false, code: "home_scheme" };
  if (home.username || home.password) return { ok: false, code: "home_scheme" };
  if (home.hostname !== e.host && !underDomain(home.hostname, e.domain))
    return { ok: false, code: "home_host" };
  const templates: SiteRecipe["templates"] = {};
  for (const intent of ["search", "directions"] as const) {
    const template = e.templates[intent];
    if (template === undefined) continue;
    const parts = template.split("{q}");
    if (parts.length !== 2) return { ok: false, code: "template_placeholder" };
    // The placeholder stands in for the encoded object: the address around
    // it must parse on its own, on the entry's host.
    const url = httpsUrl(parts.join("q"));
    if (!url) return { ok: false, code: "template_scheme" };
    if (url.username || url.password)
      return { ok: false, code: "template_credentials" };
    if (url.hostname !== e.host) return { ok: false, code: "template_host" };
    templates[intent] = template;
  }
  return {
    ok: true,
    recipe: {
      key: e.key,
      label: e.label,
      names: e.names,
      domain: e.domain,
      host: e.host,
      home: e.home,
      templates,
      ...(e.app ? { app: e.app } : {}),
    },
  };
}

/**
 * The file's text as recipes and rejections. A file that is not a JSON
 * array loads nothing (error set); otherwise each entry stands or falls on
 * its own, a second entry with a key already used in the file is rejected,
 * and entries past the limit are rejected as too_many.
 */
export function parseRecipesFile(text: string): RecipesFileParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], rejected: [], error: "not_json" };
  }
  if (!Array.isArray(raw))
    return { entries: [], rejected: [], error: "not_array" };
  const entries: SiteRecipe[] = [];
  const rejected: RecipesFileParse["rejected"] = [];
  const keys = new Set<string>();
  raw.forEach((item, index) => {
    if (index >= RECIPES_FILE_LIMITS.entries) {
      rejected.push({ index, code: "too_many" });
      return;
    }
    const checked = checkRecipeEntry(item);
    if (!checked.ok) {
      rejected.push({ index, code: checked.code });
      return;
    }
    if (keys.has(checked.recipe.key)) {
      rejected.push({ index, code: "duplicate_key" });
      return;
    }
    keys.add(checked.recipe.key);
    entries.push(checked.recipe);
  });
  return { entries, rejected };
}

/**
 * The user's entries over the built-ins by key: a user entry replaces the
 * built-in of the same key in its place, and a new key is appended, so the
 * order the lookups try stays the table's.
 */
export function mergeRecipes(
  builtin: readonly SiteRecipe[] = RECIPES,
  user: readonly SiteRecipe[] = [],
): SiteRecipe[] {
  const byKey = new Map(user.map((r) => [r.key, r]));
  const out = builtin.map((r) => byKey.get(r.key) ?? r);
  const keys = new Set(builtin.map((r) => r.key));
  for (const r of user) if (!keys.has(r.key)) out.push(r);
  return out;
}
