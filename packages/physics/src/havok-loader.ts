/**
 * Loads `@babylonjs/havok`. With a hosted wasm URL in a browser, the module
 * compiles while it downloads (`WebAssembly.instantiateStreaming`), which also
 * lets the browser reuse its cached compiled code on the next Play; a host that
 * does not serve the file as `application/wasm` gets the downloaded bytes
 * instantiated instead. Node reads the package wasm. `locateFile` is always
 * supplied (engineplan §2.1).
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
      const locateFile = (path: string) => havokWasmUrl ?? path;
      if (havokWasmUrl && !isNode()) {
        // The Emscripten glue hands instantiation to `instantiateWasm`; a failure there
        // never settles its own promise, so it settles this race instead.
        let failed!: (error: unknown) => void;
        const failure = new Promise<never>((_, reject) => { failed = reject; });
        const module = HavokPhysics({
          locateFile,
          instantiateWasm: (imports, receive) => {
            instantiateHostedWasm(havokWasmUrl, imports).then(({ instance }) => receive(instance), failed);
            return {};
          },
        });
        return (await Promise.race([module, failure])) as unknown as HavokModule;
      }
      const wasmBinary = await resolveWasmBinary(havokWasmUrl);
      return (await HavokPhysics({ locateFile, wasmBinary })) as unknown as HavokModule;
    })().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Test helper: clear the module cache between suites. */
export function resetHavokModuleCache(): void {
  cached = null;
}

function isNode(): boolean {
  return Boolean((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node);
}

/**
 * Compile while downloading when the response is served as wasm; otherwise
 * (a host without the `application/wasm` type) instantiate the downloaded bytes.
 */
export async function instantiateHostedWasm(url: string, imports: WebAssembly.Imports): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const response = await fetchHavokWasm(url);
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type === "application/wasm" && typeof WebAssembly.instantiateStreaming === "function") {
    return WebAssembly.instantiateStreaming(response, imports);
  }
  return WebAssembly.instantiate(await response.arrayBuffer(), imports);
}

async function fetchHavokWasm(url: string): Promise<Response> {
  if (typeof fetch !== "function") {
    throw new Error(`Havok WASM download is unavailable: ${url}`);
  }
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Havok WASM request failed (${response.status}): ${url}`);
  }
  return response;
}

async function resolveWasmBinary(havokWasmUrl?: string): Promise<ArrayBuffer> {
  if (havokWasmUrl) return (await fetchHavokWasm(havokWasmUrl)).arrayBuffer();

  // Node / Vitest: resolve the package wasm without static `node:*` imports so
  // apps/editor typecheck (DOM-only libs) does not require @types/node.
  if (isNode()) {
    // Non-literal specifiers so apps/editor typecheck (types: vite/client)
    // does not resolve `node:*`. Native `import()` works in Vitest; `new
    // Function("return import(s)")` does not (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
    const nodePrefix = "node:";
    const nodeModule = (await import(/* @vite-ignore */ nodePrefix + "module")) as Record<
      string,
      unknown
    >;
    const nodeFs = (await import(/* @vite-ignore */ nodePrefix + "fs")) as Record<string, unknown>;
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
      // Copy into a standalone ArrayBuffer (Emscripten's `wasmBinary` type).
      return new Uint8Array(readFileSync(wasmPath)).buffer;
    }
  }

  throw new Error(
    "Havok wasm not found: pass PhysicsBackendOptions.havokWasmUrl",
  );
}
