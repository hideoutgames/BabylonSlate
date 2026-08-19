import { describe, expect, it, vi } from "vitest";
import { createDefaultScene, type SerializedGraph } from "@babylonslate/core";
import type { ImportResult, IndexedAsset } from "@babylonslate/assets";
import {
  applyKenneyMannequinEmptyScaffold,
  MANNEQUIN_ACTOR_ID,
  MANNEQUIN_CLASS_ID,
} from "./scaffold-empty-3d";

function indexed(
  type: string,
  guid: string,
  payload: Record<string, unknown>,
): IndexedAsset {
  return {
    rootId: "project",
    path: `Mannequin/${guid}.babasset`,
    header: {
      guid,
      type,
      name: type,
      payload,
    },
  } as IndexedAsset;
}

describe("applyKenneyMannequinEmptyScaffold", () => {
  it("adds a kinematic capsule to Mannequin Class and the default actor", async () => {
    const created = [
      indexed("Model", "model-1", {}),
      indexed("Skeleton", "skel-1", {
        kind: "hierarchy",
        modelGuid: "model-1",
        boneNames: ["root"],
      }),
      indexed("Animation", "idle-1", {
        clipName: "idle",
        modelGuid: "model-1",
        durationMs: 1000,
      }),
    ];
    const createAsset = vi.fn(
      async (_root: string, _path: string, result: ImportResult) => result,
    );
    const registry = {
      importFile: vi.fn(async () => created),
      createAsset,
    };

    const scene = await applyKenneyMannequinEmptyScaffold({
      registry: registry as never,
      scene: createDefaultScene(),
      mannequinBytes: new Uint8Array([1, 2, 3]),
    });

    const actor = scene.actors.find((entry) => entry.id === MANNEQUIN_ACTOR_ID);
    expect(actor?.classId).toBe(MANNEQUIN_CLASS_ID);
    const actorBody = actor?.components.find(
      (component) => component.classId === "RigidBodyComponent",
    );
    const actorCollider = actor?.components.find(
      (component) => component.classId === "ColliderComponent",
    );
    expect(actorBody?.properties.motionType).toBe("kinematic");
    expect(actorCollider?.properties.shape).toEqual(
      expect.objectContaining({ kind: "capsule", radius: 0.5, halfHeight: 1 }),
    );
    const actorY = actorCollider?.transform.position[1];
    expect(actorY).toBe(1.5);

    const classCall = createAsset.mock.calls.find(([, path]) =>
      String(path).includes("Mannequin.class"),
    );
    expect(classCall).toBeDefined();
    const graph = classCall![2]!.payload as unknown as SerializedGraph;
    const classBody = graph.components?.find(
      (component) => component.classId === "RigidBodyComponent",
    );
    const classCollider = graph.components?.find(
      (component) => component.classId === "ColliderComponent",
    );
    expect(classBody?.properties.motionType).toBe("kinematic");
    expect(classCollider?.properties.shape).toEqual(
      expect.objectContaining({ kind: "capsule" }),
    );
    expect(classCollider?.transform.position[1]).toBe(actorY);
  });
});
