import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { FBXFileLoader } from "@babylonjs/loaders/FBX/fbxFileLoader";
import { parseGlbForBrowse, splitGlbJsonBin } from "@haptic/assets";
import { convertFbxToGlb } from "./fbx-conversion";
import { createTestEngine } from "./test-support/test-engine";
import { loadModelContainer } from "./model-container";

const fixture = (name: string) => ({
  name,
  bytes: new Uint8Array(
    readFileSync(new URL(`./__fixtures__/fbx/${name}`, import.meta.url)),
  ),
});

async function withModel<T>(
  bytes: Uint8Array,
  inspect: (container: Awaited<ReturnType<typeof loadModelContainer>>) => T,
): Promise<T> {
  const handle = createTestEngine();
  try {
    const container = await loadModelContainer(handle.scene, bytes, "model.glb");
    try {
      return inspect(container);
    } finally {
      container.dispose();
    }
  } finally {
    handle.scene.dispose();
    handle.engine.dispose();
  }
}

/** World-space bounds of the drawable meshes, rounded to millimeters. */
function bounds(container: Awaited<ReturnType<typeof loadModelContainer>>) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of container.meshes.filter((entry) => entry.getTotalVertices() > 0)) {
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    box.minimumWorld.asArray().forEach((value, axis) => (min[axis] = Math.min(min[axis]!, value)));
    box.maximumWorld.asArray().forEach((value, axis) => (max[axis] = Math.max(max[axis]!, value)));
  }
  const round = (values: number[]) => values.map((value) => Math.round(value * 1000) / 1000);
  return { min: round(min), max: round(max) };
}

/** World bounds (min xyz, max xyz) of the skinned vertices at rest and halfway through `clip`. */
function skinnedBoundsAtRestAndMidClip(
  meshes: readonly AbstractMesh[],
  clip: AnimationGroup,
): { rest: number[]; midClip: number[] } {
  const bounds = () => {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of meshes) {
      if (!mesh.skeleton || mesh.getTotalVertices() === 0) continue;
      mesh.skeleton.prepare(true);
      const world = mesh.computeWorldMatrix(true);
      const data = mesh.getPositionData(true, false)!;
      for (let index = 0; index < data.length; index += 3) {
        const point = Vector3.TransformCoordinates(Vector3.FromArray(data, index), world);
        min.minimizeInPlace(point);
        max.maximizeInPlace(point);
      }
    }
    return [...min.asArray(), ...max.asArray()];
  };
  const rest = bounds();
  clip.start(false);
  clip.goToFrame(clip.from + (clip.to - clip.from) / 2);
  clip.pause();
  return { rest, midClip: bounds() };
}

describe("FBX canonical conversion", () => {
  it("embeds selected texture sidecars and reports missing images instead of dropping them", async () => {
    const file = fixture("maxPbrMaterial_metalRough.fbx");
    await expect(convertFbxToGlb(file)).rejects.toThrow(/Missing FBX texture/);
    const texture = new Uint8Array(
      readFileSync(new URL("../../../e2e/fixtures/albedo.png", import.meta.url)),
    );
    const sidecars = ["albedo", "occlusion", "opacity", "emission", "roughness", "normal"].map(
      (name) => ({ name: `${name}.png`, bytes: texture }),
    );
    const consumed = new Set<string>();
    const bytes = await convertFbxToGlb(file, sidecars, consumed);
    expect(consumed).toEqual(new Set(sidecars.map((sidecar) => sidecar.name)));
    const browse = parseGlbForBrowse(bytes)!;
    const albedo = browse.materials[0]!.albedoImageIndex!;
    expect(browse.images[albedo]!.bytes).toEqual(texture);
    expect(
      (splitGlbJsonBin(bytes)!.json.images as { uri?: string }[]).every((image) => !image.uri),
    ).toBe(true);
  });

  it("converts a static FBX into a loadable GLB in Y-up meters", async () => {
    const bytes = await convertFbxToGlb(fixture("box.fbx"));
    expect(parseGlbForBrowse(bytes)!.animations).toHaveLength(0);
    // Bounds match the previous AssimpJS conversion of this fixture.
    expect(await withModel(bytes, bounds)).toEqual({
      min: [-0.284, -0.162, -0.065],
      max: [0.226, 0.244, 0.465],
    });
  });

  it("preserves a skeleton, joint weights and a playable animation", async () => {
    const bytes = await convertFbxToGlb(fixture("animation_with_skeleton.fbx"));
    expect((splitGlbJsonBin(bytes)!.json.skins as unknown[]).length).toBeGreaterThan(0);
    expect(parseGlbForBrowse(bytes)!.animations).toEqual([
      expect.objectContaining({ name: "Armature|ArmatureAction", durationMs: expect.closeTo(833.33, 1) }),
    ]);
    await withModel(bytes, (container) => {
      expect(
        container.meshes.some(
          (mesh) => mesh.skeleton && mesh.isVerticesDataPresent("matricesWeights"),
        ),
      ).toBe(true);
      const clip = container.animationGroups[0]!;
      clip.start(true);
      expect(clip.animatables.length).toBeGreaterThan(0);
    });
  });

  it("keeps a skinned mesh on its skeleton, at rest and mid-clip, as Babylon draws the FBX itself", async () => {
    // The fixture's mesh and armature sit under differently scaled nodes; exported unchanged, glTF drew the mesh at a
    // tenth of its skeleton's size, since glTF skins in world space and Babylon in the mesh's.
    const source = fixture("animation_with_skeleton.fbx");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    let fbx: { rest: number[]; midClip: number[] };
    try {
      const container = await new FBXFileLoader({ materials: "pbr", unitScale: "meters" })
        .loadAssetContainerAsync(scene, source.bytes.slice().buffer, "file:");
      container.addAllToScene();
      fbx = skinnedBoundsAtRestAndMidClip(container.meshes, container.animationGroups[0]!);
    } finally {
      scene.dispose();
      engine.dispose();
    }
    const glb = await withModel(await convertFbxToGlb(source), (container) =>
      skinnedBoundsAtRestAndMidClip(container.meshes, container.animationGroups[0]!));
    for (const pose of ["rest", "midClip"] as const) {
      expect(glb[pose].length).toBe(6);
      glb[pose].forEach((value, axis) => expect(value, `${pose} bound ${axis}`).toBeCloseTo(fbx[pose][axis]!, 1));
    }
    // The clip moves the mesh, so the mid-clip comparison checks the bind as well as the rest pose.
    expect(fbx.midClip).not.toEqual(fbx.rest);
  });

  it("rejects malformed FBX instead of importing a different file from the batch", async () => {
    await expect(
      convertFbxToGlb({ name: "bad.fbx", bytes: new Uint8Array([1, 2, 3]) }, [fixture("box.fbx")]),
    ).rejects.toThrow(/FBX conversion failed/);
  });
});
