/**
 * Design-review harness (kept, not scrap). A load generator for the transcript.
 *
 * `?bench=N` drives N tool calls through the real reducer and the real components, then
 * reports what it cost. The point is to decide virtualisation on measurements rather
 * than on the reflex that long lists need it.
 */

/** Emits N tool-call/result pairs as fast as the channel will take them. */
export function benchTurn(emit: (event: unknown) => void, calls: number) {
  const S = "bench";
  performance.mark("bench-start");
  emit({ t: "ready", pid: 1, sdkVersion: "bench" });
  emit({
    t: "event",
    sessionId: S,
    msg: {
      type: "system",
      subtype: "init",
      model: "claude-opus-5",
      cwd: "C:/Users/tung/Desktop/agentide",
      tools: [],
      permissionMode: "default",
    },
  });

  for (let i = 0; i < calls; i += 1) {
    emit({
      t: "event",
      sessionId: S,
      msg: {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: `b${i}`,
              name: i % 3 === 0 ? "Edit" : "Read",
              input: { file_path: `src/generated/module_${i}.rs` },
            },
          ],
        },
      },
    });
    emit({
      t: "event",
      sessionId: S,
      msg: {
        type: "user",
        isSynthetic: true,
        message: {
          content: [
            { type: "tool_result", tool_use_id: `b${i}`, content: "x".repeat(300) },
          ],
        },
      },
    });
    // One prose row every ten calls, so wrapped variable-height rows are represented.
    if (i % 10 === 0) {
      emit({
        t: "event",
        sessionId: S,
        msg: {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `Checked module ${i}. The signature matches the trait and the call sites are consistent with the rename, so nothing further is needed here.`,
              },
            ],
          },
        },
      });
    }
  }
  emit({ t: "done", sessionId: S, reason: "success" });
}

/**
 * Wall clock from the first event until the row count stops growing.
 *
 * Polls rather than trusting a fixed sleep: a fixed wait measures the wait, which is
 * how the first version of this probe reported the harness's own tree-clicking as if it
 * were transcript cost.
 */
export async function settleMs(): Promise<number> {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const count = () => document.querySelectorAll(".t-row").length;

  // Wait for the pane to mount and the first row to land. Without this the poll below
  // settles instantly at zero rows, which is what the second version of this probe did.
  const deadline = performance.now() + 20_000;
  while (count() === 0 && performance.now() < deadline) await frame();

  const start = performance.getEntriesByName("bench-start")[0]?.startTime ?? 0;
  let last = -1;
  let stableFor = 0;
  while (stableFor < 6) {
    await frame();
    const rows = count();
    stableFor = rows === last ? stableFor + 1 : 0;
    last = rows;
  }
  return Number((performance.now() - start).toFixed(0));
}

/** Counts what ended up on screen and how long the page spent doing it. */
export async function report(): Promise<Record<string, number>> {
  const settled = await settleMs();
  const body = document.querySelector(".transcript-body");
  const rows = document.querySelectorAll(".t-row").length;
  const nodes = body ? body.querySelectorAll("*").length : 0;
  const paint = performance.getEntriesByType("paint");
  return {
    rows,
    nodesInTranscript: nodes,
    nodesPerRow: rows ? Number((nodes / rows).toFixed(1)) : 0,
    domNodesTotal: document.querySelectorAll("*").length,
    scrollHeight: body ? (body as HTMLElement).scrollHeight : 0,
    firstPaintMs: Number((paint[0]?.startTime ?? 0).toFixed(0)),
    settleMs: settled,
  };
}
