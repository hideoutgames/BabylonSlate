import { describe, expect, it } from "vitest";
import { buildMinimalGlbFixture, parseGlbForBrowse } from "./glb-parse";
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
});
