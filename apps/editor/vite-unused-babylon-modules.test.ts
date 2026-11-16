import { describe, expect, it } from "vitest";
import { leaveOutUnusedBabylonModules } from "./vite-unused-babylon-modules";

const babylon = (path: string) => `/repo/node_modules/.pnpm/@babylonjs+core@9.29.0/node_modules/@babylonjs/core/${path}`;

type Hooks = {
  resolveDynamicImport(this: { resolve(source: string): Promise<{ id: string } | null> }, source: unknown, importer?: string): Promise<string | null>;
  load(id: string): string | null;
};

/** The id a lazy import of `id` resolves to, and the source that id loads as. */
async function lazyImport(id: string | null) {
  const plugin = leaveOutUnusedBabylonModules() as unknown as Hooks;
  const resolved = await plugin.resolveDynamicImport.call({ resolve: async () => (id ? { id } : null) }, "./specifier", babylon("Materials/effect.js"));
  return { resolved, source: resolved === null ? null : plugin.load(resolved) };
}

describe("leaveOutUnusedBabylonModules", () => {
  it.each([
    "ShadersWGSL/default.vertex.js", "ShadersWGSL/ShadersInclude/helperFunctions.js", "Engines/webgpuEngine.js",
    "Engines/thinWebGPUEngine.js", "Engines/WebGPU/webgpuCacheRenderPipeline.js", "Meshes/WebGPU/webgpuDataBuffer.js",
    "Particles/computeShaderParticleSystem.js",
  ])("loads a lazy import of %s as an empty module", async (path) => {
    const { resolved, source } = await lazyImport(babylon(path));
    expect(resolved).not.toBeNull();
    expect(source).toBe("export {};");
  });

  it.each([
    babylon("Shaders/default.vertex.js"), babylon("Engines/engine.js"), babylon("Particles/gpuParticleSystem.js"),
    "/repo/packages/render/src/create-engine.ts", null,
  ])("leaves a lazy import of %s to the other resolvers", async (id) => {
    expect(await lazyImport(id)).toEqual({ resolved: null, source: null });
  });

  it("leaves every other module's source alone", () => {
    expect((leaveOutUnusedBabylonModules() as unknown as Hooks).load(babylon("Shaders/default.vertex.js"))).toBeNull();
  });
});
