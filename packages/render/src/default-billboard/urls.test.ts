import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_BILLBOARD_FILES, engineBillboardUrl } from "./urls";

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("engine-content editor billboards", () => {
  it("ships PNG icons for default, lights, camera, audio, particles, and navmesh", () => {
    for (const file of ENGINE_BILLBOARD_FILES) {
      const bytes = new Uint8Array(
        readFileSync(join(REPO_ROOT, "engine-content/billboards", file)),
      );
      expect([...bytes.slice(0, 8)], file).toEqual(PNG_MAGIC);
    }
  });

  it("maps icon names to public URLs under engine-content/billboards", () => {
    expect(engineBillboardUrl("default")).toMatch(
      /engine-content\/billboards\/default\.png$/,
    );
    expect(engineBillboardUrl("point_light", "./")).toBe(
      "./engine-content/billboards/point_light.png",
    );
    expect(engineBillboardUrl("navmesh", "/BabylonSlate/")).toBe(
      "/BabylonSlate/engine-content/billboards/navmesh.png",
    );
  });
});
