import { useEffect, useState } from "react";

import { gpuVramGb } from "../lib/bridge";
import type { WirePath } from "../lib/protocol";
import { LocalModels } from "./LocalModels";

/**
 * The Local models view: its own place in the rail, under Conversations.
 *
 * It was a section in Settings, and it did not belong there. Settings is where you change
 * something in a second — a theme, a vault path — and this is a page you sit on while
 * gigabytes arrive, with progress bars that keep moving. Putting it in the rail also means
 * it can be left open beside the transcript while a download runs, which a modal cannot.
 *
 * Last in the rail rather than among the others because it is a thing you set up rather
 * than a thing you work in: the four above are indexes into the workspace, and this is not.
 */
interface LocalModelsViewProps {
  root: WirePath | null;
}

export function LocalModelsView({ root }: LocalModelsViewProps) {
  /**
   * The GPU, asked once here rather than inside the list.
   *
   * It decides which models are marked as fitting and how much context each is given, and
   * it cannot change while the app is open — so it is read when the view opens and not on
   * every render of a panel that redraws once a second.
   */
  const [vramGb, setVramGb] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void gpuVramGb()
      .then((gigabytes) => {
        if (!cancelled) setVramGb(gigabytes);
      })
      .catch(() => {
        // No card, no driver, or no nvidia-smi. The list reads that as "runs on the CPU",
        // which is true, and says what it costs rather than refusing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="pane">
      <div className="pane-header">
        <span className="legend">Local models</span>
      </div>
      <div className="pane-body">
        <LocalModels root={root} vramGb={vramGb} />
      </div>
    </div>
  );
}
