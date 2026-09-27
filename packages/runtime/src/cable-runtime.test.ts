import { describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings, type SerializedActor, type SerializedComponent } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

function cable(id: string, properties: Record<string, unknown> = {}): SerializedComponent {
  return { id, classId: "CableComponent", properties };
}

function setup(actors: SerializedActor[], native = false) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: !native,
    playScene: { name: "Cables", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors },
    onCommand: (command) => commands.push(command),
  });
  const frames = () => commands.filter((command): command is Extract<CommandMessage, { type: "cableFrame" }> => command.type === "cableFrame");
  return { runtime, commands, frames };
}

function records(data: Float32Array): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (let offset = 0; offset < data.length;) {
    const id = data[offset++]!;
    const size = data[offset++]! * 3;
    offset += 8; // Actor slot IDs and local endpoint anchors.
    result.set(id, Array.from(data.subarray(offset, offset + size)));
    offset += size;
  }
  return result;
}

describe("CableComponent runtime", () => {
  it("batches hundreds of active cables and does no collision work by default", () => {
    const { runtime, commands, frames } = setup(Array.from({ length: 200 }, (_, index) => createActor(`a${index}`, "Cable", { components: [cable(`c${index}`)] })));
    try {
      runtime.realizePlayWorld();
      runtime.start();
      runtime.tick();
      expect(frames()).toHaveLength(1);
      expect(frames()[0]!.frameId).toBe(1);
      const first = frames()[0]!.data;
      const cables = records(first);
      expect(cables.size).toBe(200);
      expect([...cables.values()][0]![25]).toBeLessThan(0);
      // An owned packet remains valid after the following tick; it is not solver storage.
      const saved = first.slice();
      runtime.tick();
      expect(first).toEqual(saved);
      expect(frames()).toHaveLength(2);
      expect(commands.filter((c) => c.type === "assignMesh")).toHaveLength(200);
      expect(runtime.getPhysicsSync()!.getBackend().listDebugColliders()).toHaveLength(0);
    } finally { runtime.stop(); }
  });

  it("resolves component ancestry and stable prefab endpoint references, and follows a moving target", async () => {
    const { runtime, frames } = setup([]);
    try {
      await runtime.loadScripts([{
        assetGuid: "rig", classId: "CableRig", parentClassId: "Actor", source: "", anchors: [], entryPoints: [],
        components: [
          { id: "mount", classId: "ActorComponent", properties: {}, transform: { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { ...cable("rope", { targetComponentId: "tip", endPosition: [1, 0, 0] }), parentId: "mount" },
          { id: "tip", classId: "ActorComponent", properties: {}, transform: { position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
        ],
      }]);
      runtime.start();
      const actor = runtime.spawnScriptedActor({ classId: "CableRig", transform: {
        position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 2, y: 2, z: 2 },
      } })!;
      runtime.tick();
      const points = [...records(frames().at(-1)!.data).values()][0]!;
      expect(points.slice(0, 3)).toEqual([10, 4, 0]);
      expect(points.slice(-3)).toEqual([18, 0, 0]);
      actor.components.find((c) => c.sourceId === "tip")!.transform.position.y = 3;
      runtime.tick();
      expect([...records(frames().at(-1)!.data).values()][0]!.slice(-3)).toEqual([18, 6, 0]);
    } finally { runtime.stop(); }
  });

  it("refreshes typed script writes, honors pause/disable, and stops publishing destroyed cables", async () => {
    const { runtime, commands, frames } = setup([createActor("owner", "Owner", { classId: "Rig", components: [cable("rope", { gravityScale: 0 })] })]);
    try {
      await runtime.loadScripts([{
        assetGuid: "rig", classId: "Rig", parentClassId: "Actor", anchors: [],
        entryPoints: ["Resize", "Disable", "Enable"].map((event) => ({ event, name: event, isAsync: false })),
        source: 'export function Resize(ctx) { const c=ctx.getComponentById(ctx.self,"rope"); ctx.setVariableOn(c,"numSegments",4); ctx.setVariableOn(c,"endPosition",{x:2,y:1,z:0}); } export function Disable(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self,"rope"),"enabled",false); } export function Enable(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self,"rope"),"enabled",true); }',
      }]);
      runtime.realizePlayWorld(); runtime.start(); runtime.tick();
      const owner = runtime.getWorld().findActor("owner")!;
      runtime.invokeScriptEvent("Rig", "Resize", owner); runtime.tick();
      const assignment = commands.filter((c) => c.type === "assignMesh").at(-1);
      expect(assignment).toMatchObject({ parts: [{ cable: { numSegments: 4, endPosition: [2, 1, 0] } }] });
      expect([...records(frames().at(-1)!.data).values()][0]).toHaveLength(15);
      expect([...records(frames().at(-1)!.data).values()][0]!.slice(-3)).toEqual([2, 1, 0]);
      const count = frames().length;
      runtime.pause(); runtime.tick(); expect(frames()).toHaveLength(count);
      runtime.resume(); runtime.invokeScriptEvent("Rig", "Disable", owner); runtime.tick(); expect(frames()).toHaveLength(count);
      runtime.invokeScriptEvent("Rig", "Enable", owner); runtime.tick(); expect(frames()).toHaveLength(count + 1);
      runtime.getWorld().destroyActor(owner.guid); runtime.tick(); expect(frames()).toHaveLength(count + 1);
    } finally { runtime.stop(); }
  });

  it("omits sleeping cables until an attachment moves or its target retires", () => {
    const { runtime, frames } = setup([
      createActor("owner", "Owner", { components: [cable("rope", { targetActorId: "target", gravityScale: 0, cableLength: 3, sleepDelay: .05 })] }),
      createActor("target", "Target", { components: [] }),
    ]);
    try {
      runtime.realizePlayWorld(); runtime.start();
      for (let i = 0; i < 10; i++) runtime.tick();
      const count = frames().length;
      for (let i = 0; i < 10; i++) runtime.tick();
      expect(frames()).toHaveLength(count);
      runtime.getWorld().destroyActor("target");
      runtime.tick(); runtime.tick();
      expect(frames()).toHaveLength(count + 1);
      const fallback = frames().at(-1)!.data;
      expect(fallback[3]).toBe(fallback[2]); // Endpoint now belongs to the owner, not the retired slot.
      runtime.getWorld().findActor("owner")!.transform.position.y = 2;
      runtime.tick();
      expect(frames()).toHaveLength(count + 2);
      expect([...records(frames().at(-1)!.data).values()][0]!.slice(0, 3)).toEqual([0, 2, 0]);
    } finally { runtime.stop(); }
  });

  it("uses optional Havok collision to keep a free cable above a floor", async () => {
    const { runtime, frames } = setup([
      createActor("owner", "Owner", { transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [
        cable("rope", { attachStart: false, attachEnd: false, numSegments: 4, cableLength: 2, endPosition: [2, 0, 0], cableWidth: .2, enableCollision: true }),
      ] }),
      createActor("floor", "Floor", { components: [
        { id: "body", classId: "RigidBodyComponent", properties: { motionType: "static" } },
        { id: "shape", classId: "ColliderComponent", properties: { shape: { kind: "box", halfExtents: { x: 10, y: .1, z: 10 } } } },
      ] }),
    ], true);
    try {
      await runtime.loadPhysics(); runtime.realizePlayWorld(); runtime.start();
      for (let i = 0; i < 90; i++) runtime.tick();
      const points = [...records(frames().at(-1)!.data).values()][0]!;
      for (let i = 1; i < points.length; i += 3) {
        expect(points[i]).toBeGreaterThan(.18);
        expect(points[i]).toBeLessThan(.3);
      }
    } finally { runtime.stop(); }
  });
});
