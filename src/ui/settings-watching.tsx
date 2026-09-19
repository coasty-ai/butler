/**
 * Settings › Watching (.data/design/observer.md §4, §6): the "Watch how I
 * work" switch (off by default), the tier with one plain sentence each on
 * what is stored and what is sent to the model at consolidation, retention,
 * the pause state, "Forget today" and "Forget all", and under it What I've
 * learned: the routines, procedures and preferences watching proposed with
 * their evidence and Approve / Not this / Never, and the approved ones with
 * their replay counts. Counts and the owner's own approvals only; nothing
 * here shows a title, a host or a word from the log.
 */
import React, { useEffect, useState } from "react";
import type { ObserverSettings, ObserverTier, Settings } from "../core/schema";
import type { Preference, Procedure, Routine } from "../memory/types";
import { weekdaysPhrase } from "../observer/routines";
import type {
  AppInfo,
  Bridge,
  LearnedProposals,
  ProposalDecision,
  ProposalKind,
  WatchingStatus,
} from "./api";

export interface TierInfo {
  tier: ObserverTier;
  name: string;
  /** What a frame stores on this Mac. */
  stored: string;
  /** What goes to the model when the day is consolidated. */
  sent: string;
}
export const TIERS: readonly TierInfo[] = [
  {
    tier: "structure",
    name: "Structure",
    stored:
      "Stores which application and window are in front, the web site's host, the name of the field you are in, and what you did as clicks, key chords, scrolls and how many characters you typed. Never the characters.",
    sent: "Sends the model that same timeline: applications, hosts, window titles with numbers removed, field names and action kinds.",
  },
  {
    tier: "text",
    name: "With text",
    stored:
      "Also stores the words on screen, up to 1,500 characters a frame, with anything that looks like a credential removed; a frame that would carry one is dropped.",
    sent: "Sends the model the timeline and those words, about 300 characters for each stretch in an application.",
  },
  {
    tier: "pixels",
    name: "With pictures",
    stored:
      "Also stores a small picture of the screen with each frame, never of a protected application or site, kept for 24 hours and then removed.",
    sent: "Sends the model the timeline and the words. Pictures never leave this Mac.",
  },
];
export const tierInfo = (tier: ObserverTier) =>
  TIERS.find((t) => t.tier === tier) ?? TIERS[0];

