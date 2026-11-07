import type { Plugin, Rolldown } from "vite";

/**
 * Code only a WebGPU Engine runs: Babylon's WebGPU engine, caches and extensions, every WGSL shader (the stages Babylon
 * imports lazily behind its WGSL branches included), and the render modules that load them on demand
 * (`webgpu-on-demand.ts`). The player puts it in `player-webgpu.js`, which a WebGL2 game never fetches.
 */
const WEBGPU_ONLY_MODULE =
  /node_modules[\\/]@babylonjs[\\/]core[\\/](ShadersWGSL[\\/]|Engines[\\/](WebGPU[\\/]|webgpuEngine|thinWebGPUEngine)|Meshes[\\/]WebGPU[\\/]|Particles[\\/]computeShaderParticleSystem)|packages[\\/]render[\\/]src[\\/]webgpu-(engine|registrations|cache-pruning|resource-release)\.ts$/;

/**
 * WebGPU-only modules that Babylon modules running on both backends import statically, so they stay in `player.js`:
 * `Materials/effectRenderer.js` imports both post-process vertex stages and `Compute/computeShader.pure.js` the WebGPU
 * performance counter. Review on a Babylon pin move.
 */
const IN_PLAYER_BUNDLE = ["@babylonjs/core/ShadersWGSL/postprocess.vertex.js", "@babylonjs/core/Engines/WebGPU/webgpuPerfCounter.js"];

export function isWebGpuOnlyModule(id: string): boolean {
  return WEBGPU_ONLY_MODULE.test(id);
}

function shortId(id: string): string {
  return id.replace(/\\/g, "/").replace(/^.*\/node_modules\//, "").replace(/^.*\/(packages|apps)\//, "$1/");
}

/**
 * Why this build would make a WebGL2 game fetch or run WebGPU code: `player.js` statically importing another file,
 * or holding a WebGPU-only module some module that runs on both backends imports statically.
 */
export function webGpuChunkProblems(bundle: Rolldown.OutputBundle, importersOf: (id: string) => readonly string[]): string[] {
  const entry = bundle["player.js"];
  if (entry?.type !== "chunk") return ["The player build emitted no player.js."];
  const problems = entry.imports.map((file) => `player.js statically imports ${file}, so every game fetches it at start.`);
  for (const id of Object.keys(entry.modules)) {
    if (!isWebGpuOnlyModule(id) || IN_PLAYER_BUNDLE.some((path) => id.replace(/\\/g, "/").endsWith(`/${path}`))) continue;
    const importers = importersOf(id).filter((importer) => !isWebGpuOnlyModule(importer)).map(shortId);
    problems.push(`${shortId(id)} is WebGPU-only but lands in player.js through ${importers.join(", ") || "an unknown importer"}; ` +
      "import it from packages/render/src/webgpu-registrations.ts instead.");
  }
  return problems;
}

/** Fails the build when a WebGL2 game would fetch WebGPU code ({@link webGpuChunkProblems}). */
export function webGpuChunkGuard(): Plugin {
  return {
    name: "player-webgpu-chunk-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const problems = webGpuChunkProblems(bundle, (id) => this.getModuleInfo(id)?.importers ?? []);
      if (problems.length) this.error(problems.join("\n"));
    },
  };
}
