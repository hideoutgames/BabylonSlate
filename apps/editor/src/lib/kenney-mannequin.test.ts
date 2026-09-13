import { describe, expect, it } from "vitest";
import { parseGlbForBrowse, splitGlbJsonBin } from "@babylonslate/assets";
import { loadKenneyMannequinGlb } from "./kenney-mannequin";

describe("Kenney Mannequin GLB", () => {
  it("keeps the cuboid faces flat when used by the lit template", async () => {
    const split = splitGlbJsonBin(await loadKenneyMannequinGlb())!;
    const accessors = split.json.accessors as { bufferView: number; byteOffset?: number; count: number }[];
    const views = split.json.bufferViews as { byteOffset?: number; byteStride?: number }[];
    const data = new DataView(split.bin.buffer, split.bin.byteOffset, split.bin.byteLength);
    const meshes = split.json.meshes as { primitives: { attributes: Record<string, number> }[] }[];
    expect(meshes).toHaveLength(6);
    for (const mesh of meshes) for (const primitive of mesh.primitives) {
      const normal = accessors[primitive.attributes.NORMAL!]!;
      const view = views[normal.bufferView]!;
      for (let i = 0; i < normal.count; i++) {
        const offset = (view.byteOffset ?? 0) + (normal.byteOffset ?? 0) + i * (view.byteStride ?? 12);
        const components = [0, 4, 8].map((axis) => Math.abs(data.getFloat32(offset + axis, true)));
        // Every face in this supplied model is an axis-aligned rectangle.
        // Smoothed corner normals produce diagonal light bands on those faces.
        components.sort((a, b) => a - b);
        expect(components[0]).toBeCloseTo(0, 5);
        expect(components[1]).toBeCloseTo(0, 5);
        expect(components[2]).toBeCloseTo(1, 5);
      }
    }
  });
  it("loads glTF-binary bytes from the engine-content pack", async () => {
    const bytes = await loadKenneyMannequinGlb();
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe(
      "glTF",
    );
  });

  it("embeds mannequin.png over the missing Textures/texture-d.png URI", async () => {
    const bytes = await loadKenneyMannequinGlb();
    const split = splitGlbJsonBin(bytes);
    expect(split).not.toBeNull();
    const images = split!.json.images as Array<{ uri?: string; bufferView?: number }>;
    expect(images[0]?.uri).toBeUndefined();
    expect(images[0]?.bufferView).toEqual(expect.any(Number));
    const browse = parseGlbForBrowse(bytes);
    expect(browse?.images[0]?.bytes.byteLength).toBeGreaterThan(100);
    expect(browse?.materials[0]?.unlit).toBe(true);
  });
});
