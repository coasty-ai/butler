import React, { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Command,
  Copy,
  Download,
  ExternalLink,
  Heart,
  Keyboard,
  LockKeyhole,
  MessageSquare,
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
import type {
  AppInfo,
  KokoroUiStatus,
  MemorySummary,
  MessagesInfo,
  OllamaStatus,
  PrivacyPane,
  ProviderKeyResult,
  ReviewData,
  SetupStatus,
  SetupStep,
  VoiceList,
  VoiceOption,
} from "./api";
import {
  firstTask,
  localModelSizes,
  permissionsReady,
  privacyPanePaths,
  resumeSetupAt,
  setupPermissions,
  setupSteps,
} from "./api";
import type { Settings, Run } from "../core/schema";
import { cloudVoices } from "../core/schema";
import {
  credentialScope,
  providerDefaults,
  selectProvider,
} from "../providers/catalog";
import { idlePill, type PillState } from "../voice/router";
import { previewBridge } from "./preview";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import "./motion.css";
const api = window.coarena ?? previewBridge();
const isPill = location.hash === "#pill",
  isSettings = location.hash === "#settings";
const task = "Move the card to Completed and add a completion note.";
/** Pill fields added for spoken replies; optional until main provides them. */
type VoicePillFields = Partial<{
  speaking: boolean;
  followUp: string;
  closing: boolean;
}>;
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
    [consent, setConsent] = useState(false),
    // First run keeps its place here, so closing the window and coming back
    // returns to the step that was open rather than to the beginning.
    [setupStep, setSetupStep] = useState<SetupStep>("welcome");
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
      // The desktop app pushes the authoritative pill for every failure (a
      // held run stays a paused card); never override it here, and never swap
      // an answerable approval card for an error card.
      if (isPill && !window.coarena)
        setPill((p) =>
          p.canApprove ? p : { ...p, phase: "error", label: message },
        );
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
        // "refresh" re-reads settings without leaving the current view.
        if (v !== "refresh") setView(v);
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
              view === "review"
                ? "Review local runs"
                : view === "setup"
                  ? "Set up Open Assist"
                  : "Open Assist settings"
            }
          >
            <div className="utility-heading">
              <div>
                <Mark />
                <b>
                  {view === "review"
                    ? "Your local runs"
                    : view === "setup"
                      ? "Set up Open Assist"
                      : "Open Assist"}
                </b>
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
                      never saved. Deleting a run also removes its task and
                      corrections from what Open Assist learned; learned
                      routines stay until you forget them in Settings.
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
            ) : view === "setup" && info ? (
              <SetupView
                info={info}
                pill={pill}
                busy={busy}
                step={setupStep}
                onStep={setSetupStep}
                onSave={(settings, key) =>
                  act(() => api.saveSettings(settings, key))
                }
                onTutorial={() => void act(() => api.start(task, true))}
                onReview={() => {
                  setView("review");
                  void act(async () => {});
                }}
                onFinish={() =>
                  void act(async () => {
                    await api.completeSetup();
                    setView("");
                  })
                }
              />
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
                onForgetMemory={() => act(() => api.forgetMemory())}
                onPreviewVoice={(voice) =>
                  act(async () => {
                    // Preview speaks the saved settings: save the voice
                    // choices first, leaving every other edit unsaved.
                    if (voice) await api.saveSettings(voice);
                    await api.previewVoice();
                  })
                }
                onOpenVoiceSettings={() =>
                  void act(() => api.openVoiceSettings())
                }
                onRemoveNaturalVoice={() => act(() => api.removeKokoro())}
                onSetup={() => setView("setup")}
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
  // Voice fields may not exist on PillState yet; read them defensively.
  const voice = state as PillState & VoicePillFields;
  const listening = state.phase === "listening",
    working = state.phase === "working",
    done = state.phase === "done",
    speaking = voice.speaking === true,
    followUp = !!voice.followUp,
    closing = listening && voice.closing === true;
  // A done pill that is speaking stays put; once speech ends it fades out
  // shortly after (main hides the window about 0.6 s after speech ends).
  const [spoke, setSpoke] = useState(false);
  useEffect(() => {
    if (!done) setSpoke(false);
    else if (speaking) setSpoke(true);
  }, [done, speaking]);
  useEffect(() => {
    if (state.phase === "text") {
      // A clarification or an unconfirmed hypothesis arrives prefilled.
      setText(state.transcript ?? "");
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [state.phase]);
  if (state.phase === "idle") return null;
  const classes = [
    "pill-stack",
    state.phase,
    speaking && "speaking",
    followUp && "follow-up",
    closing && "closing",
    done && speaking && "held",
    done && spoke && !speaking && "spoken",
  ].filter(Boolean);
  return (
    <div className={classes.join(" ")} role="status" aria-live="polite">
      <div className="status-pill">
        <span className="pill-orb">
          {closing && (
            <svg
              className="closing-ring"
              viewBox="0 0 36 36"
              aria-hidden="true"
            >
              <circle cx="18" cy="18" r="16.5" pathLength={100} />
            </svg>
          )}
          {done ? (
            <Check size={17} />
          ) : (
            <Core phase={state.phase} level={state.inputLevel} />
          )}
        </span>
        <div className="pill-copy">
          <b key={state.label} title={done ? state.label : undefined}>
            {state.label}
          </b>
          {state.synthetic && <span>Safe tutorial · simulated workspace</span>}
          {followUp && !listening && (
            <span className="visually-hidden">Listening for your reply.</span>
          )}
        </div>
        {speaking && !listening && (
          <span className="speaking-bars" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <i
                key={i}
                style={{ "--delay": `${i * -0.22}s` } as React.CSSProperties}
              />
            ))}
          </span>
        )}
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
      {(listening || working || state.phase === "paused") &&
        state.transcript && (
          <div className="transcript">{state.transcript}</div>
        )}
    </div>
  );
}
/** Saved on Preview so the sample uses the voice being chosen. */
const voiceKeys = [
  "voiceReplies",
  "voiceEngine",
  "voiceId",
  "cloudVoice",
  "voiceRate",
  "voiceSounds",
] as const satisfies readonly (keyof Settings)[];
function withVoice(base: Settings, edits: Settings): Settings {
  const next = { ...base };
  for (const k of voiceKeys) Object.assign(next, { [k]: edits[k] });
  return next;
}
const messageKeys = [
  "messages",
  "messagesHandle",
  "messagesCommands",
  "messagesUpdates",
] as const satisfies readonly (keyof Settings)[];
function withMessages(base: Settings, edits: Settings): Settings {
  const next = { ...base };
  for (const k of messageKeys) Object.assign(next, { [k]: edits[k] });
  return next;
}
const messagesFallback: MessagesInfo = {
  enabled: false,
  configured: false,
  commands: true,
  updates: "texted",
  automation: "unknown",
  database: "off",
  listening: false,
};
/** The plain-language setup step each macOS permission state needs. */
function messagesSetup(m: MessagesInfo): string {
  if (m.automation === "denied")
    return "macOS is blocking Open Assist from using Messages. Allow it in System Settings › Privacy & Security › Automation › Open Assist › Messages.";
  if (m.database === "no_access")
    return "To read your replies, Open Assist needs Full Disk Access in System Settings › Privacy & Security, then a restart of the app.";
  if (m.database === "locked")
    return "Leave the Messages app open: its database cannot be read while Messages is closed.";
  if (m.database === "missing")
    return "Open Messages and sign in to iMessage on this Mac first.";
  if (m.database === "unsupported")
    return "This macOS version stores messages differently, so replies cannot be read.";
  if (m.automation === "ask" || m.automation === "messages_closed")
    return "The first update will ask macOS for permission to use Messages. Allow it once.";
  return "";
}
const repliesHints: Record<Settings["voiceReplies"], string> = {
  off: "Replies stay on screen. Nothing is spoken.",
  voice: "Answers out loud when you speak to it. Typed tasks stay quiet.",
  always: "Also speaks results, questions and approvals for typed tasks.",
};
const patienceOptions: {
  value: Settings["listeningPatience"];
  label: string;
}[] = [
  { value: "quick", label: "Quick" },
  { value: "normal", label: "Normal" },
  { value: "relaxed", label: "Relaxed" },
];
const qualityRank: Record<string, number> = {
  premium: 2,
  enhanced: 1,
  default: 0,
};
/** Premium first, then Enhanced, then default; stable otherwise. */
function rankVoices(voices: VoiceOption[]): VoiceOption[] {
  return [...voices].sort(
    (a, b) => (qualityRank[b.quality] ?? 0) - (qualityRank[a.quality] ?? 0),
  );
}
function qualityLabel(quality: string): string {
  return quality === "premium"
    ? "Premium"
    : quality === "enhanced"
      ? "Enhanced"
      : "";
}
function voiceLabel(voice: VoiceOption, language: boolean): string {
  return [voice.name, language && voice.language, qualityLabel(voice.quality)]
    .filter(Boolean)
    .join(" · ");
}
function cloudVoiceLabel(voice: Settings["cloudVoice"]): string {
  const name = voice[0].toUpperCase() + voice.slice(1);
  return voice === "marin" || voice === "cedar"
    ? `${name} (most natural)`
    : name;
}
function rateText(rate: number): string {
  return Math.abs(rate - 1) < 0.001 ? "Normal" : `${Math.round(rate * 100)}%`;
}
/** Until main reports it (and in the browser preview): not available. */
const kokoroFallback: KokoroUiStatus = {
  supported: false,
  installed: false,
  downloading: false,
  progress: 0,
  bytes: 0,
  totalBytes: 0,
};
/** Size of the pinned download; status reports the exact total. */
const kokoroDownloadBytes = 332_071_387;
function megabytes(bytes: number): string {
  return `${Math.round(Math.max(0, bytes) / 1_000_000)} MB`;
}
/** Electron prefixes IPC rejections; keep only the app's own message. */
function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message
    .replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "")
    .trim();
}
/** One readable sentence per failure code from the natural voice. */
function kokoroErrorText(code: string, total: string): string {
  if (code === "network")
    return "Couldn’t reach the download server. Check your internet connection, then try again.";
  if (code === "checksum_mismatch" || code === "size_mismatch")
    return "A downloaded file didn’t match its expected checksum, so it was deleted. Try again.";
  if (code === "disk_full")
    return `Not enough free disk space for the ${total} download. Free up some space, then try again.`;
  if (code === "load_failed" || code === "worker_crashed")
    return "The natural voice couldn’t start, so your Mac voice spoke instead. Removing it and downloading it again may help.";
  const http = /^http_(\d+)$/.exec(code);
  if (http && Number(http[1]) > 0)
    return `The download server isn’t available right now (HTTP ${http[1]}). Try again later.`;
  return "The download stopped before it finished. Try again.";
}
function CurrentVoice({
  id,
  voice,
}: {
  id: string;
  voice?: { name: string; quality: string };
}) {
  if (!voice?.name) return null;
  const badge = qualityLabel(voice.quality);
  return (
    <p id={id} className="field-hint voice-current">
      Speaking with {voice.name}
      {badge && <span className="voice-badge">{badge}</span>}
    </p>
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
  onForgetMemory,
  onPreviewVoice,
  onOpenVoiceSettings,
  onRemoveNaturalVoice,
  onSetup,
}: {
  info: AppInfo;
  busy: boolean;
  onSave: (s: Settings, k?: string) => Promise<boolean>;
  onPermissions: () => void;
  onVoice: () => void;
  onRefresh: () => void;
  onTutorial: () => void;
  onReview: () => void;
  onForgetMemory: () => Promise<boolean>;
  /** Saves `voice` first when given, then plays the preview sample. */
  onPreviewVoice: (voice?: Settings) => Promise<boolean>;
  onOpenVoiceSettings: () => void;
  /** Deletes the natural voice; main switches a saved "kokoro" to "system". */
  onRemoveNaturalVoice: () => Promise<boolean>;
  /** Reopens first-run setup; it is reachable here and from the menu bar. */
  onSetup: () => void;
}) {
  const [s, setS] = useState<Settings>(info.settings),
    [key, setKey] = useState(""),
    [touched, setTouched] = useState(false),
    [saved, setSaved] = useState(false),
    [learned, setLearned] = useState<MemorySummary | null>(null),
    [forgetting, setForgetting] = useState(false),
    [voiceList, setVoiceList] = useState<VoiceList | null>(null),
    [kokoro, setKokoro] = useState<KokoroUiStatus>(
      info.voice.kokoro ?? kokoroFallback,
    ),
    // Chosen before it was installed: the saved engine stays put and the
    // download panel shows instead. Resumes a download already under way.
    [wantsKokoro, setWantsKokoro] = useState(
      info.voice.kokoro?.downloading === true &&
        info.settings.voiceEngine !== "kokoro",
    ),
    [requesting, setRequesting] = useState(false),
    [downloadError, setDownloadError] = useState(""),
    [confirmRemove, setConfirmRemove] = useState(false),
    [messages, setMessages] = useState<MessagesInfo>(
      info.messages ?? messagesFallback,
    ),
    [texting, setTexting] = useState(false),
    [textResult, setTextResult] = useState("");
  const cancelled = useRef(false),
    naturalPanel = useRef<HTMLDivElement>(null),
    lastNaturalMode = useRef("");
  const ids = useId();
  // Installed voices change when the user downloads one in System Settings,
  // so re-read them on refresh and whenever the window regains focus. A
  // failure only hides the list; it never replaces the settings error.
  useEffect(() => {
    let current = true;
    const load = () =>
      api
        .voices()
        .then((list) => current && setVoiceList(list))
        .catch(() => current && setVoiceList(null));
    load();
    window.addEventListener("focus", load);
    return () => {
      current = false;
      window.removeEventListener("focus", load);
    };
  }, [info]);
  // Re-read what was learned whenever the app state refreshes (after a run,
  // a save or forgetting).
  useEffect(() => {
    let current = true;
    api
      .memorySummary()
      .then((summary) => current && setLearned(summary))
      .catch(() => current && setLearned(null));
    return () => {
      current = false;
    };
  }, [info]);
  // Download progress arrives from main; a refresh re-reads it too.
  useEffect(() => {
    if (info.voice.kokoro) setKokoro(info.voice.kokoro);
  }, [info]);
  // Texting permissions can change in System Settings while this panel is
  // open; a failure only leaves the last state, never an error card.
  useEffect(() => {
    setMessages(info.messages ?? messagesFallback);
    if (!info.settings.messages) return;
    let current = true;
    api
      .messagesStatus()
      .then((status) => current && setMessages(status))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [info]);
  useEffect(() => api.subscribeKokoro(setKokoro), []);
  // Once the chosen natural voice is installed, select and save it, saving
  // only the voice fields the way Preview does.
  useEffect(() => {
    if (!wantsKokoro || !kokoro.installed || kokoro.downloading) return;
    setWantsKokoro(false);
    const next: Settings = { ...s, voiceEngine: "kokoro" };
    setS(next);
    void onSave(withVoice(info.settings, next));
  }, [wantsKokoro, kokoro.installed, kokoro.downloading]);
  const downloadNaturalVoice = async () => {
    cancelled.current = false;
    setDownloadError("");
    setConfirmRemove(false);
    setWantsKokoro(true);
    setRequesting(true);
    try {
      await api.downloadKokoro();
    } catch (e) {
      if (!cancelled.current)
        setDownloadError(
          readableError(e) ||
            "The download stopped before it finished. Try again.",
        );
    } finally {
      setRequesting(false);
      // The last progress push can race the reply; read the outcome once.
      api
        .kokoroStatus()
        .then(setKokoro)
        .catch(() => {});
    }
  };
  const cancelNaturalVoice = async () => {
    cancelled.current = true;
    try {
      await api.cancelKokoroDownload();
    } catch (e) {
      cancelled.current = false;
      setDownloadError(readableError(e) || "Couldn’t cancel. Try again.");
    }
  };
  const removeNaturalVoice = async () => {
    if (!(await onRemoveNaturalVoice())) return;
    setConfirmRemove(false);
    setWantsKokoro(false);
    setDownloadError("");
    setS((p) =>
      p.voiceEngine === "kokoro" ? { ...p, voiceEngine: "system" } : p,
    );
  };
  // The test text goes to the saved number, so the message settings are
  // saved first, exactly as previewing a voice saves the voice settings.
  const sendTestMessage = async () => {
    setTextResult("");
    setTexting(true);
    try {
      if (!(await onSave(withMessages(info.settings, s)))) return;
      await api.sendTestMessage();
      setTextResult("Sent. It should arrive on your phone in a moment.");
    } catch (e) {
      setTextResult(
        readableError(e) || "The test message could not be sent. Try again.",
      );
    } finally {
      setTexting(false);
      api
        .messagesStatus()
        .then(setMessages)
        .catch(() => {});
    }
  };
  // When the panel swaps its buttons (download, cancel, remove, confirm),
  // move the focus that was lost with them to the panel's first button.
  const naturalMode = kokoro.installed
    ? `installed-${confirmRemove}`
    : kokoro.downloading || requesting
      ? "downloading"
      : "idle";
  useEffect(() => {
    const previous = lastNaturalMode.current;
    lastNaturalMode.current = naturalMode;
    const panel = naturalPanel.current,
      active = document.activeElement;
    if (
      previous &&
      panel &&
      (active === document.body || panel.contains(active))
    )
      panel.querySelector<HTMLButtonElement>("button")?.focus();
  }, [naturalMode]);
  // Hands-free can change from the tray while this panel stays open.
  useEffect(
    () => setS((p) => ({ ...p, handsFree: info.settings.handsFree })),
    [info.settings.handsFree],
  );
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
  // Natural voice needs PRIVATE_BYOM plus a saved OpenAI key (main decides);
  // switching this form to a local model turns it off before saving.
  const cloudAllowed =
    (info.voice.cloudVoiceAllowed ?? voiceList?.cloudAllowed ?? false) ===
      true && s.privacy === "PRIVATE_BYOM";
  const voices = voiceList?.voices ?? [];
  // What the engine select shows; a natural voice still to download is not
  // saved as the engine.
  const engine: Settings["voiceEngine"] = wantsKokoro
    ? "kokoro"
    : s.voiceEngine;
  const cloud = engine === "openai",
    natural = engine === "kokoro",
    naturalReady = kokoro.supported && kokoro.installed,
    naturalDownloading = kokoro.downloading || requesting,
    showNaturalPanel = kokoro.supported && (natural || naturalDownloading);
  const naturalTotal = megabytes(kokoro.totalBytes || kokoroDownloadBytes);
  const naturalProgress = Math.round(
    Math.min(1, Math.max(0, kokoro.progress || 0)) * 100,
  );
  // A rejection that is only a failure code gets the same readable sentence.
  const naturalError =
    kokoro.error && kokoro.error !== "not_installed"
      ? kokoroErrorText(kokoro.error, naturalTotal)
      : /^[a-z]+(?:_[a-z0-9]+)*$/.test(downloadError)
        ? kokoroErrorText(downloadError, naturalTotal)
        : downloadError;
  const engineName =
    s.voiceEngine === "kokoro" && naturalReady
      ? "Natural voice (on-device)"
      : s.voiceEngine === "openai" && cloudAllowed
        ? "Natural voice (OpenAI)"
        : "Mac voice";
  const quality = voices.length
    ? rankVoices(voices)[0].quality
    : (info.voice.voiceQuality ?? "none");
  const showPremiumHint =
    s.voiceReplies !== "off" && engine === "system" && quality === "default";
  const selectedVoice = voices.find((v) => v.id === s.voiceId);
  const manyLanguages = new Set(voices.map((v) => v.language)).size > 1;
  const voiceChanged = voiceKeys.some((k) => s[k] !== info.settings[k]);
  const patience = patienceOptions.find((p) => p.value === s.listeningPatience);
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
            ? "Take your time. I wait while you think."
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
          <button className="setup-link" onClick={onSetup}>
            Set up Open Assist
            <ArrowRight size={11} />
          </button>
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
              ? "Keeps your microphone on to listen locally for ‘Hey Assist’. It waits while you think, then takes it from there. Turn it off anytime in the menu bar."
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
              Voice replies
              <span>
                {s.voiceReplies === "off"
                  ? "Replies stay on screen"
                  : `${
                      s.voiceReplies === "always"
                        ? "Speaks every reply"
                        : "Speaks when you talk to it"
                    } · ${engineName}`}
              </span>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="setting-fields">
            <p>
              Short and to the point: results, questions and approvals. Never
              passwords, typed text or full web addresses.
            </p>
            <label>
              Speak replies
              <select
                value={s.voiceReplies}
                aria-describedby={`${ids}-replies`}
                onChange={(e) =>
                  set(
                    "voiceReplies",
                    e.target.value as Settings["voiceReplies"],
                  )
                }
              >
                <option value="off">Off</option>
                <option value="voice">When I talk to it</option>
                <option value="always">Always</option>
              </select>
            </label>
            <p id={`${ids}-replies`} className="field-hint">
              {repliesHints[s.voiceReplies]}
            </p>
            {s.voiceReplies !== "off" && (
              <>
                <label>
                  Voice engine
                  <select
                    value={engine}
                    aria-describedby={`${ids}-engine`}
                    onChange={(e) => {
                      const next = e.target.value as Settings["voiceEngine"];
                      setDownloadError("");
                      setConfirmRemove(false);
                      if (next === "kokoro" && !naturalReady) {
                        setWantsKokoro(true);
                        return;
                      }
                      setWantsKokoro(false);
                      set("voiceEngine", next);
                    }}
                  >
                    <option value="system">Mac voice (free, on-device)</option>
                    <option value="kokoro" disabled={!kokoro.supported}>
                      {kokoro.supported
                        ? "Natural voice (free, on-device)"
                        : "Natural voice (free, on-device) · Apple Silicon only"}
                    </option>
                    <option value="openai" disabled={!cloudAllowed}>
                      Natural voice (OpenAI)
                    </option>
                  </select>
                </label>
                {natural ? (
                  naturalReady ? (
                    <p id={`${ids}-engine`} className="field-hint">
                      A natural voice that runs entirely on this Mac. If it
                      can’t start, your Mac voice speaks instead.
                    </p>
                  ) : kokoro.supported ? null : (
                    <p id={`${ids}-engine`} className="field-hint">
                      The free natural voice needs a Mac with Apple Silicon.
                      Your Mac voice speaks instead.
                    </p>
                  )
                ) : cloud && cloudAllowed ? (
                  <p id={`${ids}-engine`} className="voice-note" role="note">
                    Replies are sent to OpenAI and spoken by an AI-generated
                    voice, using your OpenAI key at about $0.015 per spoken
                    minute. If OpenAI can’t be reached, your Mac voice speaks
                    instead.
                  </p>
                ) : (
                  <p id={`${ids}-engine`} className="field-hint">
                    {cloud
                      ? "Natural voice (OpenAI) needs your own OpenAI key, saved under Intelligence. Until then, your Mac voice speaks."
                      : cloudAllowed
                        ? "Your Mac voice speaks on this Mac. Natural voice (OpenAI) sends replies to OpenAI."
                        : s.privacy === "PRIVATE_LOCAL"
                          ? "Replies are spoken on this Mac. Natural voice (OpenAI) needs your own OpenAI key, saved under Intelligence."
                          : "Natural voice (OpenAI) needs an OpenAI key, saved under Intelligence."}
                  </p>
                )}
                {showNaturalPanel && (
                  <div
                    ref={naturalPanel}
                    className="voice-note natural-voice"
                    role="group"
                    aria-label="Free natural voice"
                  >
                    {kokoro.installed ? (
                      <>
                        <p className="natural-status" role="status">
                          <CircleCheck size={13} aria-hidden="true" />
                          Natural voice installed
                        </p>
                        {confirmRemove ? (
                          <>
                            <p id={`${ids}-remove`}>
                              Remove the natural voice from this Mac? Replies
                              use your Mac voice until you download it again.
                            </p>
                            <div className="natural-actions">
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => setConfirmRemove(false)}
                              >
                                Keep
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                aria-describedby={`${ids}-remove`}
                                onClick={() => void removeNaturalVoice()}
                              >
                                <Trash2 size={13} />
                                Remove
                              </button>
                            </div>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => setConfirmRemove(true)}
                          >
                            <Trash2 size={13} />
                            {`Remove (${naturalTotal})`}
                          </button>
                        )}
                        {naturalError && kokoro.error && (
                          <p className="natural-error" role="alert">
                            <CircleAlert size={13} aria-hidden="true" />
                            {naturalError}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p id={natural ? `${ids}-engine` : undefined}>
                          A natural voice that runs entirely on this Mac.
                          One-time {naturalTotal} download from Hugging Face and
                          GitHub; nothing you say or type is sent.
                        </p>
                        {naturalDownloading ? (
                          <div className="download-progress">
                            <div
                              className="progress-track"
                              role="progressbar"
                              aria-label="Natural voice download"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={naturalProgress}
                              aria-valuetext={`${megabytes(kokoro.bytes)} of ${naturalTotal}`}
                            >
                              <span style={{ width: `${naturalProgress}%` }} />
                            </div>
                            <div className="download-row">
                              <span>
                                {megabytes(kokoro.bytes)} of {naturalTotal}
                              </span>
                              <button
                                type="button"
                                className="secondary"
                                aria-label="Cancel download"
                                onClick={() => void cancelNaturalVoice()}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {naturalError && (
                              <p className="natural-error" role="alert">
                                <CircleAlert size={13} aria-hidden="true" />
                                {naturalError}
                              </p>
                            )}
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => void downloadNaturalVoice()}
                            >
                              {naturalError ? (
                                <RotateCcw size={13} />
                              ) : (
                                <Download size={13} />
                              )}
                              {naturalError
                                ? "Retry"
                                : "Download natural voice"}
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
                {natural ? null : cloud ? (
                  <label>
                    Voice
                    <select
                      value={s.cloudVoice}
                      onChange={(e) =>
                        set(
                          "cloudVoice",
                          e.target.value as Settings["cloudVoice"],
                        )
                      }
                    >
                      {cloudVoices.map((v) => (
                        <option key={v} value={v}>
                          {cloudVoiceLabel(v)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <>
                    <label>
                      Voice
                      <select
                        value={s.voiceId}
                        aria-describedby={`${ids}-voice`}
                        onChange={(e) => set("voiceId", e.target.value)}
                      >
                        <option value="">Automatic (best installed)</option>
                        {s.voiceId && !selectedVoice && (
                          <option value={s.voiceId}>
                            {voiceList
                              ? "Chosen voice (not installed)"
                              : "Chosen voice"}
                          </option>
                        )}
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {voiceLabel(v, manyLanguages)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <CurrentVoice
                      id={`${ids}-voice`}
                      voice={
                        selectedVoice ??
                        (s.voiceId
                          ? undefined
                          : !info.settings.voiceId && info.voice.voiceName
                            ? {
                                name: info.voice.voiceName,
                                quality: info.voice.voiceQuality,
                              }
                            : rankVoices(voices)[0])
                      }
                    />
                    <div className="rate-field">
                      <label htmlFor={`${ids}-rate`}>Speaking rate</label>
                      <div className="rate-row">
                        <span aria-hidden="true">Slower</span>
                        <input
                          id={`${ids}-rate`}
                          type="range"
                          min={0.8}
                          max={1.4}
                          step={0.05}
                          value={s.voiceRate}
                          aria-valuetext={rateText(s.voiceRate)}
                          onChange={(e) =>
                            set(
                              "voiceRate",
                              Math.round(Number(e.target.value) * 100) / 100,
                            )
                          }
                        />
                        <span aria-hidden="true">Faster</span>
                        <output htmlFor={`${ids}-rate`}>
                          {rateText(s.voiceRate)}
                        </output>
                      </div>
                    </div>
                    {showPremiumHint && (
                      <div className="voice-note" role="note">
                        <p>
                          For a more natural voice, download a free Premium
                          voice: System Settings &gt; Accessibility &gt; Spoken
                          Content &gt; System Voice &gt; Manage Voices.
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={onOpenVoiceSettings}
                        >
                          Open Spoken Content
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    )}
                  </>
                )}
                {(!natural || naturalReady) && (
                  <div className="voice-preview">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-describedby={`${ids}-preview`}
                      onClick={() =>
                        void onPreviewVoice(
                          voiceChanged
                            ? withVoice(info.settings, s)
                            : undefined,
                        )
                      }
                    >
                      <Volume2 size={13} />
                      Preview
                    </button>
                    <span id={`${ids}-preview`}>
                      {voiceChanged
                        ? "Saves your voice choices, then plays a sample."
                        : "Plays a short sample."}
                    </span>
                  </div>
                )}
              </>
            )}
            <label className="consent">
              <input
                type="checkbox"
                checked={s.voiceSounds}
                onChange={(e) => set("voiceSounds", e.target.checked)}
              />
              <span>
                Play a soft sound when I start and stop listening (‘Hey Assist’
                only)
              </span>
            </label>
          </div>
        </details>
        <details className="setting-group">
          <summary>
            <span>
              Listening
              <span>
                {patience?.label ?? "Normal"} patience
                {s.handsFree &&
                  (s.followUpListening
                    ? " · Hears replies without ‘Hey Assist’"
                    : " · Wake phrase every time")}
              </span>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="setting-fields">
            <fieldset className="choice-field">
              <legend>Patience</legend>
              <div className="segmented">
                {patienceOptions.map((p) => (
                  <label
                    key={p.value}
                    className={
                      s.listeningPatience === p.value ? "selected" : undefined
                    }
                  >
                    <input
                      className="visually-hidden"
                      type="radio"
                      name={`${ids}-patience`}
                      value={p.value}
                      checked={s.listeningPatience === p.value}
                      aria-describedby={`${ids}-patience`}
                      onChange={() => set("listeningPatience", p.value)}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <p id={`${ids}-patience`}>
              How long I wait when you pause. Choose Relaxed if you think out
              loud.
              {!s.handsFree &&
                " This applies to ‘Hey Assist’. With Option + Space, I listen until you let go."}
            </p>
            {s.handsFree && (
              <>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={s.followUpListening}
                    aria-describedby={`${ids}-followup`}
                    onChange={(e) => set("followUpListening", e.target.checked)}
                  />
                  <span>Listen for your reply without “Hey Assist”</span>
                </label>
                <p id={`${ids}-followup`}>
                  After I ask something or you finish a sentence, I keep
                  listening for a few seconds, and the pill glows while I do.
                  Audio stays on this Mac and is never saved.
                </p>
              </>
            )}
          </div>
        </details>
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
                      min="0"
                      step="any"
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
                      min="0"
                      step="any"
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
              Text updates
              <span>
                {s.messages
                  ? s.messagesCommands
                    ? "Texts you · takes texted commands"
                    : "Texts you · no texted commands"
                  : "Off"}
              </span>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="setting-fields">
            <p>
              Open Assist can text one number — yours — when a task starts,
              needs you or finishes, and read short replies from that same
              number as commands. It never texts anyone else, never approves
              anything by text, and only reads messages that arrive after you
              turn this on.
            </p>
            <label className="consent">
              <input
                type="checkbox"
                checked={s.messages}
                onChange={(e) => set("messages", e.target.checked)}
              />
              <span>Send me updates by iMessage</span>
            </label>
            <label>
              Your number or iMessage address
              <input
                type="text"
                inputMode="tel"
                autoComplete="off"
                value={s.messagesHandle}
                onChange={(e) => set("messagesHandle", e.target.value)}
                placeholder="+1 555 123 4567"
                aria-describedby={`${ids}-messages-handle`}
              />
            </label>
            <p id={`${ids}-messages-handle`}>
              Stored encrypted on this Mac. It must be a number or address that
              is not signed in to Messages on this Mac, so your own texts can be
              told apart from the ones Open Assist sends.
            </p>
            <label>
              What gets sent
              <select
                value={s.messagesUpdates}
                onChange={(e) =>
                  set(
                    "messagesUpdates",
                    e.target.value as Settings["messagesUpdates"],
                  )
                }
              >
                <option value="texted">Only tasks I start by text</option>
                <option value="all">Every task, however it started</option>
              </select>
            </label>
            <p>
              One short line per moment: started, needs your approval, paused,
              finished, failed. Never screenshots, typed text or transcripts.
            </p>
            <label className="consent">
              <input
                type="checkbox"
                checked={s.messagesCommands}
                aria-describedby={`${ids}-messages-commands`}
                onChange={(e) => set("messagesCommands", e.target.checked)}
              />
              <span>Let me start and stop tasks by text</span>
            </label>
            <p id={`${ids}-messages-commands`}>
              From your number only: <b>status</b>, <b>stop</b>, <b>pause</b>,{" "}
              <b>continue</b>, or <b>do</b> followed by a task. Anything else
              gets one line explaining those words. A task you text starts on
              this Mac like any other, and anything consequential still waits
              for your approval here.
            </p>
            <p>
              macOS asks for two permissions: Automation for the Messages app
              (to send), and Full Disk Access (to read your replies). Turn off
              “start and stop tasks by text” if you would rather not grant Full
              Disk Access.
            </p>
            {s.messages && messagesSetup(messages) && (
              <p role="status">{messagesSetup(messages)}</p>
            )}
            <button
              type="button"
              className="secondary"
              disabled={
                busy || texting || !s.messages || !s.messagesHandle.trim()
              }
              onClick={sendTestMessage}
            >
              <MessageSquare size={13} />
              {texting ? "Sending…" : "Send a test message"}
            </button>
            {textResult && <p role="status">{textResult}</p>}
            {messages.error && <p role="alert">{messages.error}</p>}
          </div>
        </details>
        <details className="setting-group">
          <summary>
            <span>
              Learning
              <span>
                {s.memory ? "Learns on this Mac" : "Not learning new tasks"}
              </span>
            </span>
            <ChevronDown size={15} />
          </summary>
          <div className="setting-fields">
            <p>
              Open Assist remembers how your tasks went, your corrections and
              the apps you use, so repeated tasks get faster. It knows where
              apps and files are from macOS metadata, never file contents.
              Everything stays encrypted on this Mac; only a few relevant notes
              go to your model with a task. The safe tutorial is never learned.
            </p>
            <label className="consent">
              <input
                type="checkbox"
                checked={s.memory}
                onChange={(e) => set("memory", e.target.checked)}
              />
              <span>Learn from my tasks</span>
            </label>
            {learned && (
              <p role="status">
                {learned.counts.episodes} tasks · {learned.counts.preferences}{" "}
                preferences · {learned.counts.skills} learned routines ·{" "}
                {learned.counts.apps} apps
              </p>
            )}
            {!!learned?.preferences.length && (
              <div className="correction-note">
                <b>Preferences</b>
                <ul>
                  {learned.preferences.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              </div>
            )}
            {!!learned?.skills.length && (
              <div className="correction-note">
                <b>Routines</b>
                <ul>
                  {learned.skills.map((trigger, i) => (
                    <li key={i}>{trigger}</li>
                  ))}
                </ul>
              </div>
            )}
            {forgetting ? (
              <div className="field-pair">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setForgetting(false)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={async () => {
                    if (await onForgetMemory()) setForgetting(false);
                  }}
                >
                  <Trash2 size={13} />
                  Forget everything
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={
                  busy ||
                  !learned ||
                  !Object.values(learned.counts).some((n) => n > 0)
                }
                onClick={() => setForgetting(true)}
              >
                <Trash2 size={13} />
                Forget what Open Assist learned
              </button>
            )}
            {forgetting && (
              <p role="alert">
                This deletes learned tasks, preferences and routines from this
                Mac. Local run history is kept.
              </p>
            )}
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
/** Step titles for the rail; the order is `setupSteps`. */
const setupTitles: Record<SetupStep, string> = {
  welcome: "Welcome",
  permissions: "Permissions",
  model: "Model",
  voice: "Voice",
  task: "First task",
  done: "Done",
};
/** Until the first poll answers: nothing is granted and nothing is claimed. */
const setupUnknown: SetupStatus = {
  supported: false,
  screen: false,
  screenNeedsRelaunch: false,
  accessibility: false,
  microphone: false,
  speech: false,
  onDevice: false,
  locale: "",
  shortcut: false,
  model: { kind: "none", ready: false, detail: "" },
  kokoro: { ...kokoroFallback },
  complete: false,
};
/** The three states a permission row can honestly be in. */
function permissionState(
  status: SetupStatus,
  pane: PrivacyPane,
): "granted" | "relaunch" | "missing" {
  if (pane === "screen")
    return status.screenNeedsRelaunch
      ? "relaunch"
      : status.screen
        ? "granted"
        : "missing";
  const granted =
    pane === "accessibility"
      ? status.accessibility
      : pane === "microphone"
        ? status.microphone
        : status.speech;
  return granted ? "granted" : "missing";
}
function PermissionRow({
  pane,
  title,
  reason,
  state,
  busy,
  onOpen,
  onRelaunch,
}: {
  pane: PrivacyPane;
  title: string;
  reason: string;
  state: "granted" | "relaunch" | "missing";
  busy: boolean;
  onOpen: () => void;
  onRelaunch: () => void;
}) {
  return (
    <div className={`setup-permission ${state}`}>
      <div className="setup-permission-head">
        <b>{title}</b>
        <span className="setup-chip" role="status">
          {state === "granted" ? (
            <>
              <Check size={11} aria-hidden="true" />
              Granted
            </>
          ) : state === "relaunch" ? (
            "Granted, restart needed"
          ) : (
            "Not granted"
          )}
        </span>
      </div>
      <p>{reason}</p>
      {state === "relaunch" ? (
        <>
          <p className="setup-warning">
            macOS applies this only after a restart.
          </p>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={onRelaunch}
          >
            <RotateCcw size={12} />
            Quit and reopen
          </button>
        </>
      ) : state === "missing" ? (
        <>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onOpen}
          >
            <ExternalLink size={12} />
            Open {title}
          </button>
          <p className="setup-path">
            System Settings › {privacyPanePaths[pane]}
          </p>
        </>
      ) : null}
    </div>
  );
}
/**
 * First run, end to end (docs/MODULARITY.md §6). Six steps on the existing
 * `view` channel, every one of them skippable and the whole thing resumable:
 * closing the window leaves setup pending, and the next launch comes back to
 * the first step that is not done yet. It is not a modal trap.
 */
function SetupView({
  info,
  pill,
  busy,
  step,
  onStep,
  onSave,
  onTutorial,
  onReview,
  onFinish,
}: {
  info: AppInfo;
  pill: PillState;
  busy: boolean;
  step: SetupStep;
  onStep: (step: SetupStep) => void;
  onSave: (s: Settings, k?: string) => Promise<boolean>;
  onTutorial: () => void;
  onReview: () => void;
  /** Marks setup complete and leaves the view. */
  onFinish: () => void;
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null),
    [problem, setProblem] = useState(""),
    [asking, setAsking] = useState(false),
    [ollama, setOllama] = useState<OllamaStatus | null>(null),
    [probing, setProbing] = useState(false),
    [copied, setCopied] = useState(false),
    [form, setForm] = useState<Settings>(() =>
      info.settings.provider === "ollama"
        ? selectProvider(info.settings, "openai")
        : info.settings,
    ),
    [key, setKey] = useState(""),
    [checking, setChecking] = useState(false),
    [keyResult, setKeyResult] = useState<ProviderKeyResult | null>(null),
    [kokoro, setKokoro] = useState<KokoroUiStatus>(
      info.voice.kokoro ?? kokoroFallback,
    ),
    [downloading, setDownloading] = useState(false),
    [downloadError, setDownloadError] = useState(""),
    [started, setStarted] = useState(false);
  const ids = useId();
  const resumed = useRef(false),
    cancelled = useRef(false);
  const live = status ?? setupUnknown;
  // Polled every 2 s while this view is visible, and again whenever the window
  // comes forward: OS permission state changes outside the app, so a snapshot
  // taken once is wrong within seconds. A hidden window polls nothing, and
  // leaving the view unmounts this effect.
  useEffect(() => {
    let current = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      api
        .setupStatus()
        .then((s) => current && setStatus(s))
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, 2000);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);
  // Resume where setup was left: a relaunch to apply Screen Recording comes
  // back to the checklist, not to a welcome screen that was already read.
  useEffect(() => {
    if (!status || resumed.current) return;
    resumed.current = true;
    if (step === "welcome") onStep(resumeSetupAt(status));
  }, [status]);
  useEffect(() => api.subscribeKokoro(setKokoro), []);
  useEffect(() => {
    if (info.voice.kokoro) setKokoro(info.voice.kokoro);
  }, [info]);
  // The local model list, read through the same PRIVATE_LOCAL rule the run
  // loop uses. Only on the model step, and only for a local setup.
  useEffect(() => {
    if (step !== "model") return;
    let current = true;
    setProbing(true);
    api
      .detectOllama()
      .then((s) => current && setOllama(s))
      .catch(() => current && setOllama({ running: false, models: [] }))
      .finally(() => current && setProbing(false));
    return () => {
      current = false;
    };
  }, [step]);
  const attempt = async (fn: () => Promise<unknown>) => {
    setProblem("");
    try {
      await fn();
      return true;
    } catch (e) {
      setProblem(readableError(e) || "Try again.");
      return false;
    }
  };
  const openPane = (pane: PrivacyPane) =>
    void attempt(() => api.openPrivacyPane(pane));
  // The macOS prompts are what put Open Assist in those lists in the first
  // place; the deep links only take the user to the switch.
  const askMacOS = async () => {
    setAsking(true);
    setProblem("");
    const failures: unknown[] = [];
    try {
      await api.permissions().catch((e) => failures.push(e));
      await api.voicePermissions().catch((e) => failures.push(e));
      setStatus(await api.setupStatus());
    } catch (e) {
      failures.push(e);
    } finally {
      setAsking(false);
    }
    // Both prompts are optional: one failing helper must not hide the other.
    if (failures.length)
      setProblem(
        readableError(failures[0]) ||
          "macOS did not answer. Open the pane below instead.",
      );
  };
  const localModel = providerDefaults.ollama.model;
  const localSize = localModelSizes[localModel] ?? "a few GB";
  const smallModel = "qwen3-vl:2b";
  const installed = !!ollama?.models.includes(localModel);
  const copyPull = async () => {
    try {
      await navigator.clipboard.writeText(`ollama pull ${localModel}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setProblem(`Copying failed. Type it yourself: ollama pull ${localModel}`);
    }
  };
  const useLocalModel = () =>
    void attempt(async () => {
      const next = { ...selectProvider(form, "ollama"), model: localModel };
      if (await onSave(next)) {
        setForm(next);
        setKeyResult(null);
        onStep("voice");
      }
    });
  // Checks the key with one cheap request, then saves it the same encrypted
  // way Settings does. Nothing here captures or drives the desktop.
  const checkKey = async () => {
    setChecking(true);
    setProblem("");
    setKeyResult(null);
    try {
      const result = await api.checkProviderKey(form, key || undefined);
      setKeyResult(result);
      if (result.ok && (await onSave(form, key || undefined))) setKey("");
    } catch (e) {
      setKeyResult({
        ok: false,
        message: readableError(e) || "The key could not be checked. Try again.",
      });
    } finally {
      setChecking(false);
    }
  };
  const naturalTotal = megabytes(kokoro.totalBytes || kokoroDownloadBytes);
  const naturalProgress = Math.round(
    Math.min(1, Math.max(0, kokoro.progress || 0)) * 100,
  );
  const naturalError =
    kokoro.error && kokoro.error !== "not_installed"
      ? kokoroErrorText(kokoro.error, naturalTotal)
      : /^[a-z]+(?:_[a-z0-9]+)*$/.test(downloadError)
        ? kokoroErrorText(downloadError, naturalTotal)
        : downloadError;
  const downloadVoice = async () => {
    cancelled.current = false;
    setDownloadError("");
    setDownloading(true);
    try {
      await api.downloadKokoro();
      await onSave({ ...info.settings, voiceEngine: "kokoro" });
    } catch (e) {
      if (!cancelled.current)
        setDownloadError(
          readableError(e) ||
            "The download stopped before it finished. Try again.",
        );
    } finally {
      setDownloading(false);
      api
        .kokoroStatus()
        .then(setKokoro)
        .catch(() => {});
    }
  };
  const cancelVoice = () =>
    void attempt(async () => {
      cancelled.current = true;
      await api.cancelKokoroDownload();
    });
  const ready = permissionsReady(live);
  const runFirstTask = () =>
    void attempt(async () => {
      setStarted(true);
      await api.command(firstTask);
    });
  const settled = started && ["done", "error", "idle"].includes(pill.phase);
  const index = setupSteps.indexOf(step);
  const go = (delta: number) =>
    onStep(
      setupSteps[Math.min(setupSteps.length - 1, Math.max(0, index + delta))],
    );
  return (
    <div className="setup-view">
      <ol className="setup-rail" aria-label="Setup progress">
        {setupSteps.map((s, i) => (
          <li
            key={s}
            className={i === index ? "current" : i < index ? "past" : ""}
          >
            <button
              type="button"
              aria-current={i === index ? "step" : undefined}
              onClick={() => onStep(s)}
            >
              {setupTitles[s]}
            </button>
          </li>
        ))}
      </ol>
      {problem && (
        <p className="setup-problem" role="alert">
          <CircleAlert size={12} aria-hidden="true" />
          {problem}
        </p>
      )}
      {step === "welcome" && (
        <section className="setup-step" aria-labelledby={`${ids}-welcome`}>
          <div className="setup-keys">
            <kbd>⌥</kbd>
            <kbd>space</kbd>
          </div>
          <h1 id={`${ids}-welcome`}>
            Press a key. Tell your computer what to do.
          </h1>
          <p>
            It clicks, types, searches and works across the apps you already
            use. Hold ⌥ Space to talk, release to get it done.
          </p>
          <div className="sample-command">
            <span>“</span>Find the latest report and email it to Lawrence.
            <br />
            <span className="sample-second">
              Let me approve before sending.
            </span>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => onStep("permissions")}
          >
            Set up Open Assist
            <ArrowRight size={13} />
          </button>
          <p className="setup-hint">
            About two minutes. You can stop after any step.
          </p>
          <button type="button" className="secondary" onClick={onTutorial}>
            <Play size={12} />
            Try the safe tutorial first
          </button>
          <p className="setup-hint">
            Simulated workspace. No permissions, no model, no microphone.
          </p>
        </section>
      )}
      {step === "permissions" && (
        <section className="setup-step" aria-labelledby={`${ids}-permissions`}>
          <h1 id={`${ids}-permissions`}>Four permissions</h1>
          <p>
            Open Assist needs these to see your screen and use the keyboard and
            mouse. macOS asks for each one; you grant it in System Settings.
            Nothing is captured until you start a task, and moving the mouse
            pauses it.
          </p>
          <button
            type="button"
            className="primary"
            disabled={asking || busy}
            onClick={() => void askMacOS()}
          >
            <ShieldCheck size={13} />
            {asking ? "Asking macOS…" : "Ask macOS for these"}
          </button>
          <div className="setup-permissions">
            {setupPermissions.map((p) => (
              <PermissionRow
                key={p.pane}
                pane={p.pane}
                title={p.title}
                reason={p.reason}
                state={permissionState(live, p.pane)}
                busy={busy}
                onOpen={() => openPane(p.pane)}
                onRelaunch={() => void attempt(() => api.relaunch())}
              />
            ))}
          </div>
          {!live.onDevice && (
            <p className="setup-warning" role="status">
              This Mac has no on-device speech model for{" "}
              {live.locale || "your language"}. Open Assist will not transcribe.
              Typed commands still work: tap ⌥ Space instead of holding it.
            </p>
          )}
          {!live.supported && (
            <p className="setup-warning" role="status">
              Desktop control needs macOS 14 or later. The safe tutorial still
              runs.
            </p>
          )}
          <p className="setup-hint">
            Rechecked every couple of seconds and whenever this window comes
            forward.
          </p>
        </section>
      )}
      {step === "model" && (
        <section className="setup-step" aria-labelledby={`${ids}-model`}>
          <h1 id={`${ids}-model`}>Choose a model</h1>
          <p>
            Open Assist sends a screenshot of your screen and your task to one
            model you choose. It has no server of its own in between.
          </p>
          <div className="setup-card">
            <h3>On this Mac — free, nothing leaves the Mac</h3>
            {probing && !ollama ? (
              <p>Looking for Ollama on this Mac…</p>
            ) : !ollama?.running ? (
              <p>
                Ollama is not running. Download it from <b>ollama.com</b>, open
                it once, then come back to this screen.
              </p>
            ) : installed ? (
              <>
                <p className="setup-ok">
                  <CircleCheck size={13} aria-hidden="true" />
                  <code>{localModel}</code> is installed.
                </p>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={useLocalModel}
                >
                  Use it
                </button>
              </>
            ) : (
              <>
                <p>
                  Ollama is running at <code>127.0.0.1:11434</code>.{" "}
                  <code>{localModel}</code> is not installed yet. Run this in
                  Terminal:
                </p>
                <pre>ollama pull {localModel}</pre>
                <div className="setup-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void copyPull()}
                  >
                    <Copy size={12} />
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <span>{localSize} to download; it stays on this Mac.</span>
                </div>
                <p className="setup-hint">
                  On a Mac with 16 GB of memory,{" "}
                  <code>ollama pull {smallModel}</code> (
                  {localModelSizes[smallModel]}) is faster and less accurate.
                </p>
              </>
            )}
            <button
              type="button"
              className="setup-link"
              disabled={probing}
              onClick={() => {
                setProbing(true);
                api
                  .detectOllama()
                  .then(setOllama)
                  .catch(() => setOllama({ running: false, models: [] }))
                  .finally(() => setProbing(false));
              }}
            >
              <RotateCcw size={11} />
              {probing ? "Checking…" : "Check again"}
            </button>
          </div>
          <div className="setup-card">
            <h3>Your own API key</h3>
            <p>
              Requests go straight to the provider you choose. Choose OpenAI,
              Anthropic, Google, or an OpenAI-compatible endpoint. The model
              must accept images and function calls.
            </p>
            <label>
              Provider
              <select
                value={form.provider === "ollama" ? "openai" : form.provider}
                onChange={(e) => {
                  setForm(
                    selectProvider(
                      form,
                      e.target.value as Settings["provider"],
                    ),
                  );
                  setKey("");
                  setKeyResult(null);
                }}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google Gemini</option>
                <option value="compatible">Custom compatible</option>
              </select>
            </label>
            <label>
              Model ID
              <input
                required
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="Vision-capable model"
              />
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setKeyResult(null);
                }}
                placeholder="Your provider key"
              />
            </label>
            <div className="field-pair">
              <label>
                Input $ / 1M tokens
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.inputPrice}
                  onChange={(e) =>
                    setForm({ ...form, inputPrice: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Output $ / 1M tokens
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.outputPrice}
                  onChange={(e) =>
                    setForm({ ...form, outputPrice: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="setup-actions">
              <button
                type="button"
                className="primary"
                disabled={checking || busy || !form.model.trim()}
                onClick={() => void checkKey()}
              >
                {checking ? "Checking…" : "Check key"}
              </button>
              <span>
                Checks the key with one small request, then saves it encrypted
                on this Mac.
              </span>
            </div>
            {keyResult && (
              <p
                className={keyResult.ok ? "setup-ok" : "setup-warning"}
                role="status"
              >
                {keyResult.ok ? (
                  <CircleCheck size={13} aria-hidden="true" />
                ) : (
                  <CircleAlert size={13} aria-hidden="true" />
                )}
                {keyResult.message}
              </p>
            )}
          </div>
        </section>
      )}
      {step === "voice" && (
        <section className="setup-step" aria-labelledby={`${ids}-voice`}>
          <h1 id={`${ids}-voice`}>Spoken replies</h1>
          <p>
            Open Assist answers out loud when you talk to it. The built-in Mac
            voice works now. A free natural voice runs entirely on this Mac
            after a one-time download.
          </p>
          <div className="setup-card">
            {!kokoro.supported ? (
              <p className="setup-warning">
                This Mac keeps the built-in voice; the natural voice needs Apple
                Silicon.
              </p>
            ) : kokoro.installed ? (
              <>
                <p className="setup-ok">
                  <CircleCheck size={13} aria-hidden="true" />
                  Installed.
                </p>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void attempt(() => api.previewVoice())}
                >
                  <Volume2 size={12} />
                  Hear it
                </button>
              </>
            ) : kokoro.downloading || downloading ? (
              <div className="download-progress">
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Natural voice download"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={naturalProgress}
                  aria-valuetext={`${megabytes(kokoro.bytes)} of ${naturalTotal}`}
                >
                  <span style={{ width: `${naturalProgress}%` }} />
                </div>
                <div className="download-row">
                  <span>
                    {megabytes(kokoro.bytes)} of {naturalTotal}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    aria-label="Cancel download"
                    onClick={cancelVoice}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p>
                  <b>Natural voice — {naturalTotal}.</b> Apple Silicon only. No
                  account, no network use after the download.
                </p>
                {naturalError && (
                  <p className="setup-warning" role="alert">
                    <CircleAlert size={13} aria-hidden="true" />
                    {naturalError}
                  </p>
                )}
                <button
                  type="button"
                  className="primary"
                  onClick={() => void downloadVoice()}
                >
                  {naturalError ? (
                    <RotateCcw size={12} />
                  ) : (
                    <Download size={12} />
                  )}
                  {naturalError ? "Retry" : "Download"}
                </button>
              </>
            )}
          </div>
          <p className="setup-hint">
            Optional. You can turn this on later in Settings → Voice replies.
          </p>
        </section>
      )}
      {step === "task" && (
        <section className="setup-step" aria-labelledby={`${ids}-task`}>
          <h1 id={`${ids}-task`}>Try it</h1>
          {ready ? (
            <>
              <p>
                Hold <b>⌥ Space</b> and say:
              </p>
              <div className="sample-command">
                <span>“</span>
                {firstTask}
              </div>
              <p>
                Release when you finish talking. Watch the pill:{" "}
                <b>Listening → Working → Done</b>. Press <b>Escape</b> to stop
                at any time, or move the mouse to pause.
              </p>
              <div className="setup-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={runFirstTask}
                >
                  <Play size={12} />
                  Run it for me
                </button>
                <span>
                  Starts the same task typed, for anyone who would rather not
                  talk yet.
                </span>
              </div>
              {started && (
                <p className="setup-hint" role="status">
                  {settled
                    ? "Done. That run is in your history — open it to see every step it took."
                    : `${pill.label || "Working…"}`}
                </p>
              )}
              {settled && (
                <button type="button" className="secondary" onClick={onReview}>
                  Open your runs
                  <ArrowRight size={12} />
                </button>
              )}
            </>
          ) : (
            <>
              <p className="setup-warning">
                Permissions are still missing, so this would not work yet.
              </p>
              <div className="setup-actions">
                <button type="button" className="primary" onClick={onTutorial}>
                  <Play size={12} />
                  Try the safe tutorial
                </button>
                <span>A simulated board, no permissions and no model.</span>
              </div>
              <button
                type="button"
                className="setup-link"
                onClick={() => onStep("permissions")}
              >
                Back to the permission checklist
              </button>
            </>
          )}
        </section>
      )}
      {step === "done" && (
        <section className="setup-step" aria-labelledby={`${ids}-done`}>
          <h1 id={`${ids}-done`}>You are set up.</h1>
          <p>
            Hold <b>⌥ Space</b> anywhere to talk, tap it to type.{" "}
            <b>⌃ ⌥ Escape</b> stops everything.
          </p>
          <p>
            Everything else — hands-free listening, text updates, what it learns
            — is in the menu bar.
          </p>
          {live.model.detail && (
            <p className="setup-hint" role="status">
              {live.model.detail}
            </p>
          )}
          <button type="button" className="primary" onClick={onFinish}>
            <Check size={13} />
            Finish
          </button>
        </section>
      )}
      <div className="setup-footer">
        <button
          type="button"
          className="setup-link"
          disabled={index === 0}
          onClick={() => go(-1)}
        >
          Back
        </button>
        <span>
          Step {index + 1} of {setupSteps.length}
        </span>
        {step === "done" ? (
          <button type="button" className="setup-link" onClick={onFinish}>
            Finish
          </button>
        ) : (
          <button type="button" className="setup-link" onClick={() => go(1)}>
            {step === "permissions" ? "Skip for now" : "Skip"}
            <ArrowRight size={11} />
          </button>
        )}
      </div>
      <p className="setup-note">
        You can stop after any step. Setup reopens from the menu bar and from
        Settings.
        <br />
        <button type="button" className="setup-link" onClick={onFinish}>
          Skip the rest — don’t show this again
        </button>
      </p>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
