import { expect, it } from "vitest";
import { createActor, createDefaultSceneSettings } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

it("runs separate ComponentLogic instances with their component and disposes them with the actor", async () => {
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: { name: "Logic", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [],
      actors: [createActor("owner", "Owner", { components: ["a", "b", "invalid"].map((id) => ({ id, classId: "LogicComponent", properties: { logicClass: id === "invalid" ? "Actor" : "Counter" } })) })] },
  });
  await runtime.loadScripts([{ assetGuid: "counter", classId: "Counter", parentClassId: "ComponentLogic", anchors: [],
    entryPoints: ["onBeginPlay", "onTick", "onDestroyed"].map((name) => ({ name, event: name, isAsync: false })),
    source: `export function onBeginPlay(ctx) { ctx.self.setVariable("count", 0); if (!ctx.self.getVariable("component").owner.world) throw new Error("Owner must be spawned"); ctx.self.getVariable("component").setVariable("began", true); }
      export function onTick(ctx) { ctx.self.setVariable("count", ctx.self.getVariable("count") + 1); }
      export function onDestroyed(ctx) { ctx.self.getVariable("component").setVariable("ended", true); }`,
  }]);
  runtime.realizePlayWorld();
  runtime.start();
  const actor = runtime.getWorld().findActor("owner")!;
  const [a, b, invalid] = actor.components;
  expect(a!.getVariable("began")).toBe(true);
  expect(a!.logic).not.toBe(b!.logic);
  expect(invalid!.logic).toBeNull();
  runtime.tick();
  expect(a!.logic!.getVariable("count")).toBe(1);
  a!.logic!.setVariable("count", 8);
  expect(b!.logic!.getVariable("count")).toBe(1);
  expect(a!.logic!.getVariable("component")).toBe(a);
  runtime.getWorld().destroyActor(actor.guid);
  runtime.tick();
  expect(a!.getVariable("ended")).toBe(true);
  expect(a!.logic!.destroyed).toBe(true);
  runtime.stop();
});
