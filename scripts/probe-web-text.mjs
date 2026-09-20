// What the helper's page-text walk reads of the browser window in front,
// content-free: the text's length, whether it ends with the marker line, the
// walk's stop reason, node count and wall time (ScreenContext
// visibleTextTruncated, visibleTextNodes, visibleTextMs), and how many of a
// fixture page's lines the text holds, counted by the clock stamp every chat
// line carries ("06:30:") and by its group headings, never the text itself.
//
// Written for the fix-web-text lane of 2026-09-19. Market cycles
// 20260919-2044 and 20260919-2144: msg-group-chat-digest and
// memory-link-to-note scrolled and captured until the loop rule ended them
// with every fact missing and nothing written, because webVisibleText
// (native/macos/Controller.swift) started at the window, read every node's
// frame and subrole before its role, and had 0.3 s: on a long page the text
// the model saw after a scroll was the top of the viewport or nothing. The
// walk now starts at the page, prunes by frame first, has 0.8 s
// (native/macos/WebText.swift TextWalkBudget) and says when it stopped early.
// Only a live read confirms it: scrolled to the middle of a chat group, a
// reading should hold most of the lines on screen (a 900 px viewport shows
// about 25 of a group's 27) and report no `time` stop; the same reading
// before this change held the first few lines, or none.
//
// Run it with nobody at the desktop. It serves the chat fixture itself on
// the fixture port and prints the address: open it in Safari (or Chrome),
// leave the browser in front, and scroll by hand between readings.
//
//   npm run build:native
//   node --import tsx scripts/probe-web-text.mjs                 # one reading after 15 s
//   node --import tsx scripts/probe-web-text.mjs --repeat 6 --every 8000
//   node --import tsx scripts/probe-web-text.mjs --no-serve       # any page already in front
//
// No network calls beyond loopback, nothing written, no input sent.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { NativeController } from "../electron/controller.ts";
import {
  defaultSettings,
  VISIBLE_TEXT_CUT_MARKER,
} from "../src/core/schema.ts";
import { benchToken } from "../src/gym/bench/catalogue.ts";
import { createFixtureStore } from "../src/gym/bench/fixtures.ts";
import {
  CHAT_GROUPS,
  drawChat,
  marketPages,
} from "../src/gym/bench/fixtures-market.ts";
import { FIXTURE_PORT } from "../src/gym/bench/graders.ts";
import { startFixtureServer } from "./bench-fixtures.mjs";

const { values } = parseArgs({
  options: {
    repeat: { type: "string", default: "1" },
    every: { type: "string", default: "8000" },
    wait: { type: "string", default: "15000" },
    "no-serve": { type: "boolean", default: false },
  },
});
const repeat = Math.max(1, Number(values.repeat) || 1);
const every = Math.max(1000, Number(values.every) || 8000);
const wait = Math.max(0, Number(values.wait) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Each chat line carries one "HH:MM:" stamp; headings are the group names. */
const stamps = (text) => (text.match(/\b\d\d:\d\d:/g) ?? []).length;
const headings = (text) =>
  CHAT_GROUPS.filter((group) => text.split("\n").includes(group)).length;

let server;
const controller = new NativeController(
  resolve("native/bin/coarena-controller"),
  () => {},
  () => {},
  () => {},
);
try {
  if (!values["no-serve"]) {
    const store = createFixtureStore(FIXTURE_PORT);
    server = await startFixtureServer(store, { port: FIXTURE_PORT });
    const token = benchToken();
    const chat = drawChat(Math.random);
    const address = `${server.register(token, { chat: marketPages.chat(token, chat) })}/chat`;
    console.log(
      JSON.stringify({
        open: address,
        plantedLines: chat.lines.length,
        groups: CHAT_GROUPS.length,
        firstReadingInMs: wait,
      }),
    );
    await sleep(wait);
  }
  await controller.configure(structuredClone(defaultSettings));
  // The helper starts stopped; the read-only capture needs it resumed, and it
  // is stopped again below before the process is closed.
  await controller.resume();
  for (let reading = 1; reading <= repeat; reading++) {
    const frame = await controller.capture();
    const context = frame.context ?? {};
    const text = context.visibleText ?? "";
    console.log(
      JSON.stringify({
        reading,
        appId: frame.appId,
        characters: text.length,
        lines: text ? text.split("\n").length : 0,
        endsWithMarker: text.endsWith(VISIBLE_TEXT_CUT_MARKER),
        truncated: context.visibleTextTruncated ?? null,
        nodes: context.visibleTextNodes ?? null,
        elapsedMs: context.visibleTextMs ?? null,
        stampedLinesFound: stamps(text),
        groupHeadingsFound: headings(text),
        screenTextChars: (context.screenText ?? "").length,
        contextMs: frame.timings?.context ?? null,
        totalMs: frame.timings?.total ?? null,
      }),
    );
    if (reading < repeat) await sleep(every);
  }
} finally {
  try {
    await controller.stop("probe done");
  } catch {
    // Already stopped or gone: nothing to give back.
  }
  controller.close();
  await server?.close();
}
