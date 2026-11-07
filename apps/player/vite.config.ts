import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { copyEngineDefaultSkyboxFaces } from "../editor/vite-engine-skybox";
import { havokHostedWasmVitePlugin } from "../editor/vite-havok-wasm";
import { rapierHostedWasmVitePlugin } from "../editor/vite-rapier-wasm";
import { bundledPackagesReport } from "./vite-bundled-packages";
import { previewDiagnosticsEntry } from "./vite-preview-diagnostics";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const editorPublic = path.join(repoRoot, "apps/editor/public");
const bundledPackages = bundledPackagesReport({
  gamePackagesFile: path.join(repoRoot, "scripts/third-party-notices/game-packages.json"),
});

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

/** Wasm runtimes the player page imports only on demand; everything else is in `player.js`. */
const PAGE_ON_DEMAND_RUNTIME = /node_modules[\\/](@dimforge[\\/]rapier2d[^\\/]*|@babylonjs[\\/]havok|@recast-navigation[\\/]wasm)[\\/]/;

export default defineConfig({
  base: "./",
  plugins: [copyRuntimePublic(), havokHostedWasmVitePlugin(), rapierHostedWasmVitePlugin(), previewDiagnosticsEntry(rootDir), bundledPackages.main, writePlayerFileList()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        format: "es",
        // One player bundle: every module, Babylon's lazily imported shaders and loaders included,
        // goes into `player.js`. Only the wasm runtimes the page itself loads on demand (Rapier 2D,
        // Havok and Recast for the in-process fallback and navigation debug) stay separate files, so a
        // game that never needs them never downloads them. Their names keep `rapier` / `havok`, which
        // `selectPlayerRuntimeFiles` uses to leave an unused engine out of an export.
        codeSplitting: {
          groups: [{ name: "main", test: (id: string) => !PAGE_ON_DEMAND_RUNTIME.test(id) }],
        },
        entryFileNames: "player.js",
        chunkFileNames: "player-[name].js",
        assetFileNames: "player-[name][extname]",
      },
    },
  },
  worker: {
    format: "es",
    plugins: () => [havokHostedWasmVitePlugin(), rapierHostedWasmVitePlugin(), bundledPackages.worker()],
    rolldownOptions: {
      output: {
        entryFileNames: "worker-[name].js",
      },
    },
  },
  // Localhost only by default; `--host` opts in to LAN access (see README).
  server: {
    port: 5174,
  },
});
