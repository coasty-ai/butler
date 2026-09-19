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
export function jevKeyToSave(touched: boolean, typed: string): string | undefined {
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

/** The one-line privacy note under the "Decide with Jev" toggle. */
export function jevHint(s: Settings, keyReady: boolean): string {
  if (s.privacy === "PRIVATE_LOCAL")
    return "Not available in local mode: the conversation would leave this Mac.";
  if (!keyReady) return "Add an OpenRouter API key below to turn this on.";
  return "Sends what you said, the recent conversation, your agenda and open app names to OpenRouter and TypeSafe with zero data retention requested; never screen text. A confident “start” runs your words at once; anything else changes nothing.";
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
  const deciding = s.decisions === "jev" && !local;
  return (
    <div className="voice-conversation">
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
              checked={deciding}
              disabled={local || (!deciding && !jevKeyReady)}
              aria-describedby={`${ids}-jev`}
              onChange={(e) =>
                set(
                  "decisions",
                  e.target.checked && jevKeyReady ? "jev" : "off",
                )
              }
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
                    // Empties the field: the save then clears the vault
                    // slot, and the decider cannot stay on over it.
                    onJevKey?.("");
                    if (s.decisions === "jev") set("decisions", "off");
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
