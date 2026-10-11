import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { copyEngineDefaultSkyboxFaces } from "../editor/vite-engine-skybox";
import { previewDiagnosticsEntry } from "./vite-preview-diagnostics";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const editorPublic = path.join(repoRoot, "apps/editor/public");

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

function listRelativeFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listRelativeFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name !== "player-files.json") {
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

export default defineConfig({
  base: "./",
  plugins: [copyRuntimePublic(), previewDiagnosticsEntry(rootDir), writePlayerFileList()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        format: "es",
        codeSplitting: false,
        entryFileNames: "player.js",
        chunkFileNames: "player-[name].js",
        assetFileNames: "player-[name][extname]",
      },
    },
  },
  worker: {
    format: "es",
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
