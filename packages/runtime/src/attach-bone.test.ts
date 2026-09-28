import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { compileGraph, type GraphNode } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import type { Actor } from "@babylonslate/object-model";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import type { CompiledScript } from "./script-host";

const characterScripts: CompiledScript[] = ["Character", "Dead"].map((classId) => ({
  assetGuid: classId, classId, parentClassId: "Actor", source: "", anchors: [], entryPoints: [],
}));

/** Entry points that write parent links through each script-facing path. */
const linkScript: CompiledScript = {
  assetGuid: "link", classId: "Link", parentClassId: "Actor", anchors: [],
  entryPoints: [
    { name: "attach", event: "Attach", isAsync: false },
    { name: "attachToBone", event: "AttachToBone", isAsync: false },
    { name: "setParentOn", event: "SetParentOn", isAsync: false },
    { name: "setOwnParent", event: "SetOwnParent", isAsync: false },
  ],
  source: `export function attach(ctx) { ctx.attachActor(ctx.args.child, ctx.args.parent); }
export function attachToBone(ctx) { ctx.attachToBone(ctx.args.child, ctx.args.parent, "Hand"); }
export function setParentOn(ctx) { ctx.setVariableOn(ctx.args.child, "parentId", ctx.args.parentId); }
export function setOwnParent(ctx) { ctx.setVariable("parentId", ctx.args.parentId); }`,
};

function warnings(commands: readonly CommandMessage[]): string[] {
  return commands.flatMap((c) => (c.type === "log" && c.severity === "warning" ? [c.message] : []));
}

