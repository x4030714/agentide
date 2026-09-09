/** The models you can run here. A fixed list: agentide is unusable on a model that cannot call
 * tools, and sizes and filenames come from the HF API — a wrong one is a 404 after 17GB. */

/** How well a model fits the hardware in front of you. */
export type Fit = "vram" | "spills" | "too-big";

export interface LocalModel {
  /** Stable id, used as the provider key and the directory name. */
  id: string;
  name: string;
  /** The Hugging Face repository the file lives in. */
  repo: string;
  /** The exact filename in that repository. Verified, never guessed. */
  file: string;
  /** On-disk size, from the API. */
  gigabytes: number;
  /** Trained context, from the GGUF metadata. A hard ceiling: llama.cpp caps a larger request
   * ("exceeds the training context of the model") rather than honouring it. Never guessed. */
  trainedContext: number;
  /** Whether only a fraction of the weights are active per token. Mixture-of-experts tolerates
   * spilling to system RAM far better than a dense model of the same size. */
  mixture: boolean;
  /** What it is for, in the one line the list has room for. */
  note: string;
}

/** The ten most downloaded open models that can drive this IDE, plus two small ones, since
 * popularity skews large. Excluded: embedding, speech, unevaluated merges, and sharded weights. */
export const LOCAL_MODELS: LocalModel[] = [
  {
    id: "qwen3-coder-30b",
    name: "Qwen3 Coder 30B",
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    file: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
    gigabytes: 17.3,
    mixture: true,
    trainedContext: 262144,
    note: "the most downloaded local coder; 3B active per token, so it spills cheaply",
  },
  {
    id: "qwen38-27b",
    name: "Qwen3.8 27B",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    file: "Qwen3.8-27B-UD-Q4_K_M.gguf",
    gigabytes: 15.3,
    mixture: false,
    trainedContext: 262144,
    note: "general flagship, dense — strong, and slow the moment it spills",
  },
  {
    id: "ornith-15-9b",
    name: "Ornith 1.5 9B",
    repo: "ornith-ai/Ornith-1.5-9B-GGUF",
    file: "Ornith-1.5-9B-Q4_K_M.gguf",
    gigabytes: 5.4,
    mixture: false,
    trainedContext: 262144,
    note: "built on Qwen3.5 and Gemma 4, tuned for one GPU",
  },
  {
    id: "ornith-15-35b",
    name: "Ornith 1.5 35B",
    repo: "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    file: "Ornith-1.5-35B-Q4_K_M.gguf",
    gigabytes: 20.2,
    mixture: true,
    trainedContext: 262144,
    note: "the same family at full size; wants a 24GB card to stay resident",
  },
  {
    id: "qwen35-9b",
    name: "Qwen3.5 9B",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    gigabytes: 5.3,
    mixture: false,
    trainedContext: 262144,
    note: "fits an 8GB card whole, and is quick because of it",
  },
  {
    id: "qwen3-30b-thinking",
    name: "Qwen3 30B Thinking",
    repo: "unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF",
    file: "Qwen3-30B-A3B-Thinking-2507-Q4_K_M.gguf",
    gigabytes: 17.3,
    mixture: true,
    trainedContext: 262144,
    note: "reasons before answering — slower per turn, better on hard changes",
  },
  {
    id: "qwen36-35b",
    name: "Qwen3.6 35B",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    gigabytes: 20.6,
    mixture: true,
    trainedContext: 262144,
    note: "the largest here; needs a lot of memory somewhere",
  },
  {
    id: "qwen36-27b",
    name: "Qwen3.6 27B",
    repo: "unsloth/Qwen3.6-27B-GGUF",
    file: "Qwen3.6-27B-UD-Q4_K_XL.gguf",
    gigabytes: 16.4,
    mixture: false,
    trainedContext: 262144,
    note: "dense 27B — a 24GB card holds it and nothing smaller does",
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B",
    repo: "google/gemma-4-12B-it-qat-q4_0-gguf",
    file: "gemma-4-12b-it-qat-q4_0.gguf",
    gigabytes: 6.5,
    mixture: false,
    trainedContext: 262144,
    note: "Google's open model, from Google — trained for this quantisation",
  },
  {
    id: "deepseek-coder-v2-lite",
    name: "DeepSeek Coder V2 Lite",
    repo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF",
    file: "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
    gigabytes: 9.7,
    mixture: true,
    trainedContext: 163840,
    note: "DeepSeek's coder; 2.4B active of 16B, so it spills cheaply",
  },
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    repo: "ggml-org/gemma-4-E4B-it-GGUF",
    file: "gemma-4-E4B-it-Q4_0.gguf",
    gigabytes: 4.3,
    mixture: false,
    trainedContext: 131072,
    note: "the small Gemma — runs on a 6GB card with room for a long context",
  },
  {
    id: "qwen25-coder-7b",
    name: "Qwen2.5 Coder 7B",
    repo: "unsloth/Qwen2.5-Coder-7B-Instruct-GGUF",
    file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    gigabytes: 4.4,
    mixture: false,
    trainedContext: 32768,
    note: "32k context — too small for agentide's prompt, which needs 64k",
  },
];

