import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

const scripts: CompiledScript[] = [
  { assetGuid: "character", classId: "Character", parentClassId: "Actor", source: "", anchors: [], entryPoints: [] },
  {
    assetGuid: "link", classId: "Link", parentClassId: "Actor", anchors: [],
    entryPoints: [{ name: "attachToBone", event: "AttachToBone", isAsync: false }],
    source: 'export function attachToBone(ctx) { ctx.attachToBone(ctx.args.child, ctx.args.parent, "Hand"); }',
  },
];

describe("actor host bindings", () => {
  it("keeps the child's parent and pose when Attach To Bone targets an actor without a render slot", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (c) => commands.push(c) });
    try {
      await runtime.loadScripts(scripts);
      const world = runtime.getWorld();
      const unslotted = world.spawnActorNow(world.createActor({ classId: "Character" }));
      const child = runtime.spawnScriptedActor({ classId: "Link", transform: {
        position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 1, z: 0, w: 0 }, scale: { x: 1, y: 1, z: 1 },
      } })!;

      runtime.invokeScriptEvent("Link", "AttachToBone", null, { child, parent: unslotted });

      expect(child.getVariable("parentId") ?? null).toBeNull();
      expect(child.transform.position).toEqual({ x: 1, y: 2, z: 3 });
      expect(child.transform.rotation).toEqual({ x: 0, y: 1, z: 0, w: 0 });
      expect(commands.filter((c) => c.type === "attachToBone")).toEqual([]);

      const slotted = runtime.spawnScriptedActor({ classId: "Character" })!;
      runtime.invokeScriptEvent("Link", "AttachToBone", null, { child, parent: slotted });
      expect(child.getVariable("parentId")).toBe(slotted.guid);
      expect(child.transform.position).toEqual({ x: 0, y: 0, z: 0 });
      expect(commands.filter((c) => c.type === "attachToBone")).toHaveLength(1);
    } finally { runtime.stop(); }
  });
});