/** The collapsed group's one line. */
export function summary(s: Settings, status?: WatchingStatus): string {
  if (!s.observer.on) return "Off";
  const tier = tierInfo(s.observer.tier).name.toLowerCase();
  return status?.paused ? `Paused · ${tier}` : `Watching · ${tier}`;
}
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const kb = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
/** Today's counts, in words. */
export function digestLine(status: WatchingStatus | undefined): string {
  if (!status) return "Reading…";
  const { frames, actions } = status.today;
  const excluded = Object.values(status.today.excluded).reduce(
    (a, b) => a + b,
    0,
  );
  const dropped = status.today.framesDropped + status.today.dropped.helper;
  const parts = [
    `Today: ${plural(frames, "frame")}, ${plural(actions, "action")}`,
    ...(excluded ? [`${excluded} excluded at the source`] : []),
    ...(dropped ? [`${dropped} dropped`] : []),
    `${plural(status.days.length, "day")} kept (${kb(status.bytes)})`,
  ];
  return parts.join(" · ");
}
/** The consolidator's last run and today's spend, in words. */
export function consolidationLine(status: WatchingStatus | undefined): string {
  if (!status) return "";
  const c = status.consolidation;
  const spend = `${c.tokensToday.toLocaleString()} of ${c.budget.toLocaleString()} tokens used today`;
  if (!c.lastAt)
    return `Not consolidated yet; runs after ${plural(c.idleMinutes, "minute")} idle. ${spend}.`;
  const when = new Date(c.lastAt);
  const at = Number.isNaN(when.getTime())
    ? ""
    : ` at ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const code =
    c.lastCode === "ok"
      ? "done"
      : c.lastCode === "empty"
        ? "nothing to read"
        : c.lastCode === "budget"
          ? "budget spent"
          : c.lastCode === "privacy"
            ? "not sent (Private local needs the local model)"
            : c.lastCode === "parse"
              ? "the model's answer was not usable"
              : c.lastCode === "model"
                ? "the model did not answer"
                : (c.lastCode ?? "");
  return `Last consolidated${at}: ${code}. ${spend}.`;
}
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const hours = (range: [number, number]) => {
  const h = (x: number) =>
    x === 0 || x === 24
      ? "midnight"
      : x === 12
        ? "noon"
        : x < 12
          ? `${x} am`
          : `${x - 12} pm`;
  return `${h(range[0])}–${h(range[1])}`;
};
/** A routine's evidence: "Seen 5 days, last Sep 18 · weekdays 9 am–10 am". */
export function routineEvidence(r: Routine): string {
  return `Seen ${plural(r.seen, "day")}, last ${dayOf(r.lastSeen)} · ${weekdaysPhrase(r.when.weekdays)} ${hours(r.when.hourRange)} · confidence ${Math.round(r.confidence * 100)}%`;
}
/** An approved routine's replays. */
export function routineReplays(r: Routine): string {
  const total =
    r.runs.completed +
    r.runs.corrected +
    r.runs.undone +
    r.runs.declined +
    r.runs.failed;
  if (!total) return "Not replayed yet";
  return `Replayed ${plural(total, "time")}: ${r.runs.completed} completed, ${r.runs.corrected} corrected, ${r.runs.undone} undone, ${r.runs.declined} declined, ${r.runs.failed} failed`;
}
export function procedureEvidence(p: Procedure): string {
  return `Observed ${plural(p.observedRuns, "time")}, last ${dayOf(p.lastSeen)} · ${plural(p.steps.length, "step")} · confidence ${Math.round(p.confidence * 100)}%`;
}
export function procedureReplays(
  p: LearnedProposals["procedures"][number],
): string {
  if (!p.replays || !(p.replays.successes + p.replays.failures))
    return "Not replayed yet; it starts as a hint and replays on its own after two successes";
  return `Replayed ${plural(p.replays.successes + p.replays.failures, "time")}: ${p.replays.successes} worked, ${p.replays.failures} did not`;
}
export function preferenceEvidence(p: Preference): string {
  return `Seen ${plural(p.weight, "time")}, last ${dayOf(p.updatedAt)}`;
}
/** The routine's steps as applications, for the card. */
export function routineSteps(r: Routine): string {
  return r.steps
    .map(
      (s) =>
        `${s.appName ?? s.appId.split(".").at(-1) ?? s.appId}${s.host ? ` (${s.host})` : ""}`,
    )
    .join(" → ");
}

const EMPTY: LearnedProposals = {
  routines: [],
  procedures: [],
  preferences: [],
};

export function SettingsWatching({
  s,
  set,
  api,
  busy,
  info,
}: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  api: Bridge;
  busy: boolean;
  info: AppInfo;
}) {
  const [status, setStatus] = useState<WatchingStatus | undefined>();
  const [learned, setLearned] = useState<LearnedProposals>(EMPTY);
  const [forgetting, setForgetting] = useState<"today" | "all" | undefined>();
  const [error, setError] = useState("");
  const local = s.privacy === "PRIVATE_LOCAL";
  useEffect(() => {
    let current = true;
    const load = () => {
      api
        .watchingStatus()
        .then((next) => current && setStatus(next))
        .catch(() => {});
      api
        .learnedProposals()
        .then((next) => current && setLearned(next))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [info]);
  const observer: ObserverSettings = s.observer;
  const update = (patch: Partial<ObserverSettings>) =>
    set("observer", { ...observer, ...patch });
  const act = async (work: () => Promise<WatchingStatus>) => {
    setError("");
    try {
      setStatus(await work());
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : "") || "That could not be done.",
      );
    }
  };
  const decide = async (
    kind: ProposalKind,
    id: string,
    decision: ProposalDecision,
  ) => {
    setError("");
    try {
      setLearned(await api.decideProposal(kind, id, decision));
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : "") || "That could not be saved.",
      );
    }
  };
  const tier = tierInfo(observer.tier);
  const decisions = (kind: ProposalKind, id: string) => (
    <span className="field-pair">
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void decide(kind, id, "approve")}
      >
        Approve
      </button>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void decide(kind, id, "dismiss")}
      >
        Not this
      </button>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void decide(kind, id, "never")}
      >
        Never
      </button>
    </span>
  );
  const proposedCount =
    learned.routines.filter((r) => r.status === "proposed").length +
    learned.procedures.filter((p) => p.status === "proposed").length +
    learned.preferences.filter((p) => p.status === "proposed").length;
  return (
    <details className="setting-group">
      <summary>
        <span>
          Watching
          <span>{summary(s, status)}</span>
        </span>
      </summary>
      <div className="setting-fields">
        <p>
          With this on, Butler watches how you work so it can learn your
          routines and, once you approve them, do them for you. It writes what
          it sees to an encrypted log on this Mac and, when you have been idle a
          while, asks your model what repeats. Nothing it watches ever types or
          clicks by itself. Passwords, protected applications and sites, the
          lock screen and what you type are never recorded.
        </p>
        <label className="consent">
          <input
            type="checkbox"
            checked={observer.on}
            disabled={busy}
            onChange={(e) => update({ on: e.target.checked })}
          />
          <span>Watch how I work</span>
        </label>
        <label>
          What each frame keeps
          <select
            value={observer.tier}
            disabled={busy}
            onChange={(e) => update({ tier: e.target.value as ObserverTier })}
          >
            {TIERS.map((t) => (
              <option key={t.tier} value={t.tier}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <p>
          {tier.stored} {tier.sent}
        </p>
        <p>
          {local
            ? "Private local: the day's timeline is read by your local model and nothing leaves this Mac."
            : `The day's timeline goes to ${s.provider} (${s.model}) when the day is consolidated. Pictures never do.`}
        </p>
        <label>
          Keep the raw log for (days)
          <input
            type="number"
            min={1}
            max={90}
            value={observer.retentionDays}
            disabled={busy}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 90)
                update({ retentionDays: n });
            }}
          />
        </label>
        <p role="status">{digestLine(status)}</p>
        {status && <p>{consolidationLine(status)}</p>}
        {status && <p>Stored under {status.path}.</p>}
        {status?.on && (
          <p role="status">
            {status.paused
              ? "Paused: nothing is being written. Say “start watching” or resume here."
              : "Watching. Say “Hey Butler, stop watching” or use the menu bar to pause."}
          </p>
        )}
        <div className="field-pair">
          {status?.on && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(() => api.setWatchingPaused(!status.paused))
              }
            >
              {status.paused ? "Resume watching" : "Pause watching"}
            </button>
          )}
          {forgetting ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => setForgetting(undefined)}
              >
                Keep
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  const scope = forgetting;
                  setForgetting(undefined);
                  void act(() => api.forgetWatching(scope));
                }}
              >
                {forgetting === "today"
                  ? "Yes, forget today"
                  : "Yes, forget every day"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy || !status}
                onClick={() => setForgetting("today")}
              >
                Forget today
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !status || !status.days.length}
                onClick={() => setForgetting("all")}
              >
                Forget all
              </button>
            </>
          )}
        </div>
        <h4>
          What I’ve learned
          {proposedCount ? ` · ${plural(proposedCount, "proposal")}` : ""}
        </h4>
        <p>
          Butler proposes; you decide. Approve a routine and it runs at its time
          as an ordinary task, with the same rules and approvals as one you
          asked for. Approve a procedure and it becomes a learned routine the
          runner replays. “Not this” drops a proposal; “Never” keeps it from
          coming back.
        </p>
        {!learned.routines.length &&
          !learned.procedures.length &&
          !learned.preferences.length && <p>Nothing proposed yet.</p>}
        {learned.routines.map((r) => (
          <div key={r.id} className="consent">
            <span>
              <b>{r.name}</b> · {routineSteps(r)}
              <br />
              <small>{routineEvidence(r)}</small>
              {r.corrections?.length ? (
                <>
                  <br />
                  <small>
                    Sent back after corrections: {r.corrections.join("; ")}
                  </small>
                </>
              ) : null}
              <br />
              {r.status === "approved" ? (
                <small>Approved · {routineReplays(r)}</small>
              ) : (
                decisions("routine", r.id)
              )}
            </span>
          </div>
        ))}
        {learned.procedures.map((p) => (
          <div key={p.id} className="consent">
            <span>
              <b>{p.trigger}</b>
              <br />
              <small>{procedureEvidence(p)}</small>
              <br />
              {p.status === "approved" ? (
                <small>Approved · {procedureReplays(p)}</small>
              ) : (
                decisions("procedure", p.id)
              )}
            </span>
          </div>
        ))}
        {learned.preferences.map((p) => (
          <div key={p.id} className="consent">
            <span>
              {p.text}
              <br />
              <small>{preferenceEvidence(p)}</small>
              <br />
              {p.status === "approved" || p.status === undefined ? (
                <small>Approved</small>
              ) : (
                decisions("preference", p.id)
              )}
            </span>
          </div>
        ))}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
