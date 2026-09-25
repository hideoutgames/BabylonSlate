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

  it.each([false, true])("restores world bounds at a mesh moved while padded (frozen: %s)", (frozen) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    const material = new StandardMaterial("displaced", scene);
    material.metadata = { boundsPadding: 3 };
    mesh.material = material;
    applyMaterialBounds(mesh);
    mesh.position.x = 10;
    mesh.computeWorldMatrix(true);
    if (frozen) mesh.freezeWorldMatrix();
    expect(mesh.getBoundingInfo().boundingBox.centerWorld.x).toBeCloseTo(10);
    mesh.material = null;
    applyMaterialBounds(mesh);
    mesh.computeWorldMatrix();
    const box = mesh.getBoundingInfo().boundingBox;
    expect(box.maximum.x).toBe(1);
    expect(box.centerWorld.x).toBeCloseTo(10);
    expect(box.maximumWorld.x).toBeCloseTo(11);
    scene.dispose();
    engine.dispose();
  });
});
