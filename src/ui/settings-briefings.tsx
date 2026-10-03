import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Settings } from "../core/schema";
import type { BriefingStatus, BriefingTool } from "../briefings/types";
import type { AppInfo, Bridge } from "./api";

export const BRIEFING_INTERVALS = [5, 15, 30, 60, 120, 240, 720, 1440];
export function intervalLabel(minutes: number): string {
  return minutes < 60
    ? `${minutes} minutes`
    : minutes === 1440
      ? "24 hours"
      : minutes % 60 === 0
        ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
        : `${minutes} minutes`;
}
export function briefingStatusLine(s: BriefingStatus | undefined): string {
  if (!s?.on) return "Off";
  if (s.state === "running") return "Checking your apps…";
  if (s.error) return s.error;
  return s.nextAt
    ? `Next check at ${new Date(s.nextAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}; waits while Butler is busy or the Mac is locked.`
    : "Waiting for the next check.";
}
export function SettingsBriefings({
  s,
  set,
  api,
  busy,
  info,
  focus = false,
}: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  api: Bridge;
  busy: boolean;
  info: AppInfo;
  focus?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [status, setStatus] = useState<BriefingStatus>();
  const [tools, setTools] = useState<BriefingTool[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("{}");
  const [customInterval, setCustomInterval] = useState(false);
  const b = s.briefings;
  const update = (value: Partial<Settings["briefings"]>) =>
    set("briefings", { ...b, ...value });
  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .briefingStatus()
        .then((value) => {
          if (live) setStatus(value);
        })
        .catch(() => {});
    void read();
    void api
      .briefingTools()
      .then((value) => {
        if (live) setTools(value);
      })
      .catch(() => {});
    const timer = setInterval(() => void read(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, info]);
  useEffect(() => {
    if (focus && ref.current) {
      ref.current.open = true;
      ref.current.scrollIntoView({ block: "start" });
    }
  }, [focus]);
  const act = async (work: () => Promise<BriefingStatus | void>) => {
    setWorking(true);
    setError("");
    try {
      const value = await work();
      if (value) setStatus(value);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The briefing could not be checked.",
      );
    } finally {
      setWorking(false);
    }
  };
  const add = () => {
    try {
      const value: unknown = JSON.parse(args);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Use a JSON object for the query arguments.");
      if (args.length > 8192)
        throw new Error("The query arguments are too large.");
      update({
        reads: [
          ...b.reads.filter((r) => r.tool !== tool),
          { tool, args: value as Record<string, unknown> },
        ],
      });
      setTool("");
      setArgs("{}");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the query arguments.");
    }
  };
  const selected = tools.find((t) => t.id === tool);
  const unsaved = JSON.stringify(b) !== JSON.stringify(info.settings.briefings);
  return (
    <details ref={ref} className="setting-group" id="briefings">
      <summary>
        <span>
          Briefings
          <span>
            {b.on
              ? `Every ${intervalLabel(b.intervalMinutes)} · ${b.delivery === "notification" ? "Notification" : "Spoken"}`
              : "Off"}
          </span>
        </span>
        <ChevronDown size={15} />
      </summary>
      <div className="setting-fields">
        <p>
          Butler checks your enabled app connections and recent notifications in
          the background, tells you what needs attention, and suggests what to
          do next.
        </p>
        <label className="consent">
          <input
            type="checkbox"
            checked={b.on}
            onChange={(e) => update({ on: e.target.checked })}
          />
          <span>Give me regular briefings</span>
        </label>
        <label>
          Check every
          <select
            value={
              customInterval || !BRIEFING_INTERVALS.includes(b.intervalMinutes)
                ? "custom"
                : b.intervalMinutes
            }
            onChange={(e) => {
              if (e.target.value === "custom") setCustomInterval(true);
              else {
                setCustomInterval(false);
                update({ intervalMinutes: Number(e.target.value) });
              }
            }}
          >
            {BRIEFING_INTERVALS.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
            <option value="custom">Custom interval</option>
          </select>
        </label>
        {(customInterval ||
          !BRIEFING_INTERVALS.includes(b.intervalMinutes)) && (
          <label>
            Minutes between checks
            <input
              type="number"
              min={5}
              max={1440}
              value={b.intervalMinutes}
              onChange={(e) =>
                update({ intervalMinutes: Number(e.target.value) })
              }
            />
          </label>
        )}
        <label>
          Delivery
          <select
            value={b.delivery}
            onChange={(e) =>
              update({
                delivery: e.target.value as Settings["briefings"]["delivery"],
              })
            }
          >
            <option value="speech">Spoken briefing and readable copy</option>
            <option value="notification">
              macOS notification and readable copy
            </option>
            <option value="both">Speech, notification and readable copy</option>
          </select>
        </label>
        <p>
          Speech waits while you are talking to Butler or a task is running, and
          while the Mac is locked or asleep. Use the JARVIS personality for
          composed British phrasing. The latest readable copy stays here until
          you quit Butler or clear it.
        </p>
        <p>
          Checks cover open app names and window titles, observed notification
          banners when enabled below, your permitted Calendar and Reminders, and
          unread Mail when enabled in Tools. Other apps need a connected read
          query. Protected apps are excluded; each briefing shows its coverage.
          Suggestions wait for your instruction before becoming tasks.
        </p>
        <details>
          <summary>Connected app checks</summary>
          <p>
            Add read tools from your connected apps once; Butler reuses these
            queries at each interval. Enable the tool and unattended reads in
            Tools first.
          </p>
          {b.reads.map((r) => (
            <div className="correction-note" key={r.tool}>
              <b>
                {tools.find((t) => t.id === r.tool)?.title ??
                  r.tool.split("__")[0]}
              </b>
              <p>{r.tool.split("__")[1]}</p>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  update({ reads: b.reads.filter((x) => x.tool !== r.tool) })
                }
              >
                Remove check
              </button>
            </div>
          ))}
          <label>
            Read query
            <select value={tool} onChange={(e) => setTool(e.target.value)}>
              <option value="">Select an enabled read tool</option>
              {tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} · {t.id.split("__")[1]}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <>
              <p>{selected.does}</p>
              <p>Parameters: {selected.params || "None"}</p>
              <label>
                Query arguments (JSON)
                <textarea
                  rows={4}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <p>
                Use {"{{today}}"}, {"{{tomorrow}}"}, {"{{since}}"}, or{" "}
                {"{{now}}"} for rolling dates. Leave {"{}"} for tools without
                required arguments.
              </p>
            </>
          )}
          <button
            type="button"
            className="secondary"
            disabled={!tool || b.reads.length >= 16}
            onClick={add}
          >
            Add app check
          </button>
          <button
            type="button"
            className="secondary"
            disabled={working}
            onClick={() =>
              void api
                .briefingTools()
                .then(setTools)
                .catch((e) => setError(e.message))
            }
          >
            Refresh connected tools
          </button>
        </details>
        <details>
          <summary>Model allowance</summary>
          <label>
            Daily model tokens (this session)
            <input
              type="number"
              min={1000}
              max={1000000}
              step={1000}
              value={b.dailyTokenBudget}
              onChange={(e) =>
                update({ dailyTokenBudget: Number(e.target.value) })
              }
            />
          </label>
          <p>
            Uses your text model and privacy setting. When the allowance runs
            out or the model is unavailable, Butler gives you a local recap. No
            screenshots are taken for briefings.
          </p>
        </details>
        <p role="status">{briefingStatusLine(status)}</p>
        {unsaved && <p>Save Settings below to apply these changes.</p>}
        <div className="field-pair">
          <button
            type="button"
            className="secondary"
            disabled={
              busy ||
              working ||
              !info.settings.briefings.on ||
              unsaved ||
              status?.state === "running"
            }
            onClick={() => void act(() => api.checkBriefingNow())}
          >
            {working || status?.state === "running" ? "Checking…" : "Check now"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || working || !status?.latest}
            onClick={() => void act(() => api.forgetBriefing())}
          >
            Clear latest
          </button>
        </div>
        {status?.latest && (
          <div className="correction-note">
            <b>
              Your latest briefing ·{" "}
              {new Date(status.latest.at).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </b>
            <p style={{ whiteSpace: "pre-wrap" }}>{status.latest.text}</p>
            {status.latest.note && <p>{status.latest.note}</p>}
            <button
              type="button"
              className="secondary"
              disabled={busy || working}
              onClick={() =>
                void act(() =>
                  api.command("Talk me through my latest briefing."),
                )
              }
            >
              Discuss this briefing
            </button>
            <details>
              <summary>What Butler checked</summary>
              <ul>
                {status.latest.sources.map((source) => (
                  <li key={source.id}>
                    <b>{source.title}</b> ·{" "}
                    {source.state === "ok"
                      ? "Checked"
                      : source.state === "off"
                        ? "Off"
                        : "Needs attention"}
                    . {source.detail}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
