import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_BILLBOARD_FILES } from "../../packages/render/src/default-billboard/urls";
import { copyEngineBillboards } from "./vite-engine-billboards";

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
});
