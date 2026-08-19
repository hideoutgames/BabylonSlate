import { describe, expect, it } from "vitest";
import type { AssetRegistry, IndexedAsset } from "@babylonslate/assets";
import { createDefaultScene } from "@babylonslate/core";
import {
  applyKenneyMannequinEmptyScaffold,
  MANNEQUIN_ACTOR_ID,
  MANNEQUIN_CLASS_ID,
} from "./scaffold-empty-3d";

function indexed(
  type: string,
  guid: string,
  payload: Record<string, unknown>,
  name = type,
): IndexedAsset {
  return {
    rootId: "project",
    path: `assets/Mannequin/${name}`,
    header: {
      type,
      guid,
      name,
      version: 1,
      engineVersion: "0",
      chunks: [],
      dependencies: [],
      mode: "thin",
      payload,
    },
  };
}

function fakeRegistry(created: IndexedAsset[]) {
  const writes: Array<{ path: string; type: string; payload: Record<string, unknown> }> =
    [];
  const registry = {
    importFile: async () => created,
    createAsset: async (
      _root: string,
      path: string,
      result: { type: string; payload: Record<string, unknown> },
    ) => {
      writes.push({ path, type: result.type, payload: result.payload });
    },
  } as unknown as AssetRegistry;
  return { registry, writes };
}

const hierarchyImport = [
  indexed("Model", "model-1", { clipNames: ["Idle"], materialSlots: [], skeletonGuid: "skel-1" }, "mannequin"),
  indexed(
    "Skeleton",
    "skel-1",
    { modelGuid: "model-1", kind: "hierarchy", boneNames: ["root"] },
    "mannequin_Skeleton",
  ),
  indexed(
    "Animation",
    "anim-idle",
    { clipName: "Idle", modelGuid: "model-1", skeletonGuid: "skel-1", durationMs: 1800 },
    "idle",
  ),
];

describe("applyKenneyMannequinEmptyScaffold", () => {
  it("rejects a skin Skeleton so 3D Empty stays on the hierarchy rig", async () => {
    const { registry } = fakeRegistry([
      indexed("Model", "model-1", { clipNames: [], materialSlots: [], skeletonGuid: "skel-1" }),
      indexed("Skeleton", "skel-1", { modelGuid: "model-1", kind: "skin", boneNames: ["Hips"] }),
      indexed("Animation", "anim-idle", { clipName: "Idle", modelGuid: "model-1" }),
    ]);
    await expect(
      applyKenneyMannequinEmptyScaffold({
        registry,
        scene: createDefaultScene(),
        mannequinBytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/hierarchy Skeleton \(got skin\)/);
  });

  it("replaces the default Cube with Mannequin Class + idle Anim Graph", async () => {
    const { registry, writes } = fakeRegistry(hierarchyImport);
    const scene = createDefaultScene();
    const otherId = scene.actors.find((actor) => actor.id !== MANNEQUIN_ACTOR_ID)!.id;
    const next = await applyKenneyMannequinEmptyScaffold({
      registry,
      scene,
      mannequinBytes: new Uint8Array([1]),
    });
    const actor = next.actors.find((entry) => entry.id === MANNEQUIN_ACTOR_ID);
    expect(actor?.name).toBe(MANNEQUIN_CLASS_ID);
    expect(actor?.classId).toBe(MANNEQUIN_CLASS_ID);
    expect(
      actor?.components.find((component) => component.classId === "MeshComponent")
        ?.properties.assetGuid,
    ).toBe("model-1");
    const graphGuid = actor?.components.find(
      (component) => component.classId === "AnimationGraphComponent",
    )?.properties.graphGuid;
    expect(graphGuid).toEqual(expect.any(String));
    expect(next.actors.find((entry) => entry.id === otherId)).toEqual(
      scene.actors.find((entry) => entry.id === otherId),
    );

    expect(writes.map((write) => write.type).sort()).toEqual([
      "AnimationGraph",
      "Class",
    ]);
    const graph = writes.find((write) => write.type === "AnimationGraph")!;
    const clip = (graph.payload.clips as Array<{ assetGuid?: string; clipName?: string; durationMs?: number }>)[0];
    expect(clip).toMatchObject({
      assetGuid: "anim-idle",
      clipName: "Idle",
      durationMs: 1800,
    });
    expect(writes.some((write) => write.path.includes("Mannequin/"))).toBe(true);
  });
});
