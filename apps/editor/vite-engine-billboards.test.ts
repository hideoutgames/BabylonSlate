import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_BILLBOARD_FILES } from "../../packages/render/src/default-billboard/urls";
import {
  copyEngineBillboards,
  engineBillboardsVitePlugin,
} from "./vite-engine-billboards";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("copyEngineBillboards", () => {
  it("copies editor billboard PNGs into public/engine-content/billboards", {
    timeout: 20_000,
  }, () => {
    const dest = mkdtempSync(join(tmpdir(), "engine-billboards-"));
    try {
      copyEngineBillboards(REPO_ROOT, dest);
      for (const file of ENGINE_BILLBOARD_FILES) {
        const copied = readFileSync(
          join(dest, "engine-content/billboards", file),
        );
        const source = readFileSync(
          join(REPO_ROOT, "engine-content/billboards", file),
        );
        expect(copied).toEqual(source);
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("copies billboards during config resolution so the dev public-file snapshot sees them", () => {
    const dest = mkdtempSync(join(tmpdir(), "engine-billboards-"));
    try {
      const plugin = engineBillboardsVitePlugin(REPO_ROOT, dest);
      (plugin.configResolved as () => void)();
      for (const file of ENGINE_BILLBOARD_FILES) {
        expect(
          readFileSync(join(dest, "engine-content/billboards", file)).byteLength,
        ).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
