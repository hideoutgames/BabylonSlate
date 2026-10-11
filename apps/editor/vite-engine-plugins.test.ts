import { EventEmitter } from "node:events";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enginePluginsVitePlugin } from "./vite-engine-plugins";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("enginePluginsVitePlugin", () => {
  it("packs engine plugins during config resolution so the dev public-file snapshot sees them", async () => {
    const dest = mkdtempSync(join(tmpdir(), "engine-plugins-"));
    try {
      const plugin = enginePluginsVitePlugin({
        sourceDir: join(REPO_ROOT, "engine-plugins"),
        publicDir: dest,
      });
      await (plugin.configResolved as () => Promise<void>)();
      const files = readdirSync(dest);
      expect(files).toContain("index.json");
      const index = JSON.parse(readFileSync(join(dest, "index.json"), "utf8")) as {
        version: number; plugins: Array<{ id: string; file: string }>;
        files: Array<{ path: string; parts: Array<{ file: string }> }>;
      };
      expect(index.plugins.length).toBeGreaterThan(0);
      for (const entry of index.plugins) {
        expect(files).toContain(entry.file);
      }
      for (const file of index.files) {
        expect(file.parts.length).toBeGreaterThan(0);
        for (const part of file.parts) expect(readFileSync(join(dest, part.file)).byteLength).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("rebuilds the catalog when a watched engine plugin file changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "engine-plugins-watch-"));
    try {
      const sourceDir = join(root, "source");
      const publicDir = join(root, "public");
      cpSync(join(REPO_ROOT, "engine-plugins"), sourceDir, { recursive: true });
      const plugin = enginePluginsVitePlugin({ sourceDir, publicDir });
      await (plugin.configResolved as () => Promise<void>)();
      const watcher = Object.assign(new EventEmitter(), { add: () => undefined });
      const errors: string[] = [];
      (plugin.configureServer as (server: unknown) => void)({
        watcher,
        config: { logger: { error: (message: string) => errors.push(message) } },
      });
      const [id] = readdirSync(sourceDir);
      const added = join(sourceDir, id!, "notes.txt");
      writeFileSync(added, "notes");
      watcher.emit("all", "add", added);
      await new Promise((resolve) => setImmediate(resolve));
      const index = JSON.parse(readFileSync(join(publicDir, "index.json"), "utf8")) as {
        files: Array<{ path: string }>;
      };
      expect(errors).toEqual([]);
      expect(index.files.map((file) => file.path)).toContain(`${id}/notes.txt`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