/** Headroom the context window needs beside the weights: 64k of KV cache on a model this size is
 * over a gigabyte, and counting only the file calls a model a fit that then fails to load. */
const CONTEXT_OVERHEAD_GB = 2;

/** Whether `model` fits in `vramGb`, and how badly it does not. `null` VRAM means nothing was
 * detected, so everything reads as `spills` — it will run on the CPU, slowly. */
export function fitsIn(model: LocalModel, vramGb: number | null): Fit {
  if (vramGb === null) return "spills";
  if (model.gigabytes + CONTEXT_OVERHEAD_GB <= vramGb) return "vram";
  // A mixture-of-experts model activates a fraction of its weights per token, so it stays
  // usable spilling into system RAM where a dense model of the same size does not.
  const tolerance = model.mixture ? 3 : 1.5;
  return model.gigabytes <= vramGb * tolerance ? "spills" : "too-big";
}

/** What the badge beside a model says. */
export function fitLabel(fit: Fit): string {
  if (fit === "vram") return "fits your GPU";
  if (fit === "spills") return "spills to RAM — slower";
  return "too big for this machine";
}

/** The port a model's server listens on, hashed from its id. A position-derived port moves when
 * the catalogue is reordered, and then two entries gate on one port. */
export function portFor(model: LocalModel): number {
  let hash = 0;
  for (const character of model.id) {
    // The usual 31-multiplier string hash, kept in 32 bits.
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  // 100 ports above the base: enough that a collision needs two of these twelve to land on
  // the same slot, and low enough to stay clear of anything ephemeral.
  return 8080 + (Math.abs(hash) % 100);
}

/** The direct download URL for a model file. */
export function modelUrl(model: LocalModel): string {
  return `https://huggingface.co/${model.repo}/resolve/main/${model.file}?download=true`;
}

/** Where agentide keeps what it downloads. Beside the other machine-level state. */
export function installRoot(home: string): string {
  return `${home}/.agentide`;
}

export function modelPath(home: string, model: LocalModel): string {
  return `${installRoot(home)}/models/${model.file}`;
}

export function enginePath(home: string): string {
  return `${installRoot(home)}/engine/llama-server.exe`;
}

/** The provider entry a downloaded model becomes. Written before the download finishes: the entry
 * is gated on its port, so it reads as not answering — truer than an empty picker for 17GB. */
export function providerEntry(
  home: string,
  model: LocalModel,
  port: number,
  contextLength: number,
): Record<string, unknown> {
  return {
    note: `${model.name} — ${model.note}`,
    model: modelPath(home, model),
    engine: enginePath(home),
    port,
    contextLength,
  };
}

/** The command that runs a downloaded model, before the sidecar has read `providers.json`. Second
 * copy of a string in `sidecar/src/provider-config.ts`; the `&` is the part that matters. */
export function startCommandFor(
  home: string,
  model: LocalModel,
  port: number,
  context: number,
): string {
  return `& "${enginePath(home)}" -m "${modelPath(home, model)}" -c ${context} --port ${port} --host 127.0.0.1`;
}

/** The script that fetches everything a model needs, in a visible tab. Idempotent (steps skipped
 * when their output exists), resumable (`curl -C -`), and self-dating (a pinned tag rots to 404). */
export function installScript(home: string, model: LocalModel, cuda: boolean): string {
  const root = installRoot(home);
  const engineDir = `${root}/engine`;
  const models = `${root}/models`;
  // CUDA 13 for anything current; the CPU build is the fallback that always works.
  const pattern = cuda ? "bin-win-cuda-13" : "bin-win-cpu-x64";

  return [
    `$ErrorActionPreference = "Stop"`,
    `New-Item -ItemType Directory -Force -Path "${engineDir}", "${models}" | Out-Null`,
    ``,
    `if (Test-Path "${enginePath(home)}") {`,
    `  Write-Host "llama.cpp is already here"`,
    `} else {`,
    `  Write-Host "finding the latest llama.cpp build..."`,
    // The newest release is sometimes a nightly tag carrying no binaries, so the first
    // one with a matching asset is taken rather than the first one at all.
    `  $releases = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10"`,
    `  $asset = $null`,
    `  foreach ($r in $releases) {`,
    `    $asset = $r.assets | Where-Object { $_.name -like "llama-*${pattern}*.zip" } | Select-Object -First 1`,
    // The runtime is only looked for on the CUDA path, so the CPU script never mentions it
    // -- a script that half-refers to something it will not use is a script nobody trusts.
    cuda
      ? `    if ($asset) { $runtime = $r.assets | Where-Object { $_.name -like "cudart-*${pattern}*.zip" } | Select-Object -First 1; break }`
      : `    if ($asset) { break }`,
    `  }`,
    `  if (-not $asset) { throw "no ${pattern} build in the last 10 llama.cpp releases" }`,
    `  Write-Host "downloading $($asset.name)"`,
    `  curl.exe -L -C - -o "${root}/engine.zip" $asset.browser_download_url`,
    `  Expand-Archive -Path "${root}/engine.zip" -DestinationPath "${engineDir}" -Force`,
    `  Remove-Item "${root}/engine.zip"`,
    cuda
      ? [
          `  if ($runtime) {`,
          // The CUDA runtime DLLs ship separately and llama-server will not start without
          // them unless the full toolkit is installed, which it usually is not.
          `    Write-Host "downloading the CUDA runtime, $($runtime.name)"`,
          `    curl.exe -L -C - -o "${root}/cudart.zip" $runtime.browser_download_url`,
          `    Expand-Archive -Path "${root}/cudart.zip" -DestinationPath "${engineDir}" -Force`,
          `    Remove-Item "${root}/cudart.zip"`,
          `  }`,
        ].join("\n")
      : `  # CPU build: no CUDA runtime needed`,
    `}`,
    ``,
    `if (Test-Path "${modelPath(home, model)}") {`,
    `  Write-Host "${model.name} is already here"`,
    `} else {`,
    `  Write-Host "downloading ${model.name} — ${model.gigabytes}GB, this takes a while"`,
    `  curl.exe -L -C - -o "${modelPath(home, model)}" "${modelUrl(model)}"`,
    `}`,
    ``,
    `Write-Host ""`,
    `Write-Host "ready — pick ${model.name} from the Model menu"`,
  ].join("\n");
}

/** The smallest context agentide can run in. Measured: a turn whose message was "hi" sent 41,476
 * tokens of prefix, and a 32k window refuses that outright rather than degrading. */
const MIN_CONTEXT = 65_536;

/** How much context to load a model with. Bounded above by what is left after the weights, below
 * by `MIN_CONTEXT`. The floor wins a conflict: spilling to RAM is slow, a small window refuses. */
export function contextFor(model: LocalModel, vramGb: number | null): number {
  const wanted = vramGb !== null && vramGb - model.gigabytes >= 6 ? 131_072 : MIN_CONTEXT;
  // Never above what the model was trained for. Asking is not refused, it is silently capped, so
  // a config asking for more would look applied and change nothing.
  return Math.min(wanted, model.trainedContext);
}

/** Whether agentide's prompt fits in this model at all — a property of the weights, so it is said
 * before the download. Qwen2.5 Coder 7B: 4.4GB fetched, unable to answer a single turn. */
export function runsAgentide(model: LocalModel): boolean {
  return model.trainedContext >= MIN_CONTEXT;
}
