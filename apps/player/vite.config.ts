import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const editorPublic = path.join(repoRoot, "apps/editor/public");

function copyIfPresent(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function copyRuntimePublic(): Plugin {
  const dest = path.join(rootDir, "public");
  const copy = () => {
    copyIfPresent(
      path.join(editorPublic, "coi-serviceworker.js"),
      path.join(dest, "coi-serviceworker.js"),
    );
    copyIfPresent(path.join(editorPublic, "havok"), path.join(dest, "havok"));
    copyIfPresent(path.join(editorPublic, "ktx2"), path.join(dest, "ktx2"));
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
  plugins: [copyRuntimePublic(), writePlayerFileList()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: "es",
        inlineDynamicImports: true,
        entryFileNames: "player.js",
        chunkFileNames: "player-[name].js",
        assetFileNames: "player-[name][extname]",
      },
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        entryFileNames: "worker-[name].js",
      },
    },
  },
  server: {
    host: true,
    port: 5174,
  },
});
