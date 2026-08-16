import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, Scene, StandardMaterial } from "@babylonjs/core";
import {
  applyAssignMaterial,
  applyAssignMesh,
  applySnapshotToScene,
  createSnapshotSceneBinding,
  type SnapshotSceneBinding,
} from "./snapshot-apply";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function host() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => {
    scene.dispose();
    engine.dispose();
  });
  const binding = createSnapshotSceneBinding();
  const material = new StandardMaterial("assigned", scene);
  binding.resolveMaterial = (guid) => (guid === "mat-1" ? material : null);
  return { scene, binding, material };
}

/** The snapshot pass is what actually creates a Play mesh for a slot. */
function spawn(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotIds: readonly number[],
): void {
  applySnapshotToScene(scene, binding, {
    frameId: 1,
    tickIndex: 1,
    alpha: 1,
    actorCount: slotIds.length,
    actors: slotIds.map((slotId) => ({
      slotId,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      flags: 1,
    })),
  });
}

describe("runtime material assignment", () => {
  it("applies an assigned material to a spawned actor", () => {
    const { scene, binding, material } = host();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
    });
    spawn(scene, binding, [1]);
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat-1",
    });
    expect(binding.meshes.get(1)?.material).toBe(material);
  });

  it("applies an assignment recorded before the actor spawned", () => {
    const { scene, binding, material } = host();
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat-1",
    });
    spawn(scene, binding, [1]);
    expect(binding.meshes.get(1)?.material).toBe(material);
  });

  it("re-applies the material when the mesh is rebuilt", () => {
    const { scene, binding, material } = host();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
    });
    spawn(scene, binding, [1]);
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat-1",
    });
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "sphere",
      meshAssetGuid: null,
    });
    expect(binding.meshes.get(1)?.material).toBe(material);
  });

  it("assigns one component of a multipart actor", () => {
    const { scene, binding, material } = host();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 2,
      meshKind: "box",
      meshAssetGuid: null,
      parts: [
        {
          componentId: "body",
          meshKind: "box",
          meshAssetGuid: null,
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        {
          componentId: "hat",
          meshKind: "sphere",
          meshAssetGuid: null,
          position: [0, 1, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      ],
    });
    spawn(scene, binding, [2]);
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 2,
      componentId: "hat",
      materialAssetGuid: "mat-1",
    });
    const root = binding.meshes.get(2)!;
    const parts = root.getChildMeshes();
    const hat = parts.find((mesh) => mesh.name.endsWith("|hat"));
    const body = parts.find((mesh) => mesh.name.endsWith("|body"));
    expect(hat?.material).toBe(material);
    expect(body?.material).not.toBe(material);
  });

  it("leaves the mesh alone when the material cannot be resolved", () => {
    const { scene, binding } = host();
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
    });
    spawn(scene, binding, [1]);
    const before = binding.meshes.get(1)?.material ?? null;
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "missing",
    });
    expect(binding.meshes.get(1)?.material ?? null).toBe(before);
  });

  it("forgets assignments when the actor despawns", () => {
    const { scene, binding } = host();
    spawn(scene, binding, [1]);
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat-1",
    });
    spawn(scene, binding, []);
    expect(binding.materialAssetGuids.has(1)).toBe(false);
  });

  it("clears a recorded assignment when the guid is null", () => {
    const { scene, binding } = host();
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat-1",
    });
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: null,
    });
    expect(binding.materialAssetGuids.get(1)).toBeNull();
  });
});
