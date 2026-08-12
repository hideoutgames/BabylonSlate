/**
 * Loads `@babylonjs/havok` with an explicit wasm binary so Node workers and
 * browsers both succeed. `locateFile` is always supplied (engineplan §2.1).
 */

export type HavokModule = {
  HP_World_Create: () => unknown;
  HP_World_Release: (world: unknown) => void;
  HP_World_SetGravity: (world: unknown, gravity: number[]) => void;
  HP_World_Step: (world: unknown, dt: number) => void;
};

let cached: Promise<HavokModule> | null = null;

export function loadHavokModule(havokWasmUrl?: string): Promise<HavokModule> {
  if (!cached) {
    cached = (async () => {
      const HavokPhysics = (await import("@babylonjs/havok")).default;
      const wasmBinary = await resolveWasmBinary(havokWasmUrl);
      return (await HavokPhysics({
        locateFile: (path: string) => havokWasmUrl ?? path,
        wasmBinary,
      })) as unknown as HavokModule;
    })();
  }
  return cached;
}

/** Test helper: clear the module cache between suites. */
export function resetHavokModuleCache(): void {
  cached = null;
}

async function resolveWasmBinary(havokWasmUrl?: string): Promise<Uint8Array> {
  if (havokWasmUrl && typeof fetch === "function") {
    try {
      const response = await fetch(havokWasmUrl);
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
    } catch {
      // fall through to filesystem resolve
    }
  }

  // Node / Vitest: resolve the package wasm without static `node:*` imports so
  // apps/editor typecheck (DOM-only libs) does not require @types/node.
  const g = globalThis as {
    process?: { versions?: { node?: string } };
  };
  if (g.process?.versions?.node) {
    const dynImport = new Function("s", "return import(s)") as (
      s: string,
    ) => Promise<Record<string, unknown>>;
    const nodeModule = await dynImport("node:module");
    const nodeFs = await dynImport("node:fs");
    const createRequire = nodeModule.createRequire as
      | ((url: string | URL) => {
          (id: string): string;
          resolve(id: string): string;
        })
      | undefined;
    const readFileSync = nodeFs.readFileSync as
      | ((path: string) => Uint8Array)
      | undefined;
    if (createRequire && readFileSync) {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve(
        "@babylonjs/havok/lib/esm/HavokPhysics.wasm",
      );
      return new Uint8Array(readFileSync(wasmPath));
    }
  }

  throw new Error(
    "Havok wasm not found: pass PhysicsBackendOptions.havokWasmUrl",
  );
}
