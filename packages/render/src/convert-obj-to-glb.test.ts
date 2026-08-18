import { afterEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { importModel } from "@babylonslate/assets";
import {
  convertObjImportBatch,
  convertObjToGlb,
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

