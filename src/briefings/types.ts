export type BriefingSourceState =
  "ok" | "off" | "unavailable" | "needs_setup" | "error";
export interface BriefingSource {
  id: string;
  title: string;
  state: BriefingSourceState;
  detail: string;
  /** Bounded, redacted facts; never instructions or tool arguments. */
  text: string;
}
export interface BriefingFacts {
  at: number;
  since: number;
  zone?: string;
  sources: BriefingSource[];
}
export interface Briefing {
  at: number;
  since: number;
  text: string;
  mode: "model" | "local";
  note?: string;
  /** Coverage only; raw source text isn't kept in the latest briefing. */
  sources: Omit<BriefingSource, "text">[];
}
export interface BriefingStatus {
  on: boolean;
  state: "off" | "waiting" | "running" | "error";
  nextAt?: number;
  latest?: Briefing;
  error?: string;
  tokensToday: number;
}
export interface BriefingBudget {
  day: string;
  tokens: number;
}
export interface BriefingBudgetStore {
  load(): BriefingBudget | undefined;
  save(budget: BriefingBudget): void;
}
export interface BriefingTool {
  id: string;
  title: string;
  does: string;
  params: string;
}
