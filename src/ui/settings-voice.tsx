import React from "react";
import type { Settings } from "../core/schema";
import { kokoroVoices } from "../core/schema";

/**
 * The conversational part of the voice settings: whether free-form turns go
 * to the dialog model, which personality it writes in, what it calls the
 * user, spoken progress on long tasks, and the on-device voice pack. Mounted
 * from the Spoken replies group in main.tsx; everything else about the
 * voice engine (download, preview, rate) stays there.
 */
const personaOptions: { value: Settings["persona"]; label: string }[] = [
  { value: "jarvis", label: "JARVIS (composed, dry)" },
  { value: "friendly", label: "Friendly (warm)" },
];
const kokoroVoiceLabels: Record<Settings["kokoroVoice"], string> = {
  af_heart: "Heart (American, clearest)",
  bm_george: "George (British male)",
  bm_fable: "Fable (British male)",
};

/** What each autonomy choice means, under the picker. */
export function autonomyHint(
  autonomy: Settings["autonomy"],
  acknowledged = true,
): string {
  if (autonomy === "all" && !acknowledged)
    return "Tick the line below to turn this on. Until then, only steps you did not ask for wait for you, and money, sending, deleting, installing and account settings always do.";
  if (autonomy === "ask")
    return "Every consequential step waits for you: saving, replacing, sending, buying, deleting.";
  if (autonomy === "flow")
    return "Anything that can be undone just happens, and is reported. Money leaving, anything sent or published, deletions, installs and account settings still wait for you.";
  if (autonomy === "all")
    return "Nothing waits for you, including sending, buying, deleting and installing. Every step is still reported as it happens, one Escape still stops a run, and password managers, credential fields and protected websites are still refused outright.";
  return "A step you asked for that can be undone just happens (you said “save the draft”, so it saves). Anything else consequential waits for you, and so do money, sending, deleting, installing and account settings, always.";
}
/** The line beside the tick that turns "allow everything" on. */
export const AUTONOMY_ALL_ACKNOWLEDGEMENT =
  "I understand it can send, buy, delete and install without asking me.";
/**
 * "Allow everything" runs only while the acknowledgement stands (the policy
 * checks both fields; unticked, it asks as "only for what I did not ask for"
 * does). Picking it shows the acknowledgement to tick; picking another mode
 * drops the acknowledgement. Live 2026-09-18: snapping back to the old mode
 * until ticked hid the tick box, so the mode could never be chosen.
 */
export function autonomyChange(
  autonomy: Settings["autonomy"],
  acknowledged: boolean,
): Pick<Settings, "autonomy" | "autonomyAllAcknowledged"> {
  if (autonomy !== "all") return { autonomy, autonomyAllAcknowledged: false };
  return { autonomy: "all", autonomyAllAcknowledged: acknowledged };
}
/** What the "Talk naturally" hint says about where the words go. */
export function conversationHint(s: Settings): string {
  const model = s.dialogModel || s.model;
  if (s.privacy === "PRIVATE_LOCAL")
    return s.dialogModel
      ? `Replies are written on this Mac by ${model} through Ollama; nothing leaves it.`
      : "In local mode, set a text model below to talk naturally; the vision model stays on tasks.";
  return `Replies are written by ${model} · ${s.provider}. What you say is sent there, like a task.`;
}

/**
 * What the form sends for the OpenRouter key: nothing until the field was
 * touched (the vault keeps what it has), then the trimmed field, so an
 * emptied field reaches withJevKey as "" and clears the slot. Mirrors the
 * provider key's `touched` flag.
 */
export function jevKeyToSave(
  touched: boolean,
  typed: string,
): string | undefined {
  return touched ? typed.trim() : undefined;
}

/**
 * The key field's state: whether a key will be there after a save (the
 * toggle may be on only then), whether a stored key is being removed, and
 * the placeholder that says so. A stored key counts until the field is
 * changed; an emptied field over a stored key means removal on save.
 */
export function jevKeyField(o: {
  stored: boolean;
  touched: boolean;
  typed: string;
}): { ready: boolean; removing: boolean; placeholder: string } {
  const typed = o.typed.trim().length > 0;
  const removing = o.stored && o.touched && !typed;
  const ready = o.touched ? typed : o.stored;
  return {
    ready,
    removing,
    placeholder: removing
      ? "Removed when you save"
      : o.stored
        ? "Stored securely"
        : "Your OpenRouter key",
  };
}

