import type { PromptOptions } from "./protocol";

/**
 * How much the agent is allowed to do without asking.
 *
 * One mechanism underneath all three: a checkpoint is taken before every turn whatever
 * the mode, so every edit is reversible either way. The mode only decides how much you
 * are interrupted on the way.
 */
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

/**
 * What the mode adds to a turn's options. Nothing else in the app sets these.
 *
 * All three are the SDK's own permission modes rather than a tool allowlist of our own.
 * `acceptEdits` in particular is exactly Review: file edits land without asking, and
 * everything else -- `Bash` above all -- still stops at a prompt. That distinction is
 * the one that matters, because a checkpoint can put a file back and cannot put back
 * `rm -rf` or a publish.
 */
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
