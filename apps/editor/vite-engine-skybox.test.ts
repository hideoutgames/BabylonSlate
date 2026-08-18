import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKYBOX_FACE_KEYS } from "@babylonslate/core";
import {
  copyEngineDefaultSkyboxFaces,
  ENGINE_DEFAULT_SKYBOX_FACE_FILES,
} from "./vite-engine-skybox";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("copyEngineDefaultSkyboxFaces", () => {
  it("copies the six cubemap PNGs into public/engine-content/skybox", { timeout: 20_000 }, () => {
    const dest = mkdtempSync(join(tmpdir(), "engine-skybox-"));
    try {
      copyEngineDefaultSkyboxFaces(REPO_ROOT, dest);
      expect([...ENGINE_DEFAULT_SKYBOX_FACE_FILES]).toEqual(
        SKYBOX_FACE_KEYS.map((key) => `${key}.png`),
      );
      for (const key of SKYBOX_FACE_KEYS) {
        const copied = readFileSync(
          join(dest, "engine-content/skybox", `${key}.png`),
        );
        const source = readFileSync(
          join(REPO_ROOT, "engine-content/skybox", `${key}.png`),
        );
        expect(copied).toEqual(source);
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
