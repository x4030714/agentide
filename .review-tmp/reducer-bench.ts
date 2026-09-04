import { initialState, reduce } from "../src/lib/transcript";
import type { TranscriptAction } from "../src/lib/transcript";

/** A realistic turn: a tool call and its result, over and over. */
function events(n: number): TranscriptAction[] {
  const out: TranscriptAction[] = [{ t: "prompt_submitted", text: "go" }];
  for (let i = 0; i < n; i += 1) {
    out.push({
      t: "event",
      sessionId: "s",
      msg: {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `src/f${i}.rs` } },
          ],
        },
      },
    });
    out.push({
      t: "event",
      sessionId: "s",
      msg: {
        type: "user",
        isSynthetic: true,
        message: {
          content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(400) }],
        },
      },
    });
  }
  return out;
}

for (const n of [100, 250, 500, 1000]) {
  const actions = events(n);
  const start = performance.now();
  let state = initialState();
  for (const action of actions) state = reduce(state, action);
  const ms = performance.now() - start;
  console.log(
    `${String(n).padStart(5)} tool calls  ${String(actions.length).padStart(5)} events  ` +
      `${state.rows.length.toString().padStart(5)} rows  ${ms.toFixed(1).padStart(8)} ms`,
  );
}
