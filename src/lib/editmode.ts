import type { PromptOptions } from "./protocol";

/** How much the agent may do without asking. A checkpoint is taken before every turn
 * in all three modes, so the mode only decides how often you are interrupted. */
export type EditMode = "strict" | "review" | "auto";

export const EDIT_MODES: EditMode[] = ["strict", "review", "auto"];

export const MODE_LABEL: Record<EditMode, string> = {
  strict: "Strict",
  review: "Review",
  auto: "Auto",
};

export const MODE_HELP: Record<EditMode, string> = {
  strict: "Asks before every write. Nothing reaches disk unseen.",
  review: "Edits land and queue for review. Commands still ask.",
  auto: "No prompts. Rewind the turn if it goes wrong.",
};

/** What the mode adds to a turn's options. SDK permission modes, not our own allowlist:
 * `acceptEdits` still prompts for Bash, because a checkpoint cannot undo `rm -rf`. */
export function modeOptions(mode: EditMode): PromptOptions {
  switch (mode) {
    case "strict":
      return { permissionMode: "default" };
    case "review":
      return { permissionMode: "acceptEdits" };
    case "auto":
      return { permissionMode: "bypassPermissions" };
  }
}

export function isEditMode(value: unknown): value is EditMode {
  return value === "strict" || value === "review" || value === "auto";
}
