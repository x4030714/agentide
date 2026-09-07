/**
 * Which model fits, and what gets written when one is chosen.
 *
 * The fitting rules are the part with judgement in them, and getting them wrong is
 * expensive in a way tests are cheap: a model called a fit and then failing to load wastes
 * a 17GB download, and one called too big that would have run fine is a capability quietly
 * withheld.
 */

import { describe, expect, test } from "vitest";

import {
  contextFor,
  fitsIn,
  fitLabel,
  installScript,
  LOCAL_MODELS,
  modelUrl,
  portFor,
  providerEntry,
  runsAgentide,
  startCommandFor,
} from "./local-models";
import type { LocalModel } from "./local-models";

const dense = (gigabytes: number, trainedContext = 262_144): LocalModel => ({
  id: "dense",
  name: "Dense",
  repo: "x/y",
  file: "y.gguf",
  gigabytes,
  trainedContext,
  mixture: false,
  note: "",
});

const mixture = (gigabytes: number): LocalModel => ({ ...dense(gigabytes), mixture: true });

describe("the catalogue", () => {
  test("every entry names a real file and a size", () => {
    // Read from the Hugging Face API rather than remembered: a wrong filename is a 404 at
    // the end of a long download.
    for (const model of LOCAL_MODELS) {
      expect(model.file).toMatch(/\.gguf$/);
      expect(model.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(model.gigabytes).toBeGreaterThan(0);
    }
  });

  test("ids are unique, since one becomes a provider key and a directory", () => {
    const ids = LOCAL_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no entry is a sharded repository", () => {
    // `startDownload` fetches one file. A repo that splits its weights across
    // `-00001-of-00005` parts would download one fifth of a model and report it complete,
    // which is the worst kind of failure: it looks finished.
    for (const model of LOCAL_MODELS) {
      expect(model.file).not.toMatch(/-\d{5}-of-\d{5}/);
    }
  });

  test("no entry is an auxiliary file rather than the weights", () => {
    // `mmproj` is a vision projector and `mtp` a prediction head; both sit in the same
    // repositories and are a tenth of the size, so picking by size alone finds them.
    for (const model of LOCAL_MODELS) {
      expect(model.file).not.toMatch(/mmproj|^mtp-/i);
      expect(model.gigabytes).toBeGreaterThan(1);
    }
  });

  test("more than one family is offered", () => {
    // A list of one vendor's models is a preference dressed as a catalogue.
    const families = new Set(LOCAL_MODELS.map((model) => model.id.split("-")[0]));
    expect(families.size).toBeGreaterThanOrEqual(3);
  });

  test("something on the list fits a small card", () => {
    // A list where nothing runs on an 8GB GPU is a list that helps nobody who has one.
    expect(LOCAL_MODELS.some((model) => fitsIn(model, 8) === "vram")).toBe(true);
  });

  test("the download URL points at the file in its repository", () => {
    expect(modelUrl(LOCAL_MODELS[0]!)).toBe(
      `https://huggingface.co/${LOCAL_MODELS[0]!.repo}/resolve/main/${LOCAL_MODELS[0]!.file}?download=true`,
    );
  });
});

describe("fitting", () => {
  test("a model plus its context fits, or it does not", () => {
    // Counting only the file would call something a fit and then fail at load, which is
    // the worst moment to find out.
    expect(fitsIn(dense(4.4), 8)).toBe("vram");
    expect(fitsIn(dense(7), 8)).toBe("spills");
  });

  test("a mixture of experts tolerates spilling where a dense model does not", () => {
    // Only a few billion parameters are active per token, so the part in system RAM is
    // touched far less often.
    expect(fitsIn(mixture(17.3), 8)).toBe("spills");
    expect(fitsIn(dense(17.3), 8)).toBe("too-big");
  });

  test("something far past the card is too big whatever its shape", () => {
    expect(fitsIn(mixture(60), 8)).toBe("too-big");
  });

  test("no GPU means everything spills, which is honest rather than discouraging", () => {
    expect(fitsIn(dense(4.4), null)).toBe("spills");
    expect(fitLabel(fitsIn(dense(4.4), null))).toMatch(/slower/);
  });

  test("a big card fits the big models", () => {
    expect(fitsIn(mixture(20.6), 24)).toBe("vram");
  });
});

describe("context size", () => {
  test("never below what agentide's own prompt needs", () => {
    // Measured: a turn whose message was "hi" sent 41,476 tokens of prefix. A 32k window
    // does not degrade against that, it refuses every request -- so the floor holds even
    // when the card has no room for it, because slow beats not working.
    expect(contextFor(dense(7.5), 8)).toBe(65_536);
    expect(contextFor(dense(4.4), null)).toBe(65_536);
    expect(contextFor(dense(20), 8)).toBe(65_536);
  });

  test("grows when there is real room for it", () => {
    expect(contextFor(dense(4.4), 24)).toBe(131_072);
  });

  test("every model that can run agentide gets a window its prompt fits in", () => {
    // 41,476 tokens was one measurement on one machine; the floor has to clear it with
    // room for an actual conversation on top. The exception is a model whose own trained
    // context is below that -- it cannot be given a bigger window by anyone, which is why
    // `runsAgentide` exists and why the list says so before the download rather than after.
    for (const model of LOCAL_MODELS.filter(runsAgentide)) {
      expect(contextFor(model, 8)).toBeGreaterThan(41_476);
    }
  });
});

describe("what the model itself allows", () => {
  test("the context never exceeds what the weights were trained for", () => {
    // llama.cpp does not refuse a larger request, it caps it and says so in one line. A
    // config asking for more would look applied and change nothing.
    expect(contextFor(dense(4.4, 32_768), 24)).toBe(32_768);
    expect(contextFor(dense(4.4, 131_072), 24)).toBe(131_072);
  });

  test("a model too small for the prompt is marked, not offered", () => {
    // Qwen2.5 Coder 7B taught this: 4.4GB fetched, installed, launched, and structurally
    // unable to answer one turn. Every request exceeds its window whatever you ask.
    expect(runsAgentide(dense(4.4, 32_768))).toBe(false);
    expect(runsAgentide(dense(4.4, 65_536))).toBe(true);
  });

  test("every model in the catalogue reports a real trained context", () => {
    // Read from the Hugging Face GGUF metadata per model. A guessed one is a download that
    // cannot work, discovered after the download.
    for (const model of LOCAL_MODELS) {
      expect(model.trainedContext).toBeGreaterThanOrEqual(32_768);
    }
  });

  test("all but one of the catalogue can actually run agentide", () => {
    // If this ever fails the list has drifted towards models that cannot drive the IDE,
    // which is the failure the whole panel exists to prevent.
    const usable = LOCAL_MODELS.filter(runsAgentide);
    expect(usable.length).toBeGreaterThanOrEqual(LOCAL_MODELS.length - 1);
  });
});

describe("the port a model listens on", () => {
  test("is the same every time, so a reinstall does not move it", () => {
    const model = LOCAL_MODELS[0]!;
    expect(portFor(model)).toBe(portFor(model));
  });

  test("follows the id, not the position in the list", () => {
    // A position-derived port moves when the catalogue is reordered: a model installed
    // last month keeps the port it was written with while a newly installed one is handed
    // the same number, and then two entries gate on one port.
    const moved = { ...LOCAL_MODELS[0]!, id: LOCAL_MODELS[0]!.id };
    expect(portFor(moved)).toBe(portFor(LOCAL_MODELS[0]!));
    expect(portFor({ ...moved, id: "something-else" })).not.toBe(portFor(moved));
  });

  test("no two models in the catalogue collide", () => {
    // The collision this exists to prevent, checked against the list that actually ships.
    const ports = LOCAL_MODELS.map(portFor);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test("stays in a range nothing else is using", () => {
    for (const model of LOCAL_MODELS) {
      expect(portFor(model)).toBeGreaterThanOrEqual(8080);
      expect(portFor(model)).toBeLessThan(8180);
    }
  });
});

describe("the command that runs a model", () => {
  const home = "C:/Users/dev";
  const model = LOCAL_MODELS.find((entry) => entry.id === "qwen25-coder-7b")!;

  test("begins with PowerShell's call operator", () => {
    // A quoted path in the first position is a string expression, not a command. Without
    // `&` this does not fail to find the program, it fails to parse -- and the only symptom
    // is the gate reporting that the backend never came up.
    expect(startCommandFor(home, model, 8080, 65_536)).toMatch(/^& "/);
  });

  test("names the engine, the weights, the context and the port", () => {
    const command = startCommandFor(home, model, 8143, 65_536);
    expect(command).toContain(`${home}/.agentide/engine/llama-server.exe`);
    expect(command).toContain(`${home}/.agentide/models/${model.file}`);
    expect(command).toContain("-c 65536");
    expect(command).toContain("--port 8143");
  });

  test("binds to localhost only", () => {
    // llama.cpp binds every interface by default, and a model server reachable from the
    // network is not what "run a model locally" asked for.
    expect(startCommandFor(home, model, 8080, 65_536)).toContain("--host 127.0.0.1");
  });

  test("matches the shape the sidecar builds from the same fields", () => {
    // This string exists in two places -- here and `sidecar/src/provider-config.ts` -- so
    // that a model installed mid-session can be launched before the sidecar has read the
    // file. They have to agree, and this is the reminder that a change here needs a change
    // there.
    expect(startCommandFor(home, model, 8080, 65_536)).toBe(
      `& "${home}/.agentide/engine/llama-server.exe" -m "${home}/.agentide/models/${model.file}" -c 65536 --port 8080 --host 127.0.0.1`,
    );
  });
});

describe("the install script", () => {
  const home = "C:/Users/dev";
  const model = LOCAL_MODELS.find((entry) => entry.id === "qwen25-coder-7b")!;

  test("skips the engine when it is already there", () => {
    // Pressing the button twice must not download it twice, and a failed run has to be
    // resumable rather than a restart.
    const script = installScript(home, model, true);
    expect(script).toContain(`if (Test-Path "${home}/.agentide/engine/llama-server.exe")`);
  });

  test("skips the model when it is already there", () => {
    expect(installScript(home, model, true)).toContain(
      `if (Test-Path "${home}/.agentide/models/${model.file}")`,
    );
  });

  test("resumes a partial download rather than starting over", () => {
    // 17GB restarting because a laptop slept is the difference between a feature and a
    // nuisance.
    expect(installScript(home, model, true)).toContain("curl.exe -L -C -");
  });

  test("resolves the llama.cpp version at run time", () => {
    // Releases are tagged per build. A pinned URL rots, and rots into a 404 at the start
    // of a long operation.
    const script = installScript(home, model, true);
    expect(script).toContain("api.github.com/repos/ggml-org/llama.cpp/releases");
    expect(script).not.toMatch(/llama-b\d+-bin/);
  });

  test("looks past a release that carries no binaries", () => {
    // The newest release is sometimes a nightly tag with one text file attached.
    expect(installScript(home, model, true)).toContain("foreach ($r in $releases)");
  });

  test("fetches the CUDA runtime with the CUDA build, and not otherwise", () => {
    // llama-server will not start without those DLLs unless the full toolkit is
    // installed, which it usually is not.
    expect(installScript(home, model, true)).toContain("cudart-");
    expect(installScript(home, model, false)).not.toContain("cudart-");
  });

  test("asks for a CPU build when there is no CUDA card", () => {
    expect(installScript(home, model, false)).toContain("bin-win-cpu-x64");
    expect(installScript(home, model, true)).toContain("bin-win-cuda-13");
  });

  test("stops at the first failure rather than carrying on", () => {
    expect(installScript(home, model, true)).toContain('$ErrorActionPreference = "Stop"');
  });

  test("says what to do when it finishes", () => {
    expect(installScript(home, model, true)).toContain(`pick ${model.name} from the Model menu`);
  });
});

describe("what gets written", () => {
  const home = "C:/Users/dev";
  const model = LOCAL_MODELS.find((entry) => entry.id === "qwen25-coder-7b")!;

  test("the entry points at where the download will land", () => {
    // Written before the download finishes: the entry is gated on its port, so until
    // llama.cpp is running it reports as not answering, which is the truth.
    const entry = providerEntry(home, model, 8080, 65_536);
    expect(entry.model).toBe(`${home}/.agentide/models/${model.file}`);
    expect(entry.engine).toBe(`${home}/.agentide/engine/llama-server.exe`);
    expect(entry.port).toBe(8080);
    expect(entry.contextLength).toBe(65_536);
  });

  test("the note says what the model is for", () => {
    expect(String(providerEntry(home, model, 8080, 32_768).note)).toContain(model.name);
  });

  test("it is the shape providers.json accepts", () => {
    // The same fields `provider-config.ts` parses. A key it does not know is refused
    // outright, so an entry built here has to stay inside that schema.
    const entry = providerEntry(home, model, 8080, 32_768);
    expect(Object.keys(entry).sort()).toEqual(
      ["contextLength", "engine", "model", "note", "port"].sort(),
    );
  });
});
