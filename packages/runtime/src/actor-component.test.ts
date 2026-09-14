import { expect, it } from "vitest";
import { createActor, createDefaultSceneSettings } from "@babylonslate/core";
import type { ActorComponent } from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

const counter: CompiledScript = {
  assetGuid: "counter", classId: "Counter", parentClassId: "ActorComponent", anchors: [],
  variables: [{ name: "count", type: "int", defaultValue: 3 }],
  entryPoints: ["onBeginPlay", "onTick", "onDestroyed"].map((name) => ({ name, event: name, isAsync: false })),
  source: `export function onBeginPlay(ctx) {
    if (!ctx.self.owner.world) throw new Error("Owner must be spawned");
    ctx.self.setVariable("begins", (ctx.self.getVariable("begins") ?? 0) + 1);
  }
  export function onTick(ctx) { ctx.self.setVariable("count", ctx.self.getVariable("count") + 1); }
  export function onDestroyed(ctx) { ctx.self.setVariable("ends", (ctx.self.getVariable("ends") ?? 0) + 1); }`,
};

it("runs authored ActorComponent scripts on independent component instances and destroys them with the owner", async () => {
  const runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: {
      name: "Components", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [],
      actors: [createActor("owner", "Owner", { components: [
        { id: "a", classId: "Counter", properties: { count: 8 } },
        { id: "b", classId: "Counter", properties: {} },
      ] })],
    },
  });
  try {
    await runtime.loadScripts([counter]);
    runtime.realizePlayWorld();
    runtime.start();
    const actor = runtime.getWorld().findActor("owner")!;
    const [a, b] = actor.components;
    expect(a!.getVariable("begins")).toBe(1);
    expect(b!.getVariable("begins")).toBe(1);
    runtime.tick();
    expect(a!.getVariable("count")).toBe(9);
    expect(b!.getVariable("count")).toBe(4);
    a!.setVariable("count", 20);
    expect(b!.getVariable("count")).toBe(4);
    runtime.getWorld().destroyActor(actor.guid);
    runtime.tick();
    expect(a!.destroyed).toBe(true);
    expect(a!.getVariable("ends")).toBe(1);
    expect(b!.getVariable("ends")).toBe(1);
    runtime.stop();
    expect(a!.getVariable("ends")).toBe(1);
  } finally {
    runtime.stop();
  }
});

it("starts prefab and dynamically added components once and ends both on Play stop", async () => {
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true });
  try {
    await runtime.loadScripts([counter, {
      assetGuid: "owner", classId: "Owner", parentClassId: "Actor", anchors: [],
      components: [{ id: "prefab-counter", classId: "Counter", properties: {} }],
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
      source: `export function onBeginPlay(ctx) { ctx.self.setVariable("added", ctx.addComponent(ctx.self, "Counter")); }`,
    }]);
    runtime.start();
    const actor = runtime.spawnScriptedActor({ classId: "Owner" })!;
    const prefab = actor.components[0]!;
    const added = actor.getVariable("added") as ActorComponent;
    expect(added).toBe(actor.components[1]);
    expect(prefab.sourceId).toBe("prefab-counter");
    expect(prefab.getVariable("begins")).toBe(1);
    expect(added.getVariable("begins")).toBe(1);
    runtime.tick();
    expect(prefab.getVariable("count")).toBe(4);
    expect(added.getVariable("count")).toBe(4);
    runtime.stop();
    runtime.stop();
    expect(prefab.getVariable("ends")).toBe(1);
    expect(added.getVariable("ends")).toBe(1);
    expect(prefab.destroyed).toBe(true);
    expect(added.destroyed).toBe(true);
  } finally {
    runtime.stop();
  }
});
