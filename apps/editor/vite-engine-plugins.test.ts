import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
      const index = JSON.parse(readFileSync(join(dest, "index.json"), "utf8")) as Array<{
        id: string;
        file: string;
      }>;
      expect(index.length).toBeGreaterThan(0);
      for (const entry of index) {
        expect(files).toContain(entry.file);
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
