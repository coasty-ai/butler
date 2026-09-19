/**
 * Settings › Phone remote. The on/off switch, port and screenshot choice are
 * ordinary settings saved with the form; allowing a phone is consent and is
 * applied the moment it is ticked, through its own bridge call, so the list
 * shown is always the list in force. Nothing here ever shows a token, a
 * login other than the user's own, or anything a phone sent.
 */
import React, { useEffect, useState } from "react";
import type { Settings } from "../core/schema";
import type { Bridge, RemoteStatus } from "./api";

const POLL_MS = 15_000;

const ago = (at: number, now: number) => {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
};

const readable = (error: unknown) =>
  (error instanceof Error ? error.message : "")
    .replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "")
    .trim();

/** The one-line summary the collapsed group shows. */
function summary(s: Settings, status: RemoteStatus | null): string {
  if (!s.remoteEnabled) return "Off";
  if (!status) return "On";
  if (status.state === "on")
    return `On · ${status.devices.filter((d) => d.control).length} phone${
      status.devices.filter((d) => d.control).length === 1 ? "" : "s"
    } allowed`;
  return status.state === "error" ? "Not running" : "Waiting for Tailscale";
}

function statusLine(status: RemoteStatus | null, enabled: boolean): string {
  if (!enabled) return "";
  if (!status) return "Checking Tailscale…";
  if (status.state === "on" && status.url)
    return `Connected${status.user ? ` as ${status.user}` : ""} · ${status.url}`;
  return status.reason ?? "Waiting for Tailscale.";
}

export function SettingsRemote({
  s,
  set,
  api,
  busy,
  refreshKey,
}: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  api: Bridge;
  busy: boolean;
  /** Changes whenever the app state refreshed (a save, a run). */
  refreshKey: unknown;
}) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const now = Date.now();
  // Tailscale can come and go while this panel is open; a failure keeps the
  // last state and never replaces the settings error.
  useEffect(() => {
    let current = true;
    const load = () =>
      api
        .remoteStatus()
        .then((next) => current && setStatus(next))
        .catch(() => {});
    load();
    const timer = s.remoteEnabled ? setInterval(load, POLL_MS) : undefined;
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [refreshKey, s.remoteEnabled]);
  const apply = async (call: () => Promise<RemoteStatus>) => {
    setWorking(true);
    setError("");
    try {
      setStatus(await call());
    } catch (e) {
      setError(readable(e) || "That didn’t apply. Try again.");
    } finally {
      setWorking(false);
    }
  };
  const devices = status?.devices ?? s.remoteDevices;
  return (
    <details className="setting-group">
      <summary>
        <span>
          Phone remote
          <span>{summary(s, status)}</span>
        </span>
      </summary>
      <div className="setting-fields">
        <p>
          Butler can serve a small page to your phone over your own
          Tailscale network: what it is doing, plain-language instructions,
          stop, pause and continue, and, only for phones you allow, approving
          routine steps. Nothing is published to the internet, and Butler
          never turns on Tailscale Funnel.
        </p>
        <label className="consent">
          <input
            type="checkbox"
            checked={s.remoteEnabled}
            onChange={(e) => set("remoteEnabled", e.target.checked)}
          />
          <span>Let my phone reach Butler over Tailscale</span>
        </label>
        {s.remoteEnabled && (
          <p role="status">
            {statusLine(status, s.remoteEnabled)}
            {status?.note ? ` ${status.note}` : ""}
          </p>
        )}
        {s.remoteEnabled && status?.state === "on" && (
          <p>
            On your phone: connect Tailscale, open the address above in Safari,
            then Share › Add to Home Screen. The phone shows up below after its
            first visit; nothing works until you allow it here.
          </p>
        )}
        <p>
          <b>Phones</b>
        </p>
        {devices.length === 0 && <p>No phone has connected yet.</p>}
        {devices.map((d) => (
          <div key={d.id} className="remote-device">
            <p>
              <b>{d.name || "Unnamed device"}</b> · last seen{" "}
              {ago(d.lastSeen, now)}
              {status?.connected.includes(d.id) ? " · connected" : ""}
            </p>
            <label className="consent">
              <input
                type="checkbox"
                checked={d.control}
                disabled={busy || working}
                onChange={(e) =>
                  void apply(() =>
                    api.setRemoteDevice(d.id, { control: e.target.checked }),
                  )
                }
              />
              <span>
                Allow control from this phone (stop, pause, continue,
                instructions, skipping an approval)
              </span>
            </label>
            <label className="consent">
              <input
                type="checkbox"
                checked={d.approve}
                disabled={busy || working || !d.control}
                onChange={(e) =>
                  void apply(() =>
                    api.setRemoteDevice(d.id, { approve: e.target.checked }),
                  )
                }
              />
              <span>
                Approve routine steps from this phone (opening apps, quitting,
                navigation). Sending, saving, deleting, paying, installing,
                signing in and system changes are always approved on the Mac.
              </span>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={busy || working}
              onClick={() => void apply(() => api.forgetRemoteDevice(d.id))}
            >
              Forget this phone
            </button>
          </div>
        ))}
        <label>
          Show a screenshot on the phone
          <select
            value={s.remoteScreenshots}
            onChange={(e) =>
              set(
                "remoteScreenshots",
                e.target.value as Settings["remoteScreenshots"],
              )
            }
          >
            <option value="off">Never</option>
            <option value="thumbnail">Blurred layout only</option>
          </select>
        </label>
        <p>
          The blurred view is a 24-pixel mosaic of the selected display: layout
          and colour, no readable text. Protected apps and secure fields are
          never captured at all.
        </p>
        <label>
          Port on the Tailscale address
          <input
            type="number"
            inputMode="numeric"
            min={1024}
            max={65535}
            value={s.remotePort}
            onChange={(e) =>
              set("remotePort", Number(e.target.value) || s.remotePort)
            }
          />
        </label>
        <p>
          Talking from the phone is coming later: a hold-to-talk button whose
          recording is transcribed on this Mac and then deleted. Spoken words
          will never approve anything.
        </p>
        <p>
          Lost your phone? Lock the remote here or from the menu bar: every
          phone is cut off at once and the remote turns off until you turn it
          back on. Then remove the device in the Tailscale admin console.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={busy || working || !s.remoteEnabled}
          onClick={() =>
            void apply(async () => {
              const next = await api.lockRemote();
              set("remoteEnabled", false);
              return next;
            })
          }
        >
          Lock phone remote now
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
