import { afterEach, describe, expect, it } from "vitest";
import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { importModel, parseGlbForBrowse } from "@haptic/assets";
import {
  convertObjImportBatch,
  convertObjToGlb,
  exportConvertedSceneToGlb,
} from "./convert-obj-to-glb";
import { isGltfModelBytes } from "./model-mesh";

const TRIANGLE_OBJ = `v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
`;

const GLB_MAGIC = 0x46546c67;

describe("convertObjToGlb", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (engines.length > 0) engines.pop()?.dispose();
  });

  it("converts a triangle OBJ into a GLB", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const glb = await convertObjToGlb(
      new TextEncoder().encode(TRIANGLE_OBJ),
      { engine, fileName: "triangle.obj" },
    );
    expect(isGltfModelBytes(glb)).toBe(true);
    expect(new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(0, true)).toBe(
      GLB_MAGIC,
    );
  });

  it("imports the converted GLB as a Model without Skeleton or Animation", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const glb = await convertObjToGlb(
      new TextEncoder().encode(TRIANGLE_OBJ),
      { engine, fileName: "crate.obj" },
    );
    const results = await importModel(glb, {
      fileName: "crate.glb",
      existingGuids: new Set(),
    });
    expect(results.map((result) => result.type)).toContain("Model");
    expect(results.some((result) => result.type === "Skeleton")).toBe(false);
    expect(results.some((result) => result.type === "Animation")).toBe(false);
    const model = results.find((result) => result.type === "Model")!;
    expect(model.payload.skeletonGuid).toBeNull();
    expect(model.chunks[0]?.mime).toBe("model/gltf-binary");
  });

  it("converts OBJ files in a mixed picker batch and leaves unrelated images", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const { files, errors } = await convertObjImportBatch(
      [
        { name: "Hero.obj", bytes: new TextEncoder().encode(TRIANGLE_OBJ) },
        { name: "unrelated.png", bytes: new Uint8Array([1, 2, 3]) },
      ],
      { engine },
    );
    expect(errors).toEqual([]);
    expect(files.map((file) => file.name)).toEqual(["Hero.glb", "unrelated.png"]);
    expect(isGltfModelBytes(files[0]!.bytes)).toBe(true);
  });
});


describe("exportConvertedSceneToGlb", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (engines.length > 0) engines.pop()?.dispose();
  });

  function scratchScene(): Scene {
    const engine = new NullEngine();
    engines.push(engine);
    return new Scene(engine);
  }

  it("exports an animated node tree with no mesh, as an FBX animation file converts", async () => {
    const scene = scratchScene();
    const root = new TransformNode("Root", scene);
    const hips = new TransformNode("Hips", scene);
    hips.parent = root;
    const turn = new Animation("turn", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION);
    turn.setKeys([
      { frame: 0, value: Quaternion.Identity() },
      { frame: 30, value: Quaternion.RotationYawPitchRoll(Math.PI / 2, 0, 0) },
    ]);
    const idle = new AnimationGroup("Idle", scene);
    idle.addTargetedAnimation(turn, hips);

    const browse = parseGlbForBrowse(await exportConvertedSceneToGlb(scene, "FBX"));
    expect(browse!.hasMeshes).toBe(false);
    expect(browse!.animations.map((clip) => clip.name)).toEqual(["Idle"]);
    expect(browse!.rigKind).toBe("hierarchy");
    expect(browse!.bones.map((bone) => bone.name)).toEqual(["Root", "Hips"]);
  });

  it("refuses a scene with neither meshes nor animations", async () => {
    const scene = scratchScene();
    new TransformNode("Empty", scene);
    await expect(exportConvertedSceneToGlb(scene, "FBX")).rejects.toThrow(
      "FBX conversion produced no meshes.",
    );
  });
});
