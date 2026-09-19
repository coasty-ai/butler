import { describe, expect, it } from "vitest";
import {
  RECIPES,
  buildUrl,
  cleanObject,
  homeUrl,
  matchRecipe,
  queryProblem,
  recipeSearch,
  siteAtStart,
  siteByHost,
  siteByKey,
  siteByName,
  type RecipeMatch,
} from "../src/voice/recipes";

const site = (key: string) => siteByKey(key)!;
/** A URL match as [site, intent, q, url]; anything else is undefined. */
const url = (m: RecipeMatch | undefined): string[] | undefined =>
  m?.kind === "url" ? [m.site.key, m.intent, m.q, m.url] : undefined;

describe("the recipe table", () => {
  it("pins every site: key, names, host, home and templates", () => {
    expect(
      RECIPES.map((r) => [
        r.key,
        [...r.names],
        r.host,
        r.home,
        r.templates,
        r.app,
      ]),
    ).toEqual([
      [
        "youtube",
        ["youtube", "you tube"],
        "www.youtube.com",
        "https://www.youtube.com/",
        { search: "https://www.youtube.com/results?search_query={q}" },
        undefined,
      ],
      [
        "google",
        ["google"],
        "www.google.com",
        "https://www.google.com/",
        { search: "https://www.google.com/search?q={q}" },
        undefined,
      ],
      [
        "google-maps",
        ["google maps"],
        "www.google.com",
        "https://www.google.com/maps",
        {
          search: "https://www.google.com/maps/search/{q}",
          directions: "https://www.google.com/maps/dir/?api=1&destination={q}",
        },
        undefined,
      ],
      [
        "amazon",
        ["amazon"],
        "www.amazon.com",
        "https://www.amazon.com/",
        { search: "https://www.amazon.com/s?k={q}" },
        undefined,
      ],
      [
        "wikipedia",
        ["wikipedia"],
        "en.wikipedia.org",
        "https://en.wikipedia.org/",
        { search: "https://en.wikipedia.org/w/index.php?search={q}" },
        undefined,
      ],
      [
        "github",
        ["github", "git hub"],
        "github.com",
        "https://github.com/",
        { search: "https://github.com/search?q={q}" },
        undefined,
      ],
      [
        "reddit",
        ["reddit"],
        "www.reddit.com",
        "https://www.reddit.com/",
        { search: "https://www.reddit.com/search/?q={q}" },
        undefined,
      ],
      [
        "x",
        ["twitter", "x"],
        "x.com",
        "https://x.com/",
        { search: "https://x.com/search?q={q}" },
        undefined,
      ],
      [
        "gmail",
        ["gmail", "google mail"],
        "mail.google.com",
        "https://mail.google.com/",
        { search: "https://mail.google.com/mail/u/0/#search/{q}" },
        undefined,
      ],
      [
        "spotify",
        ["spotify"],
        "open.spotify.com",
        "https://open.spotify.com/",
        {},
        "Spotify",
      ],
      [
        "app-store",
        ["app store"],
        "apps.apple.com",
        "https://apps.apple.com/",
        {},
        "App Store",
      ],
    ]);
  });

  it("builds every template on its own host, https, with the object as the only variable", () => {
    for (const r of RECIPES) {
      expect(new URL(r.home).hostname).toBe(r.host);
      expect(new URL(r.home).protocol).toBe("https:");
      for (const template of Object.values(r.templates)) {
        expect(template.split("{q}")).toHaveLength(2);
        const built = new URL(buildUrl(template, "a b"));
        expect(built.hostname).toBe(r.host);
        expect(built.protocol).toBe("https:");
      }
      expect(r.domain).toMatch(/^[a-z0-9.-]+$/);
      expect(homeUrl(r)).toBe(r.home);
    }
  });

  it("finds a site by name, by host under its domain, and at the start of some words", () => {
    expect(siteByName("YouTube")?.key).toBe("youtube");
    expect(siteByName("you tube")?.key).toBe("youtube");
    expect(siteByName("Google Maps")?.key).toBe("google-maps");
    expect(siteByName("the app store")).toBeUndefined();
    expect(siteByName("netflix")).toBeUndefined();
    expect(siteByHost("www.youtube.com")?.key).toBe("youtube");
    expect(siteByHost("m.youtube.com")?.key).toBe("youtube");
    expect(siteByHost("youtube.com")?.key).toBe("youtube");
    expect(siteByHost("www.google.com")?.key).toBe("google");
    expect(siteByHost("maps.google.com")?.key).toBe("google-maps");
    expect(siteByHost("mail.google.com")?.key).toBe("gmail");
    expect(siteByHost("notyoutube.com")).toBeUndefined();
    expect(siteByHost(undefined)).toBeUndefined();
    expect(siteAtStart(["google", "maps", "coffee"])).toEqual({
      site: site("google-maps"),
      len: 2,
    });
    expect(siteAtStart(["google", "coffee"])).toEqual({
      site: site("google"),
      len: 1,
    });
    expect(siteAtStart(["x", "for", "cats"])).toBeUndefined();
    expect(siteAtStart(["midwest", "safety"])).toBeUndefined();
  });
});

