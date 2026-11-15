import type { Plugin } from "vite";

/**
 * Babylon modules that only its WebGPU engine runs: that engine, its caches and extensions, and every WGSL shader.
 * Haptic creates WebGL2 Engines only, so the lazy imports Babylon keeps for them never run.
 */
const UNUSED_BABYLON_MODULE =
  /node_modules[\\/]@babylonjs[\\/]core[\\/](ShadersWGSL[\\/]|Engines[\\/](WebGPU[\\/]|webgpuEngine|thinWebGPUEngine)|Meshes[\\/]WebGPU[\\/]|Particles[\\/]computeShaderParticleSystem)/;

const EMPTY_MODULE = "\0haptic:unused-babylon-module";

export function isUnusedBabylonModule(id: string): boolean {
  return UNUSED_BABYLON_MODULE.test(id);
}

/**
 * Resolves Babylon's lazy imports of modules a WebGL2 game never runs (`isUnusedBabylonModule`) to an empty module, so
 * an exported game does not ship them. A module some other module imports statically is left alone: it is part of the
 * code that runs.
 */
export function leaveOutUnusedBabylonModules(): Plugin {
  return {
    name: "player-unused-babylon-modules",
    async resolveDynamicImport(source, importer) {
      if (typeof source !== "string") return null;
      const resolved = await this.resolve(source, importer);
      return resolved && isUnusedBabylonModule(resolved.id) ? EMPTY_MODULE : null;
    },
    resolveId(id) {
      return id === EMPTY_MODULE ? id : null;
    },
    load(id) {
      return id === EMPTY_MODULE ? "export {};" : null;
    },
  };
}
