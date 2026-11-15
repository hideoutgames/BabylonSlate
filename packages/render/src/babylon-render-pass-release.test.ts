import { afterEach, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { Scene } from "@babylonjs/core/scene";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A box drawn by a Standard Material, its draw state for the main pass prepared. */
function preparedBox(): { engine: NullEngine; mesh: Mesh; subMesh: SubMesh } {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  mesh.material = new StandardMaterial("standard", scene);
  const subMesh = mesh.subMeshes[0]!;
  mesh.material.isReadyForSubMesh(mesh, subMesh);
  return { engine, mesh, subMesh };
}

/** Prepares `subMesh`'s draw state in `pass`, as a pass drawing it does. */
function drawIn(engine: NullEngine, mesh: Mesh, subMesh: SubMesh, pass: number): void {
  const current = engine.currentRenderPassId;
  engine.currentRenderPassId = pass;
  try { mesh.material!.isReadyForSubMesh(mesh, subMesh); } finally { engine.currentRenderPassId = current; }
}

describe("patched render pass release", () => {
  it("leaves a sub-mesh's draw state as it was when a pass that never drew it is released", () => {
    const { engine, subMesh } = preparedBox();
    expect(subMesh._drawWrappers).toHaveLength(1);
    // Passes of other Scenes (a thumbnail's frame graph), each created and released.
    for (let i = 0; i < 40; i++) engine.releaseRenderPassId(engine.createRenderPassId("other scene"));
    expect(subMesh._drawWrappers).toHaveLength(1);
    expect(subMesh._drawWrappers[0]?.defines).toBeTruthy();
  });

  it("drops a released pass's draw state, and the storage ends at the last pass still holding some", () => {
    const { engine, mesh, subMesh } = preparedBox();
    const kept = engine.createRenderPassId("kept");
    const released = engine.createRenderPassId("released");
    drawIn(engine, mesh, subMesh, kept);
    drawIn(engine, mesh, subMesh, released);
    expect(subMesh._drawWrappers).toHaveLength(released + 1);

    engine.releaseRenderPassId(released);
    expect(subMesh._drawWrappers).toHaveLength(kept + 1);
    expect(subMesh._drawWrappers[kept]?.defines).toBeTruthy();
    engine.releaseRenderPassId(kept);
    expect(subMesh._drawWrappers).toHaveLength(1);
    expect(subMesh._drawWrappers[0]?.defines).toBeTruthy();
  });
});
