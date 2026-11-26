import { installAssetBytes } from "@haptic/assets";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSlotModelAnimLoad, createModelActorRoot } from "./glb-anim";
import { engineGlbBlueprintCount } from "./glb-geometry-handover";
import * as modelContainer from "./model-container";
import { encodeAnimatedLimbGlb, encodeTriangleGlb } from "./glb-test-fixtures";
import { createSnapshotSceneBinding } from "./snapshot-apply";
import { visualMeshes } from "./visual-meshes";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("Engine-scoped static GLB geometry blueprint handover", () => {
  it("reuses a decoded static GLB blueprint across Scenes on the same Engine without re-running LoadAssetContainerAsync", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const loadSpy = vi.spyOn(modelContainer, "loadModelContainer");
    const source = installAssetBytes(encodeTriangleGlb(), "model/gltf-binary");

    // First Scene (e.g. Editor Viewport): parses GLB once and remembers its CPU blueprint.
    const scene1 = new Scene(engine);
    const binding1 = createSnapshotSceneBinding();
    const root1 = createModelActorRoot(scene1, "actor-1");
    await beginSlotModelAnimLoad(scene1, binding1, 0, "crate", source, root1);
    const mesh1 = visualMeshes(root1)[0] as Mesh;
    const positions1 = Array.from(mesh1.getVerticesData(VertexBuffer.PositionKind)!);
    const normals1 = Array.from(mesh1.getVerticesData(VertexBuffer.NormalKind)!);
    const matIdx1 = modelContainer.modelMaterialIndexOf(mesh1);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(engineGlbBlueprintCount(engine)).toBe(1);
    scene1.dispose();

    // Second Scene on the same Engine (e.g. Play or restored Editor): materializes from CPU blueprint.
    const scene2 = new Scene(engine);
    const binding2 = createSnapshotSceneBinding();
    const root2 = createModelActorRoot(scene2, "actor-2");
    await beginSlotModelAnimLoad(scene2, binding2, 0, "crate", source, root2);
    const mesh2 = visualMeshes(root2)[0] as Mesh;
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(mesh2.getVerticesData(VertexBuffer.PositionKind)!)).toEqual(positions1);
    expect(Array.from(mesh2.getVerticesData(VertexBuffer.NormalKind)!)).toEqual(normals1);
    expect(modelContainer.modelMaterialIndexOf(mesh2)).toBe(matIdx1);
    scene2.dispose();

    // Disposing the Engine releases all retained CPU blueprints.
    engine.dispose();
    engines.pop();
    expect(engineGlbBlueprintCount(engine)).toBe(0);
  });

  it("falls back to loadModelContainer for animated/skinned GLBs so animation groups stay intact", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const loadSpy = vi.spyOn(modelContainer, "loadModelContainer");
    const source = installAssetBytes(encodeAnimatedLimbGlb(), "model/gltf-binary");

    const scene1 = new Scene(engine);
    const binding1 = createSnapshotSceneBinding();
    await beginSlotModelAnimLoad(scene1, binding1, 0, "rig", source, createModelActorRoot(scene1, "rig-1"));
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(engineGlbBlueprintCount(engine)).toBe(0);
    scene1.dispose();

    const scene2 = new Scene(engine);
    const binding2 = createSnapshotSceneBinding();
    await beginSlotModelAnimLoad(scene2, binding2, 0, "rig", source, createModelActorRoot(scene2, "rig-2"));
    expect(loadSpy).toHaveBeenCalledTimes(2);
    scene2.dispose();
  });
});
