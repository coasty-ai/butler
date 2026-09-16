import type { Action, Controller, Frame, Provider, Surface } from "./schema";
const escape = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export class TutorialController implements Controller {
  kind = "tutorial" as const;
  moved = false;
  focused = false;
  text = "";
  private stopped = false;
  async surface(): Promise<Surface> {
    return {
      appId: "ai.coarena.tutorial",
      pid: 0,
      secureInput: false,
      unknown: false,
    };
  }
  async resume() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
  async capture(): Promise<Frame> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640"><rect width="1000" height="640" fill="#f5f4f0"/><rect width="1000" height="56" fill="#fff"/><circle cx="26" cy="28" r="6" fill="#fd766a"/><circle cx="46" cy="28" r="6" fill="#f6c66b"/><circle cx="66" cy="28" r="6" fill="#7fcaa0"/><text x="500" y="34" text-anchor="middle" fill="#737770" font-family="Arial" font-size="13">CoArena Tutorial · Local practice space</text><text x="62" y="122" fill="#233829" font-family="Arial" font-size="30" font-weight="bold">A little less busywork.</text><text x="62" y="156" fill="#80867e" font-family="Arial" font-size="15">Move the card to Completed. Add a short note.</text><rect x="62" y="202" width="420" height="274" rx="14" fill="#e9e9e2"/><rect x="516" y="202" width="420" height="274" rx="14" fill="#e6ede6"/><text x="86" y="240" fill="#73786f" font-family="Arial" font-size="13">TO DO</text><text x="540" y="240" fill="#567760" font-family="Arial" font-size="13">COMPLETED</text><rect x="${this.moved ? 540 : 86}" y="262" width="372" height="96" rx="10" fill="#fff" stroke="${this.moved ? "#a7c2ab" : "#e1dfd8"}"/><rect x="${this.moved ? 558 : 104}" y="286" width="6" height="45" rx="3" fill="#d78067"/><text x="${this.moved ? 580 : 126}" y="301" fill="#334638" font-family="Arial" font-size="17">Your first computer-use task</text><text x="${this.moved ? 580 : 126}" y="328" fill="#8c9389" font-family="Arial" font-size="13">${this.moved ? "Moved successfully ✓" : "Drag me to the next column"}</text><rect x="62" y="511" width="874" height="68" rx="12" fill="#fff" stroke="${this.focused ? "#709978" : "#dedfd7"}" stroke-width="2"/><text x="86" y="553" fill="${this.text ? "#334638" : "#a2a69d"}" font-family="Arial" font-size="16">${escape(this.text || "Add a completion note…")}</text></svg>`;
    const bytes = new TextEncoder().encode(svg);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return {
      id: crypto.randomUUID(),
      sha256: Array.from(new Uint8Array(hash))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(""),
      image:
        "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg))),
      geometry: {
        display_id: 0,
        x: 0,
        y: 0,
        width: 1000,
        height: 640,
        native_width: 1000,
        native_height: 640,
        model_width: 1000,
        model_height: 640,
        scale_factor: 1,
      },
      capturedAt: performance.now(),
      synthetic: true,
      appId: "ai.coarena.tutorial",
    };
  }
  async execute(a: Action, _f: Frame, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Stopped.");
    if (
      a.type === "drag" &&
      a.start_x < 0.48 &&
      a.end_x > 0.51 &&
      a.end_y > 0.31 &&
      a.end_y < 0.74
    )
      this.moved = true;
    if (a.type === "click") this.focused = a.y > 0.79 && a.y < 0.91;
    if (a.type === "type_text" && this.focused) this.text += a.text;
    if (a.type === "wait")
      await new Promise((r) => setTimeout(r, a.milliseconds));
  }
}
export class TutorialProvider implements Provider {
  private step = 0;
  constructor(private delay = 650) {}
  async next(o: Parameters<Provider["next"]>[0], signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delay);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("Cancelled"));
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
    const actions = [
      {
        type: "drag",
        start_x: 0.25,
        start_y: 0.48,
        end_x: 0.72,
        end_y: 0.48,
        duration_ms: 450,
      },
      { type: "click", x: 0.3, y: 0.85, button: "left" },
      { type: "type_text", text: "Done — ready for the next thing." },
      {
        type: "done",
        summary: "Moved the card to Completed and added the completion note.",
      },
    ];
    return {
      action: { ...actions[Math.min(this.step++, 3)], frame_id: o.frame.id },
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    };
  }
}
