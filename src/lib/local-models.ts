/**
 * The models you can run here, and what it takes to run one.
 *
 * A `.gguf` is only weights; llama.cpp runs them. "Use local model" therefore means three
 * downloads and a config entry, and this module is the part with judgement in it: which
 * models are worth offering, how big each one is, and whether the machine in front of you
 * can actually hold it.
 *
 * ## Why a fixed list rather than a search box
 *
 * Hugging Face has hundreds of thousands of repositories and most of them are a bad idea
 * here: base models with no instruction tuning, merges nobody has evaluated, and quants of
 * models that cannot call a tool. agentide is unusable on a model that cannot call tools --
 * the `ide_*` calls are how it does everything -- so a wrong choice does not read as a
 * weaker model, it reads as a broken IDE. A short list of things known to work is worth
 * more than a search over everything.
 *
 * Every size and filename below was read from the Hugging Face API rather than remembered.
 * A wrong filename is a 404 at the end of a long download.
 *
 * ## Fitting
 *
 * A model runs fastest entirely in VRAM. What does not fit spills to system RAM and runs
 * an order of magnitude slower -- still useful for a mixture-of-experts model, where only
 * a few billion parameters are active per token, and painful for a dense one. So `fitsIn`
 * reports a degree rather than a yes or no, and the list stays complete either way: a
 * machine that cannot run the best model today may be a different machine next month, and
 * hiding it would only hide the reason to upgrade.
 */

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
  /**
   * The context the model was trained with, from the GGUF metadata.
   *
   * A hard ceiling, not a preference: llama.cpp caps a larger request rather than honouring
   * it -- "the slot context (65536) exceeds the training context of the model (32768) -
   * capping" -- so a model below what agentide's prompt needs cannot be made to work by
   * configuring anything. Read from the Hugging Face API per model; never guessed.
   */
  trainedContext: number;
  /**
   * Whether only a fraction of the weights are active per token. A mixture-of-experts
   * model tolerates spilling to system RAM far better than a dense one of the same size,
   * which is the difference between "slow" and "unusable".
   */
  mixture: boolean;
  /** What it is for, in the one line the list has room for. */
  note: string;
}

/**
 * The ten most downloaded open models that can drive this IDE, plus two small ones.
 *
 * Ordered by how widely they are actually used, not by what suits any one machine. That is
 * deliberate: the list is the same on a 6GB laptop and a 24GB workstation, and `fitsIn`
 * says which of them the hardware in front of you can hold. Curating by the author's own
 * GPU would quietly make the catalogue smaller for everyone else.
 *
 * The last two are not in the top ten and are here anyway. Popularity skews large -- the
 * most downloaded models want 16GB and up -- and a list where nothing runs on a modest card
 * is a list that helps nobody who has one.
 *
 * Excluded on purpose: embedding and speech models, which are popular and are not chat
 * models; "uncensored" and "abliterated" merges, which are popular and unevaluated; and
 * anything whose weights are split across shards, because the downloader fetches one file
 * and would report a fifth of a model as complete.
 */
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

/**
 * Headroom the context window needs beside the weights.
 *
 * The KV cache grows with the context, and 64k of it on a model this size is over a
 * gigabyte. Counting only the file would call a model a fit and then fail to load it,
 * which is the worst moment to find out.
 */
const CONTEXT_OVERHEAD_GB = 2;

/**
 * Whether `model` fits in `vramGb`, and how badly it does not.
 *
 * `null` VRAM means nothing could be detected -- no NVIDIA card, or `nvidia-smi` absent.
 * Everything then reads as `spills`, which is honest: it will run on the CPU, and it will
 * be slow.
 */
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

/**
 * The port a model's server listens on, derived from its id.
 *
 * From the id and not from its position in the list, which is what this replaced. A
 * position-derived port moves when the catalogue is reordered -- so a model installed last
 * month keeps the port it was written with while a newly installed one is handed the same
 * number, and then two entries gate on one port: starting either satisfies both, and a turn
 * runs against whichever model happens to be loaded. Rare, silent, and very hard to see.
 *
 * A hash rather than a counter because nothing here remembers what is already installed;
 * the same id must produce the same port on every machine and every run.
 */
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

/**
 * The provider entry a downloaded model becomes.
 *
 * Written before the download finishes on purpose. The entry is gated on its port, so
 * until llama.cpp is there and running it simply reports as not answering -- which is the
 * truth, and better than a picker that stays empty while 17GB arrives.
 */
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