/** What the decider sends, for every hint that can lead to turning it on. */
const JEV_SENDS =
  "It sends what you said, the recent conversation (including replies that read out notifications or on-screen results), the current or last task and its result, your agenda and open app names to OpenRouter and TypeSafe, with zero data retention requested; never screenshots.";

/** Whether the "Decide with Jev" toggle shows on, and whether it may change. */
export function jevToggle(
  s: Settings,
  keyReady: boolean,
): { checked: boolean; disabled: boolean } {
  const local = s.privacy === "PRIVATE_LOCAL";
  return {
    checked:
      !local &&
      keyReady &&
      s.decisions !== "off" &&
      (s.jevConsented || s.decisions === "jev"),
    // Turning it off is always allowed, so an off can be recorded ahead of
    // a key; turning it on needs somewhere for it to run.
    disabled: local && s.decisions === "off",
  };
}

/** The settings a click on the toggle writes: an explicit, remembered choice. */
export function jevToggleChange(
  checked: boolean,
): Pick<Settings, "decisions" | "decisionsChosen" | "jevConsented"> {
  return checked
    ? { decisions: "auto", decisionsChosen: true, jevConsented: true }
    : { decisions: "off", decisionsChosen: true, jevConsented: false };
}

/** The one-line privacy note under the "Decide with Jev" toggle. */
export function jevHint(s: Settings, keyReady: boolean): string {
  if (s.privacy === "PRIVATE_LOCAL")
    return "Not available in local mode: the conversation would leave this Mac.";
  if (s.decisions === "off")
    return keyReady
      ? `Off. Tick it to start clear commands the moment you finish speaking. ${JEV_SENDS}`
      : "Off. Add an OpenRouter API key below, then tick it to turn it on.";
  if (!keyReady)
    return `Add an OpenRouter API key below to turn this on. ${JEV_SENDS}`;
  if (!s.jevConsented && s.decisions !== "jev")
    return `An OpenRouter key is stored, but this stays off until you tick it. ${JEV_SENDS}`;
  return `On. ${JEV_SENDS} A confident “start” runs your words at once; anything else changes nothing.`;
}

