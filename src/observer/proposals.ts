/**
 * What the owner decides about a proposal (.data/design/observer.md §4):
 * Approve turns a procedure into a Skill (src/memory/skills.ts's shape, so
 * the runner's existing replay machinery carries it; it starts as a hint
 * and replays without model calls only after two successes, as every skill
 * does) and a routine into a schedule (status "approved"; electron/routines.ts
 * runs it at its window). "Not this" removes the proposal (it may return
 * with fresh evidence); "Never" keeps it as refused so consolidation does
 * not propose it again. Pure mutators over MemoryData.
 */
import type {
  MemoryData,
  Preference,
  Procedure,
  Routine,
  Skill,
} from "../memory/types";
import { stableId, upsertSkillIn } from "../memory/store";
import { tokenize } from "../memory/retrieve";

export type ProposalKind = "routine" | "procedure" | "preference";
export type ProposalDecision = "approve" | "dismiss" | "never";

/** A procedure as the Skill the runner replays. */
export function procedureToSkill(procedure: Procedure, now: Date): Skill {
  const stamp = now.toISOString();
  return {
    id: procedure.skillId ?? stableId("skill", `observed:${procedure.trigger}`),
    kind: "skill",
    trigger: procedure.trigger,
    tokens: procedure.tokens.length
      ? procedure.tokens
      : tokenize(procedure.trigger),
    slots: [...procedure.slots],
    steps: procedure.steps.map((s) => ({
      action: { ...s.action },
      ...(s.target ? { target: { ...s.target } } : {}),
      ...(s.expectAppId ? { expectAppId: s.expectAppId } : {}),
      ...(s.tool ? { tool: { ...s.tool } } : {}),
    })),
    // Observed steps name their controls by label; a step that could not
    // be expressed that way never made it through the schema.
    hintOnly: false,
    successes: 0,
    failures: 0,
    createdAt: stamp,
    lastUsed: stamp,
  };
}

export interface DecisionResult {
  changed: boolean;
  /** The Skill an approved procedure became. */
  skill?: Skill;
}
export function decideProposalIn(
  data: MemoryData,
  kind: ProposalKind,
  id: string,
  decision: ProposalDecision,
  now: Date,
): DecisionResult {
  const stamp = now.toISOString();
  if (kind === "routine") {
    const index = data.routines.findIndex((r) => r.id === id);
    if (index < 0) return { changed: false };
    const routine = data.routines[index];
    if (decision === "dismiss") {
      data.routines.splice(index, 1);
      return { changed: true };
    }
    routine.status = decision === "approve" ? "approved" : "never";
    if (decision === "approve") {
      routine.correctionStreak = 0;
      delete routine.corrections;
    }
    return { changed: true };
  }
  if (kind === "procedure") {
    const index = data.procedures.findIndex((p) => p.id === id);
    if (index < 0) return { changed: false };
    const procedure = data.procedures[index];
    if (decision === "dismiss") {
      data.procedures.splice(index, 1);
      return { changed: true };
    }
    if (decision === "never") {
      procedure.status = "never";
      return { changed: true };
    }
    const skill = procedureToSkill(procedure, now);
    upsertSkillIn(data, skill);
    procedure.status = "approved";
    procedure.skillId = skill.id;
    return { changed: true, skill };
  }
  const index = data.preferences.findIndex(
    (p) => p.id === id && p.source === "observed",
  );
  if (index < 0) return { changed: false };
  const preference = data.preferences[index];
  if (decision === "dismiss") {
    data.preferences.splice(index, 1);
    return { changed: true };
  }
  preference.status = decision === "approve" ? "approved" : "never";
  preference.updatedAt = stamp;
  return { changed: true };
}

/** What the pane lists: proposals awaiting a decision and what was approved, with evidence and replays. */
export interface LearnedProposals {
  routines: Routine[];
  procedures: (Procedure & {
    replays?: { successes: number; failures: number };
  })[];
  preferences: Preference[];
}
export function learnedProposals(data: MemoryData): LearnedProposals {
  const shown = (status: string) =>
    status === "proposed" || status === "approved";
  const order = (a: { status: string }, b: { status: string }) =>
    Number(a.status === "approved") - Number(b.status === "approved");
  return {
    routines: data.routines
      .filter((r) => shown(r.status))
      .sort((a, b) => order(a, b) || b.lastSeen.localeCompare(a.lastSeen)),
    procedures: data.procedures
      .filter((p) => shown(p.status))
      .sort((a, b) => order(a, b) || b.lastSeen.localeCompare(a.lastSeen))
      .map((p) => {
        const skill = p.skillId
          ? data.skills.find((s) => s.id === p.skillId)
          : undefined;
        return skill
          ? {
              ...p,
              replays: { successes: skill.successes, failures: skill.failures },
            }
          : p;
      }),
    preferences: data.preferences
      .filter((p) => p.source === "observed" && shown(p.status ?? "approved"))
      .sort(
        (a, b) =>
          order(
            { status: a.status ?? "approved" },
            { status: b.status ?? "approved" },
          ) || b.updatedAt.localeCompare(a.updatedAt),
      ),
  };
}
