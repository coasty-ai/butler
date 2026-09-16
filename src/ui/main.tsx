import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Command,
  Heart,
  Keyboard,
  LockKeyhole,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  X,
  Volume2,
  RotateCcw,
} from "lucide-react";
import type { AppInfo, ReviewData } from "./api";
import type { Settings, Run } from "../core/schema";
import { defaultSettings } from "../core/schema";
import { credentialScope, selectProvider } from "../providers/catalog";
import { idlePill, type PillState } from "../voice/router";
import { previewBridge } from "./preview";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import "./motion.css";
const api = window.coarena ?? previewBridge();
const isPill = location.hash === "#pill",
  isSettings = location.hash === "#settings";
const task = "Move the card to Completed and add a completion note.";
const providers = {
  ollama: "Ollama",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  compatible: "Custom compatible",
};
function Core({
  phase = "idle",
  level = 0,
}: {
  phase?: string;
  level?: number;
}) {
  return (
    <svg
      className={`assistant-core core-${phase}`}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      style={{ "--audio-level": level } as React.CSSProperties}
    >
      <circle className="core-track" cx="20" cy="20" r="17" />
      <circle
        className="core-orbit"
        cx="20"
        cy="20"
        r="17"
        strokeDasharray="41 12 8 46"
      />
      <circle
        className="core-inner"
        cx="20"
        cy="20"
        r="10.5"
        strokeDasharray="13 5 6 9"
      />
      <path className="core-guides" d="M20 0v3M40 20h-3M20 40v-3M0 20h3" />
      <circle className="core-center" cx="20" cy="20" r="3" />
    </svg>
  );
}
function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <Core />
    </span>
  );
}
function App() {
  const [pill, setPill] = useState<PillState>(idlePill),
    [info, setInfo] = useState<AppInfo | null>(null),
    [view, setView] = useState(isSettings ? "settings" : ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [runs, setRuns] = useState<Run[]>([]),
    [review, setReview] = useState<ReviewData | null>(null),
    [excluded, setExcluded] = useState<string[]>([]),
    [excludedEvents, setExcludedEvents] = useState<string[]>([]),
    [level, setLevel] = useState<"trajectory" | "statistics">("trajectory"),
    [consent, setConsent] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (!isPill) {
        setInfo(await api.info());
        setRuns(await api.history());
      }
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Try again.";
      setError(message);
      if (isPill) setPill((p) => ({ ...p, phase: "error", label: message }));
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void api.pillState().then(setPill);
    if (!isPill) void act(async () => {});
    const a = api.subscribePill(setPill),
      b = api.subscribeView((v) => {
        setView(v);
        void act(async () => {});
      });
    return () => {
      a();
      b();
    };
  }, []);
  useEffect(() => {
    if (pill.phase !== "done" || isPill) return;
    const timer = setTimeout(() => setPill(idlePill), 1800);
    return () => clearTimeout(timer);
  }, [pill.phase]);
  useEffect(() => {
    if (window.coarena) return;
    let down = 0;
    const keyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.altKey && !e.repeat) {
        e.preventDefault();
        down = performance.now();
        void api.pause();
        setPill((p) => ({
          ...p,
          phase: "listening",
          label: "Listening…",
          transcript: "Voice stays on your Mac. Native app required.",
        }));
      }
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && down) {
        e.preventDefault();
        down = 0;
        setPill((p) => ({
          ...p,
          phase: "text",
          label: "Type a command",
          transcript: "",
        }));
      }
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, []);
  const close = () => {
    setView("");
    setReview(null);
    setError("");
    if (isSettings) void api.closeSettings();
  };
  const openReview = async (id: string) => {
    setExcluded([]);
    setExcludedEvents([]);
    setLevel("trajectory");
    setConsent(false);
    setReview(await api.review(id));
  };
  const update = async (
    ex: string[],
    ev: string[],
    lv: "trajectory" | "statistics",
  ) => {
    if (!review) return;
    setExcluded(ex);
    setExcludedEvents(ev);
    setLevel(lv);
    setConsent(false);
    setReview(
      await api.review(review.run.id, {
        level: lv,
        excludedFrames: ex,
        excludedEvents: ev,
      }),
    );
  };
  const pillElement = (
    <Pill
      state={pill}
      busy={busy}
      onCommand={(text) => void act(() => api.command(text))}
      onPause={() => void act(() => api.pause())}
      onResume={() => void act(() => api.resume())}
      onStop={() => void act(() => api.stop())}
      onApprove={(yes) => void act(() => api.confirm(yes))}
      onDismiss={() => {
        setPill(idlePill);
        void api.dismiss();
      }}
      onSettings={() => void api.openSettings()}
      onType={() => void act(() => api.openCommand())}
    />
  );
  if (isPill) return <div className="pill-window">{pillElement}</div>;
  return (
    <div className={isSettings ? "settings-host" : "preview-host"}>
      {!isSettings && (
        <>
          <header className="preview-header">
            <div className="wordmark">
              <Mark />
              open assist<span>for Mac</span>
            </div>
            <div className="header-right">
              <span>INTERACTIVE PREVIEW</span>
              <button
                aria-label="Open settings"
                onClick={() => setView("settings")}
              >
                <Settings2 size={17} />
              </button>
            </div>
          </header>
          <main className="preview-main">
            <div className="intro-label">
              <span />A SHORTCUT FOR THE REST OF YOUR COMPUTER
            </div>
            <h1>
              Press a key.
              <br />
              Tell your computer
              <br />
              <em>what to do.</em>
            </h1>
            <p className="intro-description">
              It clicks, types, searches, and works across
              <br />
              the apps you already use.
            </p>
            <div className="shortcut-demo">
              <kbd>⌥</kbd>
              <span>+</span>
              <kbd>space</kbd>
              <div>
                <b>Hold to talk.</b>
                <span>Release to get it done.</span>
              </div>
            </div>
            <div className="sample-command">
              <span>“</span>Find the latest report and email it to Lawrence.
              <br />
              <span className="sample-second">
                Let me approve before sending.
              </span>
            </div>
            <div className="preview-actions">
              <button
                className="try-button"
                disabled={busy}
                onClick={() => void act(() => api.start(task, true))}
              >
                <Play size={12} fill="currentColor" />
                Try the safe tutorial
                <ArrowRight size={15} />
              </button>
              <button
                className="quiet-button"
                onClick={() => {
                  setPill({
                    ...idlePill,
                    phase: "text",
                    label: "Type a command",
                  });
                }}
              >
                or type a command
              </button>
            </div>
            <div className="preview-caveat">
              <LockKeyhole size={12} />
              This preview never records your microphone or controls your
              computer.
            </div>
          </main>
          <div className="preview-pill-dock">
            {pill.phase === "idle" ? (
              <button
                className="resting-pill"
                onClick={() =>
                  setPill({
                    ...idlePill,
                    phase: "text",
                    label: "Type a command",
                  })
                }
              >
                <Mark />
                <span>Ready when you are.</span>
                <kbd>⌥ Space</kbd>
              </button>
            ) : (
              pillElement
            )}
          </div>
          <footer className="preview-footer">
            <span>Local voice. Private by default.</span>
            <button
              onClick={() => {
                setView("review");
                void act(async () => {});
              }}
            >
              Your runs stay yours
              <ArrowRight size={12} />
            </button>
            <span>Nothing shared without your say-so.</span>
          </footer>
        </>
      )}
      {(view || isSettings) && (
        <div
          className={isSettings ? "utility-inline" : "utility-backdrop"}
          onMouseDown={(e) => {
            if (!isSettings && e.target === e.currentTarget) close();
          }}
        >
          <section
            className="utility-window"
            aria-label={
              view === "review" ? "Review local runs" : "Open Assist settings"
            }
          >
            <div className="utility-heading">
              <div>
                <Mark />
                <b>{view === "review" ? "Your local runs" : "Open Assist"}</b>
              </div>
              <button
                aria-label="Close settings"
                className="icon-button"
                onClick={close}
              >
                <X size={17} />
              </button>
            </div>
            {error && (
              <div role="alert" className="inline-error">
                {error}
                <button aria-label="Dismiss error" onClick={() => setError("")}>
                  <X size={13} />
                </button>
              </div>
            )}
            {view === "review" ? (
              <div className="review-page">
                {!review ? (
                  <>
                    <h2>Private, until you choose.</h2>
                    <p>
                      Review a run before contributing it. Your voice audio is
                      never saved.
                    </p>
                    {runs.length === 0 ? (
                      <div className="empty-review">
                        <ShieldCheck size={28} />
                        <h3>No local runs yet.</h3>
                        <button
                          className="primary"
                          onClick={() => void act(() => api.start(task, true))}
                        >
                          Try the safe tutorial
                        </button>
                      </div>
                    ) : (
                      runs.map((r) => (
                        <div className="history-row" key={r.id}>
                          <button
                            onClick={() => void act(() => openReview(r.id))}
                          >
                            <b>
                              {r.synthetic ? "Safe tutorial" : "Private task"}
                            </b>
                            <span>
                              {new Date(r.createdAt).toLocaleString()} ·{" "}
                              {r.actions} actions · {r.corrections?.length ?? 0}{" "}
                              corrections
                            </span>
                          </button>
                          {r.contribution ? (
                            <button
                              aria-label="Withdraw contribution"
                              onClick={() => void act(() => api.withdraw(r.id))}
                            >
                              <RotateCcw size={15} />
                            </button>
                          ) : null}
                          <button
                            aria-label="Delete local run"
                            onClick={() => void act(() => api.deleteRun(r.id))}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      ))
                    )}
                    <button
                      className="back-link"
                      onClick={() => setView("settings")}
                    >
                      Back to settings
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="back-link"
                      onClick={() => setReview(null)}
                    >
                      ← Local runs
                    </button>
                    <h2>Your run. Your choice.</h2>
                    <p>{review.run.task}</p>
                    <div className="level-switch">
                      <button
                        className={level === "statistics" ? "selected" : ""}
                        onClick={() =>
                          void act(() =>
                            update(excluded, excludedEvents, "statistics"),
                          )
                        }
                      >
                        Statistics only
                      </button>
                      <button
                        className={level === "trajectory" ? "selected" : ""}
                        onClick={() =>
                          void act(() =>
                            update(excluded, excludedEvents, "trajectory"),
                          )
                        }
                      >
                        Reviewed trajectory
                      </button>
                    </div>
                    <div className="scan-note">
                      <ShieldCheck size={14} />
                      {review.bundle.scan.redactions} text redactions · Real
                      screenshots stay local.
                    </div>
                    {level === "trajectory" && (
                      <>
                        <div className="frame-strip">
                          {review.frames.map((f) => (
                            <button
                              className={
                                "review-frame " +
                                (excluded.includes(f.id) || !f.synthetic
                                  ? "excluded"
                                  : "")
                              }
                              key={f.id}
                              onClick={() =>
                                void act(() =>
                                  update(
                                    excluded.includes(f.id)
                                      ? excluded.filter((x) => x !== f.id)
                                      : [...excluded, f.id],
                                    excludedEvents,
                                    level,
                                  ),
                                )
                              }
                            >
                              <img src={f.image} alt="Local frame for review" />
                              <span>
                                {f.synthetic
                                  ? excluded.includes(f.id)
                                    ? "Excluded"
                                    : "Included"
                                  : "Stays local"}
                              </span>
                            </button>
                          ))}
                        </div>
                        <div className="review-actions">
                          {review.events
                            .filter((e) => e.type === "ActionExecuted")
                            .map((e) => (
                              <label key={e.event_id}>
                                <input
                                  type="checkbox"
                                  checked={!excludedEvents.includes(e.event_id)}
                                  onChange={() =>
                                    void act(() =>
                                      update(
                                        excluded,
                                        excludedEvents.includes(e.event_id)
                                          ? excludedEvents.filter(
                                              (x) => x !== e.event_id,
                                            )
                                          : [...excludedEvents, e.event_id],
                                        level,
                                      ),
                                    )
                                  }
                                />
                                {String(
                                  (e.data.action as any)?.type,
                                ).replaceAll("_", " ")}
                              </label>
                            ))}
                        </div>
                        {review.run.corrections?.length ? (
                          <div className="correction-note">
                            {review.run.corrections.length} finalized
                            corrections included after text sanitization. No
                            audio or partial transcripts.
                          </div>
                        ) : null}
                      </>
                    )}
                    <details className="bundle-details">
                      <summary>
                        Inspect exact contribution
                        <ChevronDown size={13} />
                      </summary>
                      <pre>{JSON.stringify(review.bundle, null, 2)}</pre>
                    </details>
                    <label className="consent">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <span>
                        I reviewed this bundle and agree to contribute it for
                        computer-use research and synthetic environments. Alpha
                        retention: 7 days. I can withdraw it. Sanitized does not
                        mean anonymous.
                      </span>
                    </label>
                    <div className="review-buttons">
                      <button
                        className="secondary"
                        onClick={() => setReview(null)}
                      >
                        Keep it private
                      </button>
                      <button
                        className="primary"
                        disabled={!consent || busy}
                        onClick={() =>
                          void act(async () => {
                            await api.donate({
                              runId: review.run.id,
                              level,
                              excludedFrames: excluded,
                              excludedEvents,
                              affirmative: true,
                            });
                            setReview(null);
                          })
                        }
                      >
                        <Heart size={13} />
                        Contribute
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : info ? (
              <SettingsPanel
                info={info}
                busy={busy}
                onSave={(settings, key) =>
                  act(() => api.saveSettings(settings, key))
                }
                onPermissions={() => void act(() => api.permissions())}
                onVoice={() => void act(() => api.voicePermissions())}
                onRefresh={() => void act(async () => {})}
                onTutorial={() => void act(() => api.start(task, true))}
                onReview={() => {
                  setView("review");
                  void act(async () => {});
                }}
              />
            ) : (
              <div className="loading">Opening local settings…</div>
            )}
          </section>
        </div>
      )}
      {!view && error && (
        <div role="alert" className="toast">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function Pill({
  state,
  busy,
  onCommand,
  onPause,
  onResume,
  onStop,
  onApprove,
  onDismiss,
  onSettings,
  onType,
}: {
  state: PillState;
  busy: boolean;
  onCommand: (text: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onApprove: (yes: boolean) => void;
  onDismiss: () => void;
  onSettings: () => void;
  onType: () => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.phase === "text") {
      setText("");
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [state.phase]);
  if (state.phase === "idle") return null;
  const listening = state.phase === "listening",
    working = state.phase === "working";
  return (
    <div
      className={"pill-stack " + state.phase}
      role="status"
      aria-live="polite"
    >
      <div className="status-pill">
        <span className="pill-orb">
          {state.phase === "done" ? (
            <Check size={17} />
          ) : (
            <Core phase={state.phase} level={state.inputLevel} />
          )}
        </span>
        <div className="pill-copy">
          <b key={state.label}>{state.label}</b>
          {state.synthetic && <span>Safe tutorial · simulated workspace</span>}
        </div>
        {listening ? (
          <div className="waveform" aria-label="Listening">
            {Array.from({ length: 10 }, (_, i) => (
              <i
                key={i}
                style={
                  {
                    "--height": `${5 + Math.sin(i * 1.6) ** 2 * (12 + state.inputLevel * 20)}px`,
                    "--delay": `${i * -0.08}s`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        ) : working ? (
          <>
            <button aria-label="Pause task" onClick={onPause}>
              <Pause size={14} />
            </button>
            <button aria-label="Stop task" onClick={onStop}>
              <Square size={11} />
            </button>
          </>
        ) : state.phase === "paused" ? (
          <>
            <button aria-label="Type a correction" onClick={onType}>
              <Keyboard size={15} />
            </button>
            <button aria-label="Resume task" onClick={onResume}>
              <Play size={13} />
            </button>
            <button aria-label="Stop task" onClick={onStop}>
              <Square size={11} />
            </button>
          </>
        ) : (
          <button aria-label="Dismiss pill" onClick={onDismiss}>
            <X size={15} />
          </button>
        )}
      </div>
      {state.phase === "text" && (
        <form
          className="pill-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onCommand(text);
          }}
        >
          <input
            ref={input}
            aria-label="Command"
            placeholder="What would you like to do?"
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
          />
          <button aria-label="Execute command" disabled={!text.trim() || busy}>
            <ArrowUp size={17} />
          </button>
        </form>
      )}
      {state.phase === "approval" && (
        <div className="approval-card">
          <p>{state.transcript}</p>
          {state.detail && (
            <details>
              <summary>Action details</summary>
              <code>{state.detail}</code>
            </details>
          )}
          <div>
            <button onClick={() => onApprove(false)}>Not yet</button>
            <button
              className="approval-yes"
              onClick={() => onApprove(true)}
              disabled={!state.canApprove || busy}
            >
              <Check size={14} />
              Yes
            </button>
          </div>
        </div>
      )}
      {state.phase === "error" && (
        <div className="pill-error">
          <button onClick={onType}>
            <Keyboard size={13} />
            Type instead
          </button>
          <button onClick={onSettings}>
            <Settings2 size={13} />
            Settings
          </button>
        </div>
      )}
      {listening && state.transcript && (
        <div className="transcript">{state.transcript}</div>
      )}
    </div>
  );
}
function SettingsPanel({
  info,
  busy,
  onSave,
  onPermissions,
  onVoice,
  onRefresh,
  onTutorial,
  onReview,
}: {
  info: AppInfo;
  busy: boolean;
  onSave: (s: Settings, k?: string) => Promise<boolean>;
  onPermissions: () => void;
  onVoice: () => void;
  onRefresh: () => void;
  onTutorial: () => void;
  onReview: () => void;
}) {
  const [s, setS] = useState<Settings>(info.settings),
    [key, setKey] = useState(""),
    [touched, setTouched] = useState(false),
    [saved, setSaved] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS({ ...s, [k]: v });
    setSaved(false);
  };
  const changeProvider = (provider: Settings["provider"]) => {
    setS(selectProvider(s, provider));
    setTouched(false);
    setKey("");
    setSaved(false);
  };
  let storedKey = false;
  try {
    storedKey =
      info.credentialScopes?.includes(
        credentialScope(s.provider, s.endpoint),
      ) ??
      (info.hasKey &&
        s.provider === info.settings.provider &&
        s.endpoint === info.settings.endpoint);
  } catch {
    /* The endpoint can be incomplete while editing. */
  }
  return (
    <div className="settings-content">
      <div className="setup-intro">
        <div className="setup-keys">
          {s.handsFree ? (
            <Mic size={26} />
          ) : (
            <>
              <kbd>⌥</kbd>
              <kbd>space</kbd>
            </>
          )}
        </div>
        <h1>
          A little less mouse.
          <br />A little more done.
        </h1>
        <p>
          {s.handsFree
            ? "Say ‘Hey Assist’. Tell it what to do."
            : "Hold to speak. Release to act."}
          <br />
          {s.handsFree
            ? "Pause when you’re done. It takes it from there."
            : "Hold again to interrupt or change direction."}
        </p>
      </div>
      <div className="permission-section">
        <div>
          <span>
            <ShieldCheck size={17} />
            <b>Screen & computer control</b>
          </span>
          <button disabled={busy} onClick={onPermissions}>
            {info.permissions.screen && info.permissions.accessibility ? (
              <>
                <Check size={13} />
                Allowed
              </>
            ) : (
              "Enable"
            )}
          </button>
        </div>
        <div>
          <span>
            <Mic size={17} />
            <b>Microphone & local speech</b>
          </span>
          <button disabled={busy} onClick={onVoice}>
            {info.voice.microphone && info.voice.speech ? (
              <>
                <Check size={13} />
                Allowed
              </>
            ) : (
              "Enable"
            )}
          </button>
        </div>
        <div className="permission-foot">
          <span>
            {info.voice.onDevice
              ? "On-device speech is available."
              : "Speech stays on this Mac. No cloud fallback."}
          </span>
          <button aria-label="Recheck permissions" onClick={onRefresh}>
            <RotateCcw size={12} />
          </button>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!(await onSave(s, touched ? key : undefined))) return;
          setKey("");
          setTouched(false);
          setSaved(true);
        }}
      >
        <div className="setting-fields voice-mode">
          <label>
            Talk to Open Assist
            <select
              value={s.handsFree ? "hands-free" : "shortcut"}
              onChange={(e) =>
                set("handsFree", e.target.value === "hands-free")
              }
            >
              <option value="shortcut">Hold Option + Space</option>
              <option value="hands-free">Say “Hey Assist”</option>
            </select>
          </label>
          <p>
            {s.handsFree
              ? "Keeps your microphone on to listen locally for ‘Hey Assist’. A short pause ends your command. Turn it off anytime in the menu bar."
              : "The microphone opens only while you hold the shortcut."}
            {s.handsFree &&
              " Background speech and audio are never saved or sent."}
          </p>
          {info.settings.handsFree && (
            <p role="status">
              {info.voice.wakeListening
                ? "Listening for ‘Hey Assist’."
                : "Hands-free enabled. Enable microphone and local speech access above if needed."}
            </p>
          )}
        </div>
        <details className="setting-group">
          <summary>
            <span>
              Intelligence
              <span>
                {s.privacy === "PRIVATE_LOCAL"
                  ? "On this Mac"
                  : "Direct to your provider"}
              </span>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="setting-fields">
            <p>
              Configure once. Screenshots and commands go only to your chosen
              model.
            </p>
            <label>
              Provider
              <select
                value={s.provider}
                onChange={(e) =>
                  changeProvider(e.target.value as Settings["provider"])
                }
              >
                {Object.entries(providers).map(([p, label]) => (
                  <option key={p} value={p}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model ID
              <input
                required
                value={s.model}
                onChange={(e) => set("model", e.target.value)}
                placeholder="Vision-capable model"
              />
            </label>
            <label>
              Endpoint
              <input
                type="url"
                required
                value={s.endpoint}
                onChange={(e) => set("endpoint", e.target.value)}
              />
            </label>
            {s.provider !== "ollama" && (
              <>
                <label>
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      setTouched(true);
                    }}
                    placeholder={
                      storedKey ? "Stored securely" : "Your provider key"
                    }
                  />
                </label>
                <div className="field-pair">
                  <label>
                    Input $ / 1M tokens
                    <input
                      type="number"
                      min=".001"
                      step=".001"
                      value={s.inputPrice}
                      onChange={(e) =>
                        set("inputPrice", Number(e.target.value))
                      }
                    />
                  </label>
                  <label>
                    Output $ / 1M tokens
                    <input
                      type="number"
                      min=".001"
                      step=".001"
                      value={s.outputPrice}
                      onChange={(e) =>
                        set("outputPrice", Number(e.target.value))
                      }
                    />
                  </label>
                </div>
              </>
            )}
          </div>
        </details>
        <details className="setting-group">
          <summary>
            <span>
              Safety & limits<span>Ask before consequential actions</span>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="setting-fields">
            <p>
              App switching, Spotlight, search, and known text controls work
              automatically. Sending, purchases, deletion, account changes, and
              controls we cannot recognize still require approval. Passwords are
              yours to enter.
            </p>
            <label>
              Display
              <select
                value={s.displayId ?? ""}
                onChange={(e) =>
                  set(
                    "displayId",
                    e.target.value ? Number(e.target.value) : undefined,
                  )
                }
              >
                <option value="">Primary display</option>
                {info.displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.width} × {d.height}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-pair">
              <label>
                Action limit
                <input
                  aria-label="Action limit"
                  type="number"
                  min="1"
                  max="200"
                  value={s.maxActions}
                  onChange={(e) => set("maxActions", Number(e.target.value))}
                />
              </label>
              <label>
                Seconds
                <input
                  type="number"
                  min="10"
                  max="1800"
                  value={s.maxSeconds}
                  onChange={(e) => set("maxSeconds", Number(e.target.value))}
                />
              </label>
            </div>
            <label>
              Estimated cost cap ($)
              <input
                type="number"
                min=".01"
                max="50"
                step=".01"
                value={s.maxCost}
                onChange={(e) => set("maxCost", Number(e.target.value))}
              />
            </label>
            <label>
              Protected app IDs
              <textarea
                value={s.protectedApps.join("\n")}
                onChange={(e) =>
                  set(
                    "protectedApps",
                    e.target.value.split("\n").filter(Boolean),
                  )
                }
              />
            </label>
            <label>
              Protected domains
              <textarea
                value={s.protectedDomains.join("\n")}
                onChange={(e) =>
                  set(
                    "protectedDomains",
                    e.target.value.split("\n").filter(Boolean),
                  )
                }
              />
            </label>
          </div>
        </details>
        <details className="setting-group">
          <summary>
            <span>
              Contribution<span>Off until you choose a run</span>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="setting-fields">
            <p>
              Final commands and corrections can be reviewed after a run. Voice
              audio and partial transcripts are never saved. Real screenshots
              stay local in this alpha.
            </p>
            <label>
              Optional service endpoint
              <input
                type="url"
                value={s.contributionEndpoint}
                onChange={(e) => set("contributionEndpoint", e.target.value)}
                placeholder="http://127.0.0.1:4319"
              />
            </label>
            <button type="button" className="secondary" onClick={onReview}>
              Review local runs
              <ArrowRight size={13} />
            </button>
          </div>
        </details>
        <div className="save-row">
          <span>
            <LockKeyhole size={12} />
            {info.desktop
              ? "Encrypted on this device"
              : "Temporary preview settings"}
          </span>
          <button className="primary" disabled={busy} type="submit">
            {saved ? "Saved" : "Save"}
            <Check size={13} />
          </button>
        </div>
      </form>
      <div className="settings-footer">
        <button onClick={onTutorial}>
          <Play size={12} />
          Try the safe tutorial
        </button>
        <span>Stop instantly: ⌃ ⌥ esc</span>
      </div>
      <div className="setup-note">
        {s.handsFree
          ? "Local listening. No audio uploads or recordings."
          : "No always-on microphone. No background recording."}
        <br />A command, a little help, then out of your way.
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
