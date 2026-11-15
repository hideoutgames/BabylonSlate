import { afterEach, describe, expect, it } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { syncSceneLighting } from "./scene-lighting";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function litScene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  syncSceneLighting(scene);
  return scene;
}

/** A box drawn by a lit graph Material, its defines prepared. */
async function graphBox(scene: Scene): Promise<{ mesh: Mesh; material: NodeMaterial }> {
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("Invalid fixture");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "lit" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  const mesh = MeshBuilder.CreateBox("graph", {}, scene);
  mesh.material = compiled.material;
  await compiled.material.forceCompilationAsync(mesh);
  // Prepares the defines of the mesh's own draw (a forced compilation keeps none on the mesh).
  compiled.material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
  return { mesh, material: compiled.material };
}

/** A box drawn by a Standard Material, which reads the mesh's lights, its defines prepared. */
function standardBox(scene: Scene): Mesh {
  const mesh = MeshBuilder.CreateBox("standard", {}, scene);
  const material = new StandardMaterial("standard", scene);
  mesh.material = material;
  material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!);
  return mesh;
}

/** The define sets of `mesh`'s draws, as Babylon marks them. */
function preparedDefines(mesh: Mesh): MaterialDefines[] {
  return mesh.subMeshes.flatMap((subMesh) => subMesh._drawWrappers.flatMap((wrapper) => {
    const defines = wrapper?.defines as MaterialDefines | string | null | undefined;
    return defines && typeof defines !== "string" ? [defines] : [];
  }));
}

function lightDirty(mesh: Mesh): boolean {
  return preparedDefines(mesh).some((defines) => defines._areLightsDirty);
}

describe("light-free meshes", () => {
  it("leaves a mesh whose Materials read no light unmarked when a light switches, and marks one that reads lights", async () => {
    const scene = litScene();
    const light = new PointLight("point", new Vector3(0, 2, 0), scene);
    const graph = await graphBox(scene);
    const standard = standardBox(scene);
    expect(graph.mesh.lightSources).toContain(light);
    expect([preparedDefines(graph.mesh).length, preparedDefines(standard).length]).toEqual([1, 1]);
    expect([lightDirty(graph.mesh), lightDirty(standard)]).toEqual([false, false]);

    light.setEnabled(false);
    // The light still leaves the graph mesh's sources, which shadow caster readiness reads.
    expect(graph.mesh.lightSources).not.toContain(light);
    expect(lightDirty(graph.mesh)).toBe(false);
    expect(lightDirty(standard)).toBe(true);
  });

  it("marks a graph mesh that another pass draws with a Material that reads lights", async () => {
    const scene = litScene();
    const light = new PointLight("point", new Vector3(0, 2, 0), scene);
    const graph = await graphBox(scene);
    graph.mesh.setMaterialForRenderPass(7, new StandardMaterial("pass", scene));
    expect(preparedDefines(graph.mesh)).toHaveLength(1);

    light.setEnabled(false);
    expect(lightDirty(graph.mesh)).toBe(true);
  });
});
