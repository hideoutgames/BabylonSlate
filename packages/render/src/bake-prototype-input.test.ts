import { describe, expect, it } from "vitest";
import { rasterizeBakeReceivers, validateBakePrototypeInput, type BakePrototypeInput, type BakePrototypeMesh } from "./bake-prototype-input";

function floor(): BakePrototypeMesh {
  return {
    positions: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0]),
    uv2: new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]),
    material: { kind: "diffuse", albedo: [0.5, 0.5, 0.5] },
  };
}

function input(meshes = [floor()]): BakePrototypeInput {
  return { meshes, lights: [], size: 2, samples: 4, bounces: 3, mode: "full" };
}

describe("prototype receiver admission", () => {
  it("rasterizes adjoining UV triangles once in bottom-up world coordinates", async () => {
    const atlas = await rasterizeBakeReceivers(input(), async () => {});
    expect(atlas.coveredTexels).toBe(4);
    expect([...atlas.positions]).toEqual([0.25, 0, 0.25, 1, 0.75, 0, 0.25, 1, 0.25, 0, 0.75, 1, 0.75, 0, 0.75, 1]);
    expect([...atlas.normals]).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it("rejects chart overlap even when the overlap contains no texel center", async () => {
    const tiny = floor();
    tiny.positions = tiny.positions.slice(0, 9);
    tiny.uv2 = new Float32Array([0, 0, 0, 0.1, 0.1, 0]);
    await expect(rasterizeBakeReceivers(input([floor(), tiny]), async () => {})).rejects.toThrow("overlap");
  });

  it("rejects unsupported closures and unbounded work before rasterization", () => {
    const textured = floor();
    Object.assign(textured.material, { map: "texture-guid" });
    expect(() => validateBakePrototypeInput(input([textured]))).toThrow("unsupported feature");
    expect(() => validateBakePrototypeInput({ ...input(), size: 129 })).toThrow("Atlas size");
    expect(() => validateBakePrototypeInput({ ...input(), samples: Infinity })).toThrow("Samples");
    const excessive = floor();
    excessive.positions = new Float32Array(513 * 9);
    expect(() => validateBakePrototypeInput(input([excessive]))).toThrow("triangles");
  });

  it("stops rasterization at cancellation and never returns a partial atlas", async () => {
    let checkpoints = 0;
    await expect(rasterizeBakeReceivers(input(), async () => {
      if (++checkpoints === 3) throw new DOMException("Cancelled", "AbortError");
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoints).toBe(3);
  });
});
