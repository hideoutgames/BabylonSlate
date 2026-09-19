import { afterEach, describe, expect, it } from "vitest";
import {
  Material,
  MeshBuilder,
  NullEngine,
  Scene,
  ShaderMaterial,
  Vector3,
} from "@babylonjs/core";
import { SelectionOutline } from "./selection-outline";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

describe("SelectionOutline", () => {
  it("outlines triangle meshes but never line or point draws", () => {
    const scene = host();
    const solid = MeshBuilder.CreateBox("solid", {}, scene);
    const lines = MeshBuilder.CreateLines(
      "lines",
      { points: [Vector3.Zero(), Vector3.Up()] },
      scene,
    );
    const wire = MeshBuilder.CreateBox("wire", {}, scene);
    wire.material = new ShaderMaterial(
      "wire",
      scene,
      { vertex: "color", fragment: "color" },
      { attributes: ["position"], uniforms: ["worldViewProjection"] },
    );
    wire.material.fillMode = Material.WireFrameFillMode;
    const outline = new SelectionOutline(scene);
    outline.set([solid, lines, wire]);
    // Only triangle topologies may carry a biased outline redraw: WebGPU fails
    // pipeline creation when a LineList/PointList draw carries a depth bias.
    expect(solid.renderOutline).toBe(true);
    expect(lines.renderOutline).toBeFalsy();
    expect(wire.renderOutline).toBeFalsy();
    expect(outline.selected().map((mesh) => mesh.name)).toEqual(["solid"]);
    outline.set([]);
    expect(solid.renderOutline).toBe(false);
    outline.dispose();
  });
});
