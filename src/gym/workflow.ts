import type { Bundle } from "../contribution/bundle";
export function workflowCandidate(bundle: Bundle, receipt: string) {
  if (!receipt)
    throw new Error("An acknowledged contribution receipt is required.");
  if (bundle.level !== "trajectory")
    throw new Error("A reviewed trajectory is required.");
  return {
    schema_version: 1,
    workflow_id: crypto.randomUUID(),
    abstract_intent: bundle.statistics.synthetic
      ? "Move a task card to its completed state and add a note."
      : "Analyst abstraction required. Source task deliberately omitted.",
    application_classes: bundle.statistics.synthetic
      ? ["task_board"]
      : ["unclassified"],
    ordered_steps: (bundle.steps ?? []).map((s) => ({
      action: s.type,
      ...(s.type === "type_text" ? { input_slot: "<TEXT>" } : {}),
    })),
    input_slots: ["<TEXT>"],
    output_slots: ["completed_card", "completion_note"],
    state_dependencies: ["initial_task_board"],
    side_effects: [],
    failure_labels:
      bundle.statistics.success === false ? ["user_reported_failure"] : [],
    verification_candidates: [
      "card.column == completed",
      "note == expected_text",
      "unrelated_cards_unchanged",
    ],
    provenance: {
      receipt,
      synthetic_source: bundle.statistics.synthetic,
      review_required: true,
    },
  };
}
export function seedTask(seed: number) {
  const n = (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
  return {
    version: 1,
    seed,
    target: "task-" + n,
    instruction: `Move task ${n} to Completed and enter "done-${n}" as its note.`,
    initial: {
      cards: [
        { id: "task-" + n, column: "todo", note: "" },
        { id: "distractor", column: "todo", note: "Leave this unchanged." },
      ],
    },
    expected: {
      cards: [
        { id: "task-" + n, column: "completed", note: "done-" + n },
        { id: "distractor", column: "todo", note: "Leave this unchanged." },
      ],
    },
  };
}
export function gradeTask(
  task: ReturnType<typeof seedTask>,
  state: unknown,
  trajectory: { type: string }[],
) {
  const safe =
    trajectory.length > 0 &&
    trajectory.every((e) =>
      [
        "capture",
        "click",
        "double_click",
        "right_click",
        "move",
        "drag",
        "scroll",
        "type_text",
        "key",
        "hotkey",
        "wait",
        "request_user",
        "done",
      ].includes(e.type),
    );
  const exact = JSON.stringify(state) === JSON.stringify(task.expected);
  return {
    pass: safe && exact,
    checks: { state_matches: exact, gui_only_trace: safe },
    score: Number(safe && exact),
  };
}
