import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKYBOX_FACE_KEYS } from "@babylonslate/core";
import { engineDefaultSkyboxFaceUrl } from "./faces";

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("engine-content default skybox faces", () => {
  it("ships six 512×512 PNG faces in Babylon CubeTexture order", () => {
    for (const key of SKYBOX_FACE_KEYS) {
      const bytes = new Uint8Array(
        readFileSync(join(REPO_ROOT, "engine-content/skybox", `${key}.png`)),
      );
      expect([...bytes.slice(0, 8)], key).toEqual(PNG_MAGIC);
      expect(pngSize(bytes), key).toEqual({ width: 512, height: 512 });
    }
  });

  it("maps faces to public URLs under engine-content/skybox", () => {
    expect(engineDefaultSkyboxFaceUrl("pz")).toMatch(
      /engine-content\/skybox\/pz\.png$/,
    );
    expect(engineDefaultSkyboxFaceUrl("px", "./")).toBe(
      "./engine-content/skybox/px.png",
    );
    expect(engineDefaultSkyboxFaceUrl("ny", "/BabylonSlate/")).toBe(
      "/BabylonSlate/engine-content/skybox/ny.png",
    );
  });
});