/**
 * The command that runs a downloaded model, for the entry the picker uses before the
 * sidecar has read `providers.json` for itself.
 *
 * This is deliberately the second copy of a string built in `sidecar/src/provider-config.ts`,
 * and the duplication is the lesser evil. The sidecar owns the file and derives the command
 * from it; the frontend needs the same command one turn earlier, because a model installed
 * mid-session is launched from here before the sidecar has looked. Without it the first
 * prompt after installing a model starts nothing at all and fails on the gate, which is the
 * worst possible moment for that.
 *
 * They must agree, and the `&` is the part that matters -- see the note in
 * `provider-config.ts` for why PowerShell needs it.
 */
export function startCommandFor(
  home: string,
  model: LocalModel,
  port: number,
  context: number,
): string {
  return `& "${enginePath(home)}" -m "${modelPath(home, model)}" -c ${context} --port ${port} --host 127.0.0.1`;
}

/**
 * The script that fetches everything a model needs, for a terminal tab.
 *
 * PowerShell rather than a Rust downloader, and visible rather than quiet, for the same
 * reason `ide_run` exists: this is minutes of work with several ways to fail -- no disk
 * space, a proxy, a driver too old for the CUDA build -- and every one of them is one
 * legible line here and an opaque error bar anywhere else. It also means no new
 * dependency and nothing to reimplement: `curl.exe` and `Expand-Archive` ship with
 * Windows.
 *
 * Three properties matter and all three are tested:
 *
 * **Idempotent.** Every step is skipped when its output already exists, so pressing the
 * button twice does not download 17GB twice, and a failed run resumes rather than restarts.
 *
 * **Resumable.** `curl -C -` continues a partial file. A 17GB download that has to start
 * over because a laptop slept is the difference between a feature and a nuisance.
 *
 * **Self-dating.** llama.cpp tags a release per build, so the version is resolved from the
 * GitHub API at run time. A URL pinned here would rot, and it would rot silently -- into a
 * 404 at the start of a long operation.
 */
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

/**
 * The smallest context agentide can actually run in.
 *
 * Measured, not chosen. A turn whose entire user message was "hi" produced a request of
 * **41,476 tokens** before the model saw a word of it: the `claude_code` preset, the tuned
 * prompt, thirteen `ide_*` tool descriptions, and every tool of every configured MCP server
 * -- 51 of them on the machine this was measured on. A 32k window does not fail gracefully
 * against that; llama.cpp refuses the request outright with `exceeds the available context
 * size`, and every turn fails identically no matter what you ask.
 *
 * So 64k is the floor here even though 32k is the usual advice for local coding models.
 * agentide's prompt is bigger than most, and the number that matters is this app's, not the
 * general one. Below 64k the honest answer is that a smaller model with more room beats a
 * bigger one with none.
 */
const MIN_CONTEXT = 65_536;

/**
 * How much context to load a model with.
 *
 * Bounded above by what is left after the weights, because a context the card cannot hold
 * fails at load time rather than degrading -- and bounded below by `MIN_CONTEXT`, because a
 * context that cannot hold the prompt fails on every turn, which is worse. When those two
 * conflict the floor wins: llama.cpp will keep what does not fit in system RAM and run
 * slowly, and slow beats a window that refuses the request.
 */
export function contextFor(model: LocalModel, vramGb: number | null): number {
  const wanted = vramGb !== null && vramGb - model.gigabytes >= 6 ? 131_072 : MIN_CONTEXT;
  // Never above what the model was trained for. Asking is not refused, it is silently
  // capped -- llama.cpp says so in one line and then runs at the smaller size -- so a
  // config that asked for more would look applied and change nothing.
  return Math.min(wanted, model.trainedContext);
}

/**
 * Whether agentide's prompt fits in this model at all.
 *
 * Not a matter of hardware or configuration: `trainedContext` is a property of the weights,
 * and a model below the floor caps every request at its own size and rejects each one. The
 * symptom is identical whatever you ask -- `request (41476 tokens) exceeds the available
 * context size` -- which reads as agentide being broken rather than as the model being too
 * small for it.
 *
 * So it is said in the list, before the download rather than after it. Qwen2.5 Coder 7B was
 * the model that taught this: 4.4GB fetched, installed, launched, and structurally unable to
 * answer a single turn.
 */
export function runsAgentide(model: LocalModel): boolean {
  return model.trainedContext >= MIN_CONTEXT;
}