export function VoiceSettings({
  s,
  set,
  ids,
  engine,
  jevKey = "",
  jevTouched = false,
  onJevKey,
  storedJevKey = false,
}: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  ids: string;
  engine: Settings["voiceEngine"];
  /** The OpenRouter key being typed; saved with the form, never shown back. */
  jevKey?: string;
  /** The key field was changed: what it holds, even nothing, is what saves. */
  jevTouched?: boolean;
  onJevKey?: (key: string) => void;
  /** An OpenRouter key is already in the vault. */
  storedJevKey?: boolean;
}) {
  const talking = s.conversation === "model";
  const local = s.privacy === "PRIVATE_LOCAL";
  const keyField = jevKeyField({
    stored: storedJevKey,
    touched: jevTouched,
    typed: jevKey,
  });
  const jevKeyReady = keyField.ready;
  const jevSwitch = jevToggle(s, jevKeyReady);
  return (
    <div className="voice-conversation">
      <label>
        Asking before it acts
        <select
          value={s.autonomy}
          aria-describedby={`${ids}-autonomy`}
          onChange={(e) => {
            const change = autonomyChange(
              e.target.value as Settings["autonomy"],
              s.autonomyAllAcknowledged,
            );
            set("autonomy", change.autonomy);
            set("autonomyAllAcknowledged", change.autonomyAllAcknowledged);
          }}
        >
          <option value="ask">Ask me every time</option>
          <option value="task">Only for what I did not ask for</option>
          <option value="flow">Only when it cannot be undone</option>
          <option value="all">Never ask, allow everything</option>
        </select>
      </label>
      {s.autonomy === "all" && (
        <label className="consent">
          <input
            type="checkbox"
            checked={s.autonomyAllAcknowledged}
            onChange={(e) => {
              const change = autonomyChange("all", e.target.checked);
              set("autonomy", change.autonomy);
              set("autonomyAllAcknowledged", change.autonomyAllAcknowledged);
            }}
          />
          <span>{AUTONOMY_ALL_ACKNOWLEDGEMENT}</span>
        </label>
      )}
      <p id={`${ids}-autonomy`} className="field-hint">
        {autonomyHint(s.autonomy, s.autonomyAllAcknowledged)}
      </p>
      <label className="consent">
        <input
          type="checkbox"
          checked={talking}
          aria-describedby={`${ids}-conversation`}
          onChange={(e) =>
            set("conversation", e.target.checked ? "model" : "off")
          }
        />
        <span>Talk naturally (questions, small talk, “want me to…?”)</span>
      </label>
      <p id={`${ids}-conversation`} className="field-hint">
        {talking
          ? conversationHint(s)
          : "Only tasks and the fixed replies. Nothing you say goes to a model unless it is a task."}
      </p>
      {talking && (
        <>
          <label>
            Text model for replies
            <input
              type="text"
              value={s.dialogModel}
              placeholder={
                s.privacy === "PRIVATE_LOCAL"
                  ? "e.g. qwen3:8b"
                  : `Same as tasks (${s.model})`
              }
              maxLength={100}
              aria-describedby={`${ids}-dialog-model`}
              onChange={(e) => set("dialogModel", e.target.value.trim())}
            />
          </label>
          <p id={`${ids}-dialog-model`} className="field-hint">
            A small, fast text model keeps replies under a second. Same provider
            and key as tasks.
          </p>
          <label>
            Personality
            <select
              value={s.persona}
              onChange={(e) =>
                set("persona", e.target.value as Settings["persona"])
              }
            >
              {personaOptions.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Call me
            <input
              type="text"
              value={s.addressAs}
              placeholder="Optional, e.g. Sir or Nitish"
              maxLength={40}
              aria-describedby={`${ids}-address`}
              onChange={(e) => set("addressAs", e.target.value)}
            />
          </label>
          <p id={`${ids}-address`} className="field-hint">
            Used now and then in replies. Letters only; never a command word.
          </p>
          <label className="consent">
            <input
              type="checkbox"
              checked={s.spokenProgress}
              onChange={(e) => set("spokenProgress", e.target.checked)}
            />
            <span>Spoken progress on long tasks</span>
          </label>
          <label className="consent">
            <input
              type="checkbox"
              checked={jevSwitch.checked}
              disabled={jevSwitch.disabled}
              aria-describedby={`${ids}-jev`}
              onChange={(e) => {
                // An explicit choice: a stored "off" is then the user's own.
                const change = jevToggleChange(e.target.checked);
                set("decisions", change.decisions);
                set("decisionsChosen", change.decisionsChosen);
                set("jevConsented", change.jevConsented);
              }}
            />
            <span>Decide with Jev (TypeSafe via OpenRouter)</span>
          </label>
          <p id={`${ids}-jev`} className="field-hint">
            {jevHint(s, jevKeyReady)}
          </p>
          {!local && (
            <>
              <label>
                OpenRouter API key
                <input
                  type="password"
                  autoComplete="off"
                  value={jevKey}
                  maxLength={1000}
                  placeholder={keyField.placeholder}
                  onChange={(e) => onJevKey?.(e.target.value)}
                />
              </label>
              {storedJevKey && !keyField.removing && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    // Empties the field (the save clears the vault slot) and
                    // records an explicit off, so a key imported later does
                    // not bring the decider back.
                    onJevKey?.("");
                    const change = jevToggleChange(false);
                    set("decisions", change.decisions);
                    set("decisionsChosen", change.decisionsChosen);
                    set("jevConsented", change.jevConsented);
                  }}
                >
                  Remove key
                </button>
              )}
            </>
          )}
        </>
      )}
      {engine === "kokoro" && (
        <>
          <label>
            Voice
            <select
              value={s.kokoroVoice}
              aria-describedby={`${ids}-kokoro-voice`}
              onChange={(e) =>
                set("kokoroVoice", e.target.value as Settings["kokoroVoice"])
              }
            >
              {kokoroVoices.map((v) => (
                <option key={v} value={v}>
                  {kokoroVoiceLabels[v]}
                </option>
              ))}
            </select>
          </label>
          <p id={`${ids}-kokoro-voice`} className="field-hint">
            {s.kokoroVoice === "af_heart"
              ? "The speaking rate above also applies to this voice."
              : "British voices are a small separate download; until it is installed, Heart speaks."}
          </p>
        </>
      )}
    </div>
  );
}
