import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { compileGraph, type GraphNode } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";

describe("Attach to Bone scripting", () => {
  it("compiles actor references and a bone name into a renderer command, defaulting Actor to Self", async () => {
    const registry = createDefaultNodeRegistry();
    expect(registry.get("actor.attachToBone")).toBeDefined();
    const node = (id: string, typeId: string, properties = {}): GraphNode => ({
      id, typeId, properties, position: { x: 0, y: 0 },
      pins: registry.get(typeId)!.pins(properties),
    });
    const compiled = compileGraph({
      id: "g", kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("parent", "actor.getOfClass", { "default:classId": "Character" }),
        node("attach", "actor.attachToBone", { "default:boneName": "Hand.R" }),
      ],
      edges: [
        { id: "exec", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "attach", targetPinId: "execIn" },
        { id: "target", sourceNodeId: "parent", sourcePinId: "out", targetNodeId: "attach", targetPinId: "target" },
      ],
    }, { assetGuid: "held-item", registry });
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (c) => commands.push(c) });
    try {
      await runtime.loadScripts([{ assetGuid: "held-item", classId: "HeldItem", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints }]);
      const parent = runtime.spawnScriptedActor({ classId: "Character" });
      const child = runtime.spawnScriptedActor({ classId: "HeldItem" });
      expect(commands.filter((c) => c.type === "attachToBone")).toEqual([
        { type: "attachToBone", slotId: 1, targetSlotId: 0, boneName: "Hand.R" },
      ]);
      expect(child?.getVariable("parentId")).toBe(parent?.guid);
    } finally { runtime.stop(); }
  });

  it("rejects missing, destroyed, and cyclic targets and clears attachments on ordinary reparent or detach", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (c) => commands.push(c) });
    try {
      await runtime.loadScripts([{
        assetGuid: "held-item", classId: "HeldItem", anchors: [],
        entryPoints: [{ exportName: "onBeginPlay", event: "beginPlay", nodeId: "begin" }],
        source: `export function onBeginPlay(ctx) {
          const parent = ctx.getActorOfClass("Character");
          const dead = ctx.spawnActor("Dead");
          ctx.destroyActor(dead);
          ctx.attachToBone(null, null, "Hand");
          ctx.attachToBone(null, dead, "Hand");
          ctx.attachToBone(null, ctx.self, "Hand");
          ctx.attachToBone(null, parent, "");
          ctx.attachToBone(null, parent, "Hand");
          ctx.attachToBone(parent, ctx.self, "Hand");
          ctx.detachActor(ctx.self);
          ctx.attachToBone(null, parent, "Hand");
          ctx.attachActor(ctx.self, parent);
        }`,
      }]);
      runtime.spawnScriptedActor({ classId: "Character" });
      const child = runtime.spawnScriptedActor({ classId: "HeldItem", transform: { position: { x: 9, y: 8, z: 7 }, rotation: { x: 0, y: 1, z: 0, w: 0 }, scale: { x: 2, y: 3, z: 4 } } });
      expect(commands.filter((c) => c.type === "attachToBone")).toEqual([
        { type: "attachToBone", slotId: 1, targetSlotId: 0, boneName: "Hand" },
        { type: "attachToBone", slotId: 1, targetSlotId: null, boneName: "" },
        { type: "attachToBone", slotId: 1, targetSlotId: 0, boneName: "Hand" },
        { type: "attachToBone", slotId: 1, targetSlotId: null, boneName: "" },
      ]);
      expect(child?.transform).toEqual({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 2, y: 3, z: 4 } });
      expect(commands.filter((c) => c.type === "diagnostic")).toEqual([]);
    } finally { runtime.stop(); }
  });
});
