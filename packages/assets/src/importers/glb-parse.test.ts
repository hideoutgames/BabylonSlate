import { describe, expect, it } from "vitest";
import {
  buildMinimalGlbFixture,
  parseGlbForBrowse,
  parseGltfJsonForBrowse,
} from "./glb-parse";
import { importModel } from "./model";

describe("parseGlbForBrowse", () => {
  it("extracts materials, embedded images, and animations from a fixture GLB", () => {
    const glb = buildMinimalGlbFixture({
      materialName: "HeroMat",
      animationName: "Walk",
    });
    const browse = parseGlbForBrowse(glb);
    expect(browse).not.toBeNull();
    expect(browse!.materials).toHaveLength(1);
    expect(browse!.materials[0]!.name).toBe("HeroMat");
    expect(browse!.materials[0]!.albedoImageIndex).toBe(0);
    expect(browse!.images).toHaveLength(1);
    expect(browse!.images[0]!.bytes.byteLength).toBeGreaterThan(0);
    expect(browse!.animations[0]!.name).toBe("Walk");
  });

  it("parses glTF JSON with a data-URI image", () => {
    const png = buildMinimalGlbFixture(); // unused size; craft small data uri
    void png;
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const browse = parseGltfJsonForBrowse(
      JSON.stringify({
        asset: { version: "2.0" },
        images: [{ name: "Embedded", uri: dataUri }],
        textures: [{ source: 0 }],
        materials: [
          {
            name: "Mat",
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          },
        ],
        animations: [],
      }),
    );
    expect(browse).not.toBeNull();
    expect(browse!.images[0]!.bytes.byteLength).toBeGreaterThan(0);
    expect(browse!.materials[0]!.albedoImageIndex).toBe(0);
  });

  it("rejects non-GLB bytes", () => {
    expect(parseGlbForBrowse(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("importModel wires browsable dependents with pixel chunks from GLB", async () => {
    const glb = buildMinimalGlbFixture();
    const results = await importModel(glb, {
      fileName: "hero.glb",
      existingGuids: new Set(),
    });
    const types = results.map((r) => r.type);
    expect(types).toContain("Model");
    expect(types).toContain("Material");
    expect(types).toContain("Texture");
    expect(types).toContain("Animation");
    const texture = results.find((r) => r.type === "Texture")!;
    expect(texture.chunks.some((c) => c.kind === "pixels")).toBe(true);
    const model = results.find((r) => r.type === "Model")!;
    expect(model.payload.textureCount).toBe(1);
    expect(model.payload.materialCount).toBe(1);
  });

  it("falls back to stub dependents for OBJ", async () => {
    const results = await importModel(new Uint8Array([1]), {
      fileName: "mesh.obj",
      existingGuids: new Set(),
    });
    expect(results.map((r) => r.type).sort()).toEqual([
      "Animation",
      "Material",
      "Model",
      "Texture",
    ]);
  });
});
