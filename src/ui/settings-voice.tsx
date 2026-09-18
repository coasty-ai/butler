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

export function VoiceSettings({
  s,
  set,
  ids,
  engine,
}: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  ids: string;
  engine: Settings["voiceEngine"];
}) {
  const talking = s.conversation === "model";
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