describe("the object", () => {
  it("encodes the object into the template and nothing else", () => {
    expect(
      buildUrl("https://a.example/s?q={q}", "salt & pepper #1 / two"),
    ).toBe("https://a.example/s?q=salt%20%26%20pepper%20%231%20%2F%20two");
    expect(buildUrl("https://a.example/s?q={q}", "café naïve")).toBe(
      "https://a.example/s?q=caf%C3%A9%20na%C3%AFve",
    );
    // A second placeholder in an object is text, not a template.
    expect(buildUrl("https://a.example/s?q={q}", "{q}")).toBe(
      "https://a.example/s?q=%7Bq%7D",
    );
  });

  it("strips a leading 'for' or article and the trailing generic nouns, and keeps the rest", () => {
    expect(cleanObject(["a", "midwest", "safety", "video"])).toBe(
      "midwest safety",
    );
    expect(cleanObject(["for", "the", "weather", "in", "austin"])).toBe(
      "the weather in austin",
    );
    expect(cleanObject(["some", "jazz", "songs", "please"])).toBe("jazz");
    expect(cleanObject(["cats", "for", "me"])).toBe("cats");
    expect(cleanObject(["the", "office"])).toBe("the office");
    expect(cleanObject(["the", "weather", "channel"])).toBe(
      "the weather channel",
    );
    expect(cleanObject(["midwest", "safety", "clips", "now"])).toBe(
      "midwest safety",
    );
    expect(cleanObject(["the", "video"])).toBe("the");
    expect(cleanObject([])).toBe("");
  });

  it("refuses an object that is short, stopwords, an '@', a URL, a host or a credential", () => {
    expect(queryProblem("")).toBe("needs_final");
    expect(queryProblem("a")).toBe("needs_final");
    expect(queryProblem("the")).toBe("needs_final");
    expect(queryProblem("the a")).toBe("needs_final");
    expect(queryProblem("me@example.com")).toBe("needs_final");
    expect(queryProblem("https://example.com")).toBe("needs_final");
    expect(queryProblem("paypal.com")).toBe("needs_final");
    expect(queryProblem("go to www.youtube.com")).toBe("needs_final");
    expect(queryProblem("sk-abcdefghijklmnopqrst")).toBe("needs_final");
    expect(queryProblem("AKIAABCDEFGHIJKLMNOP")).toBe("needs_final");
    expect(queryProblem("midwest safety")).toBeUndefined();
    expect(queryProblem("42")).toBeUndefined();
    expect(queryProblem("the weather in austin")).toBeUndefined();
    // A phone number is looked up, not leaked: only credentials and URLs refuse.
    expect(queryProblem("555 123 4567")).toBeUndefined();
    expect(queryProblem("u.s. open")).toBeUndefined();
  });

  it("recipeSearch builds the site's URL, or says what stands in the way", () => {
    expect(
      url(recipeSearch(site("youtube"), ["a", "midwest", "safety", "video"])),
    ).toEqual([
      "youtube",
      "search",
      "midwest safety",
      "https://www.youtube.com/results?search_query=midwest%20safety",
    ]);
    expect(recipeSearch(site("youtube"), ["a"])).toEqual({
      kind: "needs_final",
      site: site("youtube"),
    });
    expect(recipeSearch(site("youtube"), ["cats"], "directions")).toEqual({
      kind: "ambiguous",
    });
    expect(recipeSearch(site("spotify"), ["jazz"])).toEqual({
      kind: "app",
      site: site("spotify"),
      name: "Spotify",
    });
  });
});

