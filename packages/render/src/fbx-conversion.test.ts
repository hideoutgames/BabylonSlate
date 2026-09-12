import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assimp from "assimpjs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseGlbForBrowse, splitGlbJsonBin } from "@babylonslate/assets";
import { convertFbxWithAssimp } from "./fbx-conversion";
import { createTestEngine } from "./create-null-engine";
import { loadModelContainer } from "./model-container";
import { fbxCoordinateMatrix } from "./fbx-coordinate-system";

let importer: Awaited<ReturnType<typeof assimp>>;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  importer = await assimp({
    wasmBinary: readFileSync(require.resolve("assimpjs/dist/assimpjs.wasm")),
  });
});
const fixture = (name: string) => ({
  name,
  bytes: new Uint8Array(
    readFileSync(new URL(`./__fixtures__/fbx/${name}`, import.meta.url)),
  ),
});

describe("FBX canonical conversion", () => {
  it("embeds selected texture sidecars and reports missing images instead of dropping them", () => {
    const file = fixture("maxPbrMaterial_metalRough.fbx");
    expect(() => convertFbxWithAssimp(importer, file)).toThrow(
      /Missing FBX texture/,
    );
    const texture = new Uint8Array(
      readFileSync(
        new URL("../../../e2e/fixtures/albedo.png", import.meta.url),
      ),
    );
    const bytes = convertFbxWithAssimp(importer, file, [
      { name: "albedo.png", bytes: texture },
    ]);
    const browse = parseGlbForBrowse(bytes)!;
    expect(browse.images[0]!.bytes).toEqual(texture);
    expect(
      browse.materials.some((material) => material.albedoImageIndex === 0),
    ).toBe(true);
    expect(
      (splitGlbJsonBin(bytes)!.json.images as { uri?: string }[]).every(
        (image) => !image.uri,
      ),
    ).toBe(true);
  });

  it("normalizes source centimeters and Z-up axes into glTF meters and Y-up", () => {
    const bytes = new TextEncoder().encode(`GlobalSettings: { Properties70: {
      P: "UnitScaleFactor", "double", "Number", "", 1
      P: "UpAxis", "int", "Integer", "", 2
      P: "FrontAxis", "int", "Integer", "", 1
      P: "FrontAxisSign", "int", "Integer", "", -1
    } }`);
    expect(fbxCoordinateMatrix(bytes)).toEqual([
      0.01, 0, 0, 0, 0, 0, -0.01, 0, 0, 0.01, 0, 0, 0, 0, 0, 1,
    ]);
    expect(fbxCoordinateMatrix(fixture("box.fbx").bytes)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
  });

  it("converts a static FBX into a loadable GLB model", async () => {
    const bytes = convertFbxWithAssimp(importer, fixture("box.fbx"));
    expect(parseGlbForBrowse(bytes)!.animations).toHaveLength(0);
    const handle = createTestEngine();
    try {
      const container = await loadModelContainer(
        handle.scene,
        bytes,
        "box.glb",
      );
      expect(container.meshes.some((mesh) => mesh.getTotalVertices() > 0)).toBe(
        true,
      );
      expect(handle.scene.animatables).toHaveLength(0);
      container.dispose();
    } finally {
      handle.scene.dispose();
      handle.engine.dispose();
    }
  });

  it("preserves a skeleton, joint weights and a playable animation", async () => {
    const bytes = convertFbxWithAssimp(
      importer,
      fixture("animation_with_skeleton.fbx"),
    );
    const json = splitGlbJsonBin(bytes)!.json;
    expect((json.skins as unknown[]).length).toBeGreaterThan(0);
    expect(
      parseGlbForBrowse(bytes)!.animations.some(
        (clip) => (clip.durationMs ?? 0) > 0,
      ),
    ).toBe(true);
    const handle = createTestEngine();
    try {
      const container = await loadModelContainer(
        handle.scene,
        bytes,
        "rig.glb",
      );
      expect(
        container.meshes.some(
          (mesh) =>
            mesh.skeleton && mesh.isVerticesDataPresent("matricesWeights"),
        ),
      ).toBe(true);
      expect(handle.scene.animatables).toHaveLength(0);
      const clip = container.animationGroups[0]!;
      clip.start(true);
      expect(clip.animatables.length).toBeGreaterThan(0);
      container.dispose();
    } finally {
      handle.scene.dispose();
      handle.engine.dispose();
    }
  });

  it("rejects malformed FBX instead of importing a different file from the batch", () => {
    expect(() =>
      convertFbxWithAssimp(
        importer,
        { name: "bad.fbx", bytes: new Uint8Array([1, 2, 3]) },
        [fixture("box.fbx")],
      ),
    ).toThrow(/FBX conversion failed/);
  });
});
