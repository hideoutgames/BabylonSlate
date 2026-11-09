import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { copyEngineDefaultSkyboxFaces } from "../editor/vite-engine-skybox";
import { havokHostedWasmVitePlugin } from "../editor/vite-havok-wasm";
import { rapierHostedWasmVitePlugin } from "../editor/vite-rapier-wasm";
import { recastHostedWasmVitePlugin } from "../editor/vite-recast-wasm";
import { bundledPackagesReport } from "./vite-bundled-packages";
import { createPlatformModules, platformModuleGroup, platformModules } from "./vite-platform-modules";
import { previewDiagnosticsEntry } from "./vite-preview-diagnostics";
import { isWebGpuOnlyModule, webGpuChunkGuard } from "./vite-webgpu-chunk";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const editorPublic = path.join(repoRoot, "apps/editor/public");
const bundledPackages = bundledPackagesReport({
  gamePackagesFile: path.join(repoRoot, "scripts/third-party-notices/game-packages.json"),
});
/** Platform modules of this build's page and worker, each in its own file that packaging can leave out. */
const platformModuleState = createPlatformModules();

/** The player cannot run without these tracked editor assets, so a missing one fails the build. */
function copyRequired(name: string, dest: string): void {
  const from = path.join(editorPublic, name);
  if (!existsSync(from)) {
    throw new Error(`Player runtime asset is missing: apps/editor/public/${name}`);
  }
  const to = path.join(dest, name);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function copyRuntimePublic(): Plugin {
  const dest = path.join(rootDir, "public");
  const copy = () => {
    for (const name of ["coi-serviceworker.js", "havok", "ktx2", "draco", "meshopt", "legal"]) {
      copyRequired(name, dest);
    }
    copyEngineDefaultSkyboxFaces(repoRoot, dest);
  };
  return {
    name: "copy-runtime-public",
    buildStart: copy,
    configureServer: copy,
  };
}

/** Files the editor fetches for the player. Dot-named markers (`ktx2/.keep`) are never player files. */
function listRelativeFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listRelativeFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name !== "player-files.json" && entry.name !== "bundled-packages.json") {
      out.push(rel);
    }
  }
  return out.sort();
}

function writePlayerFileList(): Plugin {
  return {
    name: "player-file-list",
    closeBundle() {
      const dist = path.join(rootDir, "dist");
      const files = listRelativeFiles(dist);
      writeFileSync(path.join(dist, "player-files.json"), `${JSON.stringify(files)}\n`);
    },
  };
}

/** Wasm runtimes the player page imports only on demand; everything else is in `player.js` or `player-webgpu.js`. */
const PAGE_ON_DEMAND_RUNTIME = /node_modules[\\/](@dimforge[\\/]rapier2d[^\\/]*|@babylonjs[\\/]havok|@recast-navigation[\\/]wasm)[\\/]/;

export default defineConfig({
  base: "./",
  plugins: [
    copyRuntimePublic(),
    havokHostedWasmVitePlugin(),
    rapierHostedWasmVitePlugin(),
    recastHostedWasmVitePlugin(),
    previewDiagnosticsEntry(rootDir),
    bundledPackages.main,
    writePlayerFileList(),
    webGpuChunkGuard(),
    platformModules(platformModuleState, { writeList: true }),
  ],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        format: "es",
        // Two player bundles. `player.js` holds every module a WebGL2 game runs, Babylon's lazily
        // imported shaders and loaders included. `player-webgpu.js` holds the WebGPU engine and every
        // WGSL shader, which only a WebGPU game loads (`isWebGpuOnlyModule`; `webGpuChunkGuard` fails
        // the build if `player.js` would still import any of it). Main is matched first, so a module
        // that WebGL2 code imports statically stays in `player.js` with everything it imports.
        // The wasm runtimes the page itself loads on demand (Rapier 2D, Havok and Recast for the
        // in-process fallback and navigation debug) stay separate files, so a game that never needs
        // them never downloads them. Their names keep `rapier` / `havok`, which
        // `selectPlayerRuntimeFiles` uses to leave an unused engine out of an export. Each platform module's
        // condition gets a file of its own (`platform-modules.json`), which packaging leaves out for other platforms.
        codeSplitting: {
          groups: [
            platformModuleGroup(platformModuleState),
            {
              name: "main",
              test: (id: string) => !PAGE_ON_DEMAND_RUNTIME.test(id) && !isWebGpuOnlyModule(id) && !platformModuleState.conditions.has(id),
            },
            { name: "webgpu", test: isWebGpuOnlyModule },
          ],
        },
        entryFileNames: "player.js",
        chunkFileNames: "player-[name].js",
        assetFileNames: "player-[name][extname]",
      },
    },
  },
  worker: {
    format: "es",
    plugins: () => [
      havokHostedWasmVitePlugin(), rapierHostedWasmVitePlugin(), recastHostedWasmVitePlugin(), bundledPackages.worker(),
      platformModules(platformModuleState, { writeList: false }),
    ],
    rolldownOptions: {
      output: {
        entryFileNames: "worker-[name].js",
        codeSplitting: { groups: [platformModuleGroup(platformModuleState)] },
      },
    },
  },
  // Localhost only by default; `--host` opts in to LAN access (see README).
  server: {
    port: 5174,
  },
});