function attach(runtime: RuntimeDriver, child: Actor, parent: Actor): void {
  runtime.invokeScriptEvent("Link", "Attach", null, { child, parent });
}

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
      await runtime.loadScripts([...characterScripts, { assetGuid: "held-item", classId: "HeldItem", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints }]);
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
      await runtime.loadScripts([...characterScripts, {
        assetGuid: "held-item", classId: "HeldItem", anchors: [],
        entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
        source: `export function onBeginPlay(ctx) {
          const parent = ctx.getActorOfClass("Character");
          const dead = ctx.spawnActor("Dead");
          dead.destroyed = true;
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
      const parent = runtime.spawnScriptedActor({ classId: "Character" });
      const child = runtime.spawnScriptedActor({ classId: "HeldItem", transform: { position: { x: 9, y: 8, z: 7 }, rotation: { x: 0, y: 1, z: 0, w: 0 }, scale: { x: 2, y: 3, z: 4 } } });
      expect(commands.filter((c) => c.type === "attachToBone")).toEqual([
        { type: "attachToBone", slotId: 1, targetSlotId: 0, boneName: "Hand" },
        { type: "attachToBone", slotId: 1, targetSlotId: null, boneName: "" },
        { type: "attachToBone", slotId: 1, targetSlotId: 0, boneName: "Hand" },
        { type: "attachToBone", slotId: 1, targetSlotId: null, boneName: "" },
      ]);
      expect(child?.transform).toEqual({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 2, y: 3, z: 4 } });
      expect(commands.filter((c) => c.type === "diagnostic")).toEqual([]);
      // Only self-attachment and the cycle warn; missing, destroyed, and unnamed targets stay silent.
      const refused = warnings(commands);
      expect(refused).toHaveLength(2);
      expect(refused[0]).toContain(child!.guid);
      expect(refused[1]).toContain(child!.guid);
      expect(refused[1]).toContain(parent!.guid);
    } finally { runtime.stop(); }
  });
});

describe("Parent link cycles", () => {
  const at = (x: number, y: number, z: number) => ({
    position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 },
  });

  it("refuses Attach Actor under the child's own descendant, keeping its parent and bone attachment", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (c) => commands.push(c) });
    try {
      await runtime.loadScripts([linkScript]);
      const [holder, a, b, c] = ["Holder", "A", "B", "C"].map((name) =>
        runtime.spawnScriptedActor({ classId: "Link", variables: { name } })!);
      runtime.invokeScriptEvent("Link", "AttachToBone", null, { child: a, parent: holder });
      attach(runtime, b!, a!);
      attach(runtime, c!, b!);
      expect([a, b, c].map((actor) => actor!.getVariable("parentId"))).toEqual([holder!.guid, a!.guid, b!.guid]);
      expect(warnings(commands)).toEqual([]);

      commands.length = 0;
      attach(runtime, a!, b!);
      attach(runtime, a!, c!);
      expect(a!.getVariable("parentId")).toBe(holder!.guid);
      expect(commands.filter((command) => command.type === "attachToBone")).toEqual([]);
      const refused = warnings(commands);
      expect(refused).toHaveLength(2);
      expect(refused[0]).toContain(a!.guid);
      expect(refused[0]).toContain(b!.guid);
      expect(refused[1]).toContain(a!.guid);
      expect(refused[1]).toContain(c!.guid);

      attach(runtime, c!, a!);
      expect(c!.getVariable("parentId")).toBe(a!.guid);
      expect(warnings(commands)).toHaveLength(2);
    } finally { runtime.stop(); }
  });

  it("refuses scripted parentId variable writes that would close a cycle, including the actor's own guid", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (c) => commands.push(c) });
    try {
      await runtime.loadScripts([linkScript]);
      const [holder, a, b] = ["Holder", "A", "B"].map((name) =>
        runtime.spawnScriptedActor({ classId: "Link", variables: { name } })!);
      runtime.invokeScriptEvent("Link", "SetParentOn", null, { child: a, parentId: holder!.guid });
      runtime.invokeScriptEvent("Link", "SetOwnParent", b, { parentId: a!.guid });
      expect([a!.getVariable("parentId"), b!.getVariable("parentId")]).toEqual([holder!.guid, a!.guid]);

      runtime.invokeScriptEvent("Link", "SetParentOn", null, { child: a, parentId: b!.guid });
      runtime.invokeScriptEvent("Link", "SetOwnParent", a, { parentId: b!.guid });
      expect(a!.getVariable("parentId")).toBe(holder!.guid);
      const refused = warnings(commands);
      expect(refused).toHaveLength(2);
      for (const message of refused) {
        expect(message).toContain(a!.guid);
        expect(message).toContain(b!.guid);
      }

      runtime.invokeScriptEvent("Link", "SetOwnParent", b, { parentId: b!.guid });
      expect(b!.getVariable("parentId")).toBe(a!.guid);
      const all = warnings(commands);
      expect(all).toHaveLength(3);
      expect(all[2]).toContain(b!.guid);
    } finally { runtime.stop(); }
  });

  it("refuses a link into a parent chain that already loops", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (c) => commands.push(c) });
    try {
      await runtime.loadScripts([linkScript]);
      const [a, b, c] = ["A", "B", "C"].map((name) =>
        runtime.spawnScriptedActor({ classId: "Link", variables: { name } })!);
      // Stands in for a loaded scene whose hierarchy already contains a loop.
      a!.setVariable("parentId", b!.guid);
      b!.setVariable("parentId", a!.guid);

      attach(runtime, c!, a!);
      expect(c!.getVariable("parentId") ?? null).toBeNull();
      const refused = warnings(commands);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain(c!.guid);
      expect(refused[0]).toContain(a!.guid);
    } finally { runtime.stop(); }
  });

  it("keeps a physics world ticking after refusing a cyclic attach", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, onCommand: (c) => commands.push(c) });
    try {
      await runtime.loadScripts([linkScript]);
      const world = runtime.getWorld();
      const shape = { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
      const body = runtime.spawnScriptedActor({ classId: "Link", transform: at(0, 10, 0) })!;
      body.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "dynamic", mass: 1 } }));
      body.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape } }));
      const sensor = runtime.spawnScriptedActor({ classId: "Link", transform: at(2, 0, 0) })!;
      sensor.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape } }));
      attach(runtime, sensor, body);
      runtime.start();
      runtime.tick();
      const height = body.transform.position.y;

      attach(runtime, body, sensor);
      expect(() => {
        runtime.tick();
        runtime.tick();
      }).not.toThrow();
      expect(body.getVariable("parentId") ?? null).toBeNull();
      expect(sensor.getVariable("parentId")).toBe(body.guid);
      expect(body.transform.position.y).toBeLessThan(height);
      expect(warnings(commands)).toHaveLength(1);
    } finally { runtime.stop(); }
  });
});
