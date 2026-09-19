import type { ToolClock, ToolOutcome } from "../core/tools";
export type ToolFastPath =
  | {
      kind: "answer";
      tool: string;
      args: Record<string, unknown>;
      say(o: ToolOutcome, c: ToolClock): string;
    }
  | { kind: "step"; tool: string; args: Record<string, unknown> };
/** A request one builtin tool answers or does outright, or undefined. The stub matches nothing. */
export function toolFastPath(
  _text: string,
  _clock: ToolClock,
): ToolFastPath | undefined {
  return undefined;
}
