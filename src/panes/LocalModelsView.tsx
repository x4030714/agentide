import { useEffect, useState } from "react";

import { gpuVramGb } from "../lib/bridge";
import type { WirePath } from "../lib/protocol";
import { LocalModels } from "./LocalModels";

/**
 * Local models lives in the rail, not in Settings: it is a page you sit on while gigabytes
 * arrive, and it can stay open beside the transcript while a download runs. A modal cannot.
 */
interface LocalModelsViewProps {
  root: WirePath | null;
}

export function LocalModelsView({ root }: LocalModelsViewProps) {
  /** The GPU, read once: it decides which models fit, and cannot change while the app is open. */
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