describe("matchRecipe", () => {
  it("selects the site named in a site slot: after the verb, after a preposition, before 'for'", () => {
    expect(url(matchRecipe("search youtube for cats"))).toEqual([
      "youtube",
      "search",
      "cats",
      "https://www.youtube.com/results?search_query=cats",
    ]);
    expect(url(matchRecipe("search youtube cats"))?.[2]).toBe("cats");
    expect(url(matchRecipe("play cats on youtube"))?.[0]).toBe("youtube");
    expect(url(matchRecipe("find cats in reddit"))?.[0]).toBe("reddit");
    expect(url(matchRecipe("look up cats at wikipedia"))?.[0]).toBe(
      "wikipedia",
    );
    expect(url(matchRecipe("search for cats using google"))?.[0]).toBe(
      "google",
    );
    expect(url(matchRecipe("search on google about cats"))?.[2]).toBe("cats");
    expect(url(matchRecipe("search google maps for coffee"))).toEqual([
      "google-maps",
      "search",
      "coffee",
      "https://www.google.com/maps/search/coffee",
    ]);
    expect(matchRecipe("search the app store for todo apps")).toEqual({
      kind: "app",
      site: site("app-store"),
      name: "App Store",
    });
    expect(
      url(matchRecipe("search x for cats", { browserFront: true }))?.[0],
    ).toBe("google");
    expect(
      url(matchRecipe("search x for cats", { browserFront: true }))?.[2],
    ).toBe("x for cats");
    expect(url(matchRecipe("search on x for cats"))?.[0]).toBe("x");
    expect(url(matchRecipe("search twitter for cats"))?.[0]).toBe("x");
    expect(url(matchRecipe("search google mail for receipts"))?.[0]).toBe(
      "gmail",
    );
  });

  it("leaves a site's name in the object when it is not in a site slot", () => {
    expect(url(matchRecipe("search google for youtube shortcuts"))).toEqual([
      "google",
      "search",
      "youtube shortcuts",
      "https://www.google.com/search?q=youtube%20shortcuts",
    ]);
    // ...though a trailing generic noun still goes.
    expect(url(matchRecipe("search google for youtube videos"))?.[2]).toBe(
      "youtube",
    );
    expect(url(matchRecipe("search gmail for receipts from amazon"))?.[2]).toBe(
      "receipts from amazon",
    );
    expect(url(matchRecipe("search google for the reddit outage"))?.[2]).toBe(
      "the reddit outage",
    );
  });

  it("is ambiguous with two sites in site slots", () => {
    expect(matchRecipe("search youtube on google")).toEqual({
      kind: "ambiguous",
    });
    expect(matchRecipe("search google for cats on amazon")).toEqual({
      kind: "ambiguous",
    });
  });

  it("gives the front page for a place verb with the site alone or its homepage", () => {
    expect(matchRecipe("go to youtube")).toEqual({
      kind: "home",
      site: site("youtube"),
    });
    expect(matchRecipe("open the app store")).toEqual({
      kind: "app",
      site: site("app-store"),
      name: "App Store",
    });
    expect(matchRecipe("pull up the youtube homepage")).toEqual({
      kind: "home",
      site: site("youtube"),
    });
    expect(matchRecipe("pull up the reddit home page")).toEqual({
      kind: "home",
      site: site("reddit"),
    });
    // A search verb with the site alone wants a query the words do not have yet.
    expect(matchRecipe("search youtube")).toEqual({
      kind: "needs_final",
      site: site("youtube"),
    });
    // A place verb with no site is the early grammar's, not a recipe.
    expect(matchRecipe("go to the store")).toBeUndefined();
    expect(matchRecipe("open slack")).toBeUndefined();
  });

  it("uses the verb's own site, the front host, or the verb's default in a browser", () => {
    expect(url(matchRecipe("google the weather"))?.[0]).toBe("google");
    expect(url(matchRecipe("directions to the airport"))).toEqual([
      "google-maps",
      "directions",
      "the airport",
      "https://www.google.com/maps/dir/?api=1&destination=the%20airport",
    ]);
    expect(url(matchRecipe("how do i get to the airport"))?.[1]).toBe(
      "directions",
    );
    expect(url(matchRecipe("navigate to 1 infinite loop"))?.[2]).toBe(
      "1 infinite loop",
    );
    expect(
      url(matchRecipe("search for cats", { frontHost: "www.amazon.com" }))?.[0],
    ).toBe("amazon");
    expect(
      url(matchRecipe("play cats", { frontHost: "m.youtube.com" }))?.[0],
    ).toBe("youtube");
    // The front host is a site with no template for the intent, or an app: no help.
    expect(
      matchRecipe("directions to the airport", { frontHost: "www.youtube.com" })
        ?.kind,
    ).toBe("url");
    expect(matchRecipe("play cats", { frontHost: "open.spotify.com" })).toEqual(
      {
        kind: "unsure",
        media: true,
      },
    );
    expect(
      url(matchRecipe("search for cats", { browserFront: true }))?.[0],
    ).toBe("google");
    expect(url(matchRecipe("look up cats", { browserFront: true }))?.[0]).toBe(
      "google",
    );
    expect(
      url(matchRecipe("shop for shoes", { browserFront: true }))?.[0],
    ).toBe("amazon");
    expect(
      url(matchRecipe("read about saturn", { browserFront: true }))?.[0],
    ).toBe("wikipedia");
    expect(
      url(matchRecipe("watch the game", { browserFront: true }))?.[0],
    ).toBe("youtube");
    // Not in a browser, a bare search is unsure.
    expect(matchRecipe("search for cats")).toEqual({
      kind: "unsure",
      media: false,
    });
    expect(matchRecipe("play cats")).toEqual({ kind: "unsure", media: true });
    expect(matchRecipe("find cats", { browserFront: true })).toEqual({
      kind: "unsure",
      media: false,
    });
  });

  it("assumes a search on Jev's word: media to YouTube, the rest to Google, any verb", () => {
    expect(url(matchRecipe("play cats", { assume: true }))?.[0]).toBe(
      "youtube",
    );
    expect(url(matchRecipe("listen to jazz", { assume: true }))?.[0]).toBe(
      "youtube",
    );
    expect(url(matchRecipe("find cats", { assume: true }))?.[0]).toBe("google");
    expect(url(matchRecipe("pull up cats", { assume: true }))?.[0]).toBe(
      "google",
    );
    expect(url(matchRecipe("fetch the weather", { assume: true }))).toEqual([
      "google",
      "search",
      "the weather",
      "https://www.google.com/search?q=the%20weather",
    ]);
    expect(
      url(
        matchRecipe("play cats", { assume: true, frontHost: "www.amazon.com" }),
      )?.[0],
    ).toBe("amazon");
    expect(matchRecipe("", { assume: true })).toBeUndefined();
  });

  it("returns undefined for words no recipe verb begins", () => {
    expect(matchRecipe("the one on the right")).toBeUndefined();
    expect(matchRecipe("send it")).toBeUndefined();
    expect(matchRecipe("scroll down")).toBeUndefined();
    expect(matchRecipe("please can you type hello")).toBeUndefined();
  });

  it("skips leads and fillers before the verb", () => {
    expect(
      url(matchRecipe("ok so um please search youtube for cats"))?.[2],
    ).toBe("cats");
    expect(url(matchRecipe("can you google the weather"))?.[2]).toBe(
      "the weather",
    );
  });
});
