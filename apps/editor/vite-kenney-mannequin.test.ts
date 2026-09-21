import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { kenneyMannequinVitePlugin } from "./vite-kenney-mannequin";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DIR = join(REPO_ROOT, "engine-content/kenney-assets/Mannequin");

describe("kenneyMannequinVitePlugin", () => {
  it("copies the bundled GLB during config resolution so the dev public-file snapshot sees it", () => {
    const dest = mkdtempSync(join(tmpdir(), "kenney-mannequin-"));
    try {
      const plugin = kenneyMannequinVitePlugin({
        sourceDir: SOURCE_DIR,
        publicDir: dest,
      });
      (plugin.configResolved as () => void)();
      expect(existsSync(join(dest, "mannequin.glb"))).toBe(true);
      expect(existsSync(join(dest, "mannequin.png"))).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
