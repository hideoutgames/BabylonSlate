import { describe, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene, StandardMaterial } from "@babylonjs/core";
import { applyMaterialBounds } from "./material-bounds";

describe("material displacement bounds", () => {
  it("expands once and restores original bounds when the material changes", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    const material = new StandardMaterial("displaced", scene);
    material.metadata = { boundsPadding: 3 };
    mesh.material = material;
    applyMaterialBounds(mesh);
    applyMaterialBounds(mesh);
    expect(mesh.getBoundingInfo().boundingBox.maximum.x).toBe(4);
    mesh.material = null;
    applyMaterialBounds(mesh);
    expect(mesh.getBoundingInfo().boundingBox.maximum.x).toBe(1);
    scene.dispose();
    engine.dispose();
  });
});
