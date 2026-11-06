import { describe, expect, it } from "vitest";
import type { OutputBundle } from "vite";
import { webGpuChunkProblems } from "./vite-webgpu-chunk";

const babylon = (path: string) => `/repo/node_modules/.pnpm/@babylonjs+core@9.29.0/node_modules/@babylonjs/core/${path}`;
const render = (file: string) => `/repo/packages/render/src/${file}`;

function bundle(modules: string[], imports: string[] = []): OutputBundle {
  return {
    "player.js": { type: "chunk", fileName: "player.js", imports, modules: Object.fromEntries(modules.map((id) => [id, {}])) },
    "player-webgpu.js": { type: "chunk", fileName: "player-webgpu.js", imports: ["player.js"], modules: { [babylon("Engines/webgpuEngine.js")]: {} } },
  } as unknown as OutputBundle;
}

describe("webGpuChunkProblems", () => {
  it("accepts a player.js whose only WebGPU modules are the ones Babylon's both-backend modules import", () => {
    const modules = [babylon("Materials/effectRenderer.js"), babylon("ShadersWGSL/postprocess.vertex.js"),
      babylon("Compute/computeShader.pure.js"), babylon("Engines/WebGPU/webgpuPerfCounter.js"), babylon("Shaders/default.vertex.js"),
      render("create-engine.ts"), render("webgpu-on-demand.ts"), render("webgpu-pipeline-deferral.ts")];
    expect(webGpuChunkProblems(bundle(modules), () => [])).toEqual([]);
  });

  it("rejects a WebGPU-only module in player.js and names the both-backend module that imports it", () => {
    const importers: Record<string, string[]> = {
      [babylon("ShadersWGSL/ShadersInclude/helperFunctions.js")]: [render("scene-fog-block.ts"), render("webgpu-registrations.ts")],
      [render("webgpu-engine.ts")]: [render("backend-engine-session.ts")],
    };
    const problems = webGpuChunkProblems(bundle([render("scene-fog-block.ts"), ...Object.keys(importers)]), (id) => importers[id] ?? []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("@babylonjs/core/ShadersWGSL/ShadersInclude/helperFunctions.js is WebGPU-only but lands in player.js through packages/render/src/scene-fog-block.ts;");
    expect(problems[1]).toContain("packages/render/src/webgpu-engine.ts is WebGPU-only but lands in player.js through packages/render/src/backend-engine-session.ts;");
  });

  it("rejects a player.js that statically imports another file", () => {
    expect(webGpuChunkProblems(bundle([render("create-engine.ts")], ["player-webgpu.js"]), () => [])).toEqual([
      "player.js statically imports player-webgpu.js, so every game fetches it at start.",
    ]);
  });
});
