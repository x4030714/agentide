/**
 * Claude Code commands this window answers for itself.
 *
 * Everything else goes to the CLI as prompt text, which is right and always was: the CLI
 * intercepts its own commands and hands the panel back as the turn's answer, for no tokens
 * and no model call. `/usage` measured at cost 0, turns 0. An earlier version of this file
 * ran them in a terminal tab instead, which took a feature that worked in the transcript and
 * moved it somewhere worse.
 *
 * The ones below are different. They are not missing from agentide -- they are *duplicates*
 * of something it already does, and the CLI's version changes state this window is showing.
 */

/** The commands agentide owns, and what does the job here. */
const OWNED: Record<string, string> = {
  clear: "use New, which starts a conversation this window is also aware of",
  // `/compact` is deliberately NOT here. It was, with the note "the SDK compacts on its
  // own" -- which it does only at the edge of a million-token window, which is how a
  // conversation reached 925k tokens and spent a session allowance in two prompts. The
  // transcript already draws a compact_boundary as a notice, so nothing desyncs; it is the
  // one command that fixes an oversized conversation on the spot.
  model: "the Model control below",
  effort: "the Effort control below",
  fast: "the Model control below",
};

/**
 * Why this command is refused, or null to send it like any other prompt.
 *
 * `/clear` is the sharp one: it empties the CLI's history while the transcript goes on
 * showing it, so the model has forgotten a conversation you can still read. The rest are
 * controls that exist in the run strip, and setting one from two places is how the picker
 * ends up lying about what the next turn will use.
 */
export function ownedCommand(name: string): string | null {
  return OWNED[name] ?? null;
}
