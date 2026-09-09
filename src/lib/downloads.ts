/** Fetching a model with `curl.exe` under the agent's background-process machinery: resumable
 * (`-C -`), visible in a tab, reaped with the app. Progress is the file's size, not curl's output. */

import { listBackground, startBackground, stopBackground } from "./agent-shell";
import { listDir } from "./bridge";
import type { LocalModel } from "./local-models";
import { enginePath, installRoot, modelPath, modelUrl } from "./local-models";
import type { WirePath } from "./protocol";

/** Where one download has got to. */
export interface Progress {
  /** Bytes on disk so far. */
  bytes: number;
  /** What the finished file should weigh. */
  total: number;
  /** 0 to 1, clamped -- a file can briefly exceed its catalogue size by a rounding error. */
  fraction: number;
  running: boolean;
}

/** The GitHub release asset a llama.cpp build lives in. */
export interface EngineAsset {
  name: string;
  url: string;
  /** The CUDA runtime DLLs, which the CUDA build will not start without. */
  runtimeUrl?: string;
}

/** Find a llama.cpp build for this machine. Walks back through releases: the newest tag is
 * sometimes a nightly carrying no assets, and a pinned URL rots into a 404. */
export async function findEngine(cuda: boolean): Promise<EngineAsset> {
  const pattern = cuda ? "bin-win-cuda-13" : "bin-win-cpu-x64";
  const response = await fetch(
    "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10",
  );
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the release list`);
  const releases = (await response.json()) as Array<{
    assets?: Array<{ name: string; browser_download_url: string }>;
  }>;

  for (const release of releases) {
    const assets = release.assets ?? [];
    const build = assets.find(
      (asset) => asset.name.startsWith("llama-") && asset.name.includes(pattern),
    );
    if (!build) continue;
    const runtime = assets.find(
      (asset) => asset.name.startsWith("cudart-") && asset.name.includes(pattern),
    );
    return {
      name: build.name,
      url: build.browser_download_url,
      ...(cuda && runtime ? { runtimeUrl: runtime.browser_download_url } : {}),
    };
  }
  throw new Error(`no ${pattern} build in the last 10 llama.cpp releases`);
}

/** The background process id for one model's download, so two never collide. */
function jobFor(model: LocalModel): string {
  return `download ${model.id}`;
}

/** Every file in a directory, by name, or empty when it is not there yet. One listing, not one
 * per file — per-model calls meant a dozen IPC round-trips a second while the panel was open. */
async function sizesIn(directory: WirePath): Promise<Map<string, number>> {
  try {
    const listing = await listDir(directory);
    return new Map(listing.entries.map((entry) => [entry.name, entry.size]));
  } catch {
    // The directory does not exist until the first download creates it.
    return new Map();
  }
}

/** Whether a download for `model` is running right now. */
export function downloading(model: LocalModel): boolean {
  const job = jobFor(model);
  return listBackground().some((process) => process.command.includes(job) && process.running);
}

/** Where every model has got to, by id. Safe on a repeating timer: they share a directory, so
 * one listing is the whole answer. */
export async function progressAll(
  home: string,
  models: readonly LocalModel[],
): Promise<Record<string, Progress>> {
  const sizes = await sizesIn(`${installRoot(home)}/models` as WirePath);
  const running = new Set(
    listBackground()
      .filter((process) => process.running)
      .map((process) => process.command),
  );
  const progress: Record<string, Progress> = {};
  for (const model of models) {
    const bytes = sizes.get(model.file) ?? 0;
    const total = Math.round(model.gigabytes * 1_073_741_824);
    progress[model.id] = {
      bytes,
      total,
      fraction: total > 0 ? Math.min(1, bytes / total) : 0,
      running: [...running].some((command) => command.includes(jobFor(model))),
    };
  }
  return progress;
}

/** Whether the weights are fully here. Within a percent, because the catalogue size is rounded
 * to a tenth of a gigabyte — exact equality calls a finished 17.3GB download unfinished forever. */
export function isComplete(progress: Progress): boolean {
  return progress.total > 0 && progress.bytes >= progress.total * 0.99;
}

/** Start, or resume, everything `model` needs. One script, one tab to watch; every step is
 * skipped when its output exists, so this doubles as the retry. */
export async function startDownload(
  home: string,
  model: LocalModel,
  cuda: boolean,
  cwd: WirePath | null,
): Promise<string> {
  if (downloading(model)) return jobFor(model);

  const root = installRoot(home);
  const engineDir = `${root}/engine`;
  const engine = enginePath(home);
  const asset = (await hasEngine(home)) ? null : await findEngine(cuda);

  const steps = [
    `$ErrorActionPreference = "Stop"`,
    `# ${jobFor(model)}`,
    `New-Item -ItemType Directory -Force -Path "${engineDir}", "${root}/models" | Out-Null`,
  ];

  if (asset) {
    steps.push(
      `Write-Host "downloading ${asset.name}"`,
      `curl.exe -L -C - -o "${root}/engine.zip" "${asset.url}"`,
      `Expand-Archive -Path "${root}/engine.zip" -DestinationPath "${engineDir}" -Force`,
      `Remove-Item "${root}/engine.zip"`,
    );
    if (asset.runtimeUrl) {
      steps.push(
        `Write-Host "downloading the CUDA runtime"`,
        `curl.exe -L -C - -o "${root}/cudart.zip" "${asset.runtimeUrl}"`,
        `Expand-Archive -Path "${root}/cudart.zip" -DestinationPath "${engineDir}" -Force`,
        `Remove-Item "${root}/cudart.zip"`,
      );
    }
    // The release zips put the binaries in a subdirectory on some builds and at the root on
    // others, so the server is found rather than assumed.
    steps.push(
      `$found = Get-ChildItem -Path "${engineDir}" -Filter llama-server.exe -Recurse | Select-Object -First 1`,
      `if ($found -and $found.FullName -ne "${engine}".Replace("/", "\\")) {`,
      `  Copy-Item -Path "$($found.Directory)/*" -Destination "${engineDir}" -Recurse -Force`,
      `}`,
    );
  }

  steps.push(
    `Write-Host "downloading ${model.name} — ${model.gigabytes}GB"`,
    `curl.exe -L -C - -o "${modelPath(home, model)}" "${modelUrl(model)}"`,
    `Write-Host ""`,
    `Write-Host "ready — pick ${model.name} from the Model menu"`,
  );

  const process = await startBackground(steps.join("\n"), cwd);
  return process.id;
}

/** Whether llama.cpp is installed. Presence of the executable, not its size: recent Windows
 * builds ship a 9KB `llama-server.exe` launcher over `llama.dll`. */
export async function hasEngine(home: string): Promise<boolean> {
  const name = enginePath(home).split("/").pop() ?? "llama-server.exe";
  const files = await sizesIn(`${installRoot(home)}/engine` as WirePath);
  return files.has(name);
}

/** Stop a download, keeping what arrived. Killing curl leaves the partial file and `-C -`
 * continues from it, so this is a pause, not a cancel. */
export async function pauseDownload(model: LocalModel): Promise<void> {
  const job = jobFor(model);
  const process = listBackground().find((entry) => entry.command.includes(job) && entry.running);
  if (process) await stopBackground(process.id);
}
