import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedActor,
  type SerializedScene,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function sceneOf(actors: SerializedActor[]): SerializedScene {
  return {
    name: "Components",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors,
  };
}

function componentScript(
  classId: string,
  source: string,
  extra: Partial<CompiledScript> = {},
): CompiledScript {
  return {
    assetGuid: `${classId}-script`,
    classId,
    parentClassId: "ActorComponent",
    source,
    anchors: [],
    entryPoints: ["onBeginPlay", "onTick", "onDestroyed"].map((name) => ({
      name, event: name, isAsync: false,
    })),
    ...extra,
  };
}

describe("ActorComponent lifecycle boundaries", () => {
  it("dispatches Destroyed once when a component queues owner destruction then quits", async () => {
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneOf([createActor("owner", "Owner", {
        components: [{ id: "quitter", classId: "Quitter", properties: {} }],
      })]),
    });
    try {
      await runtime.loadScripts([componentScript("Quitter", `
        export function onTick(ctx) {
          ctx.destroyActor(ctx.self.owner);
          ctx.executeConsoleCommand("quit");
        }
        export function onDestroyed(ctx) {
          ctx.setVariable("destroyedCount", (ctx.getVariable("destroyedCount") ?? 0) + 1);
        }
      `)]);
      await runtime.realizePlayWorld();
      const component = runtime.getWorld().findActor("owner")!.components[0]!;
      runtime.start();
      runtime.tick();
      expect(runtime.getWorld().findActor("owner")).toBeUndefined();
      expect(component.destroyed).toBe(true);
      expect(component.getVariable("destroyedCount")).toBe(1);
    } finally {
      runtime.stop();
    }
  });

  it("refuses component creation requested by Destroyed during Stop", async () => {
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneOf([createActor("owner", "Owner", {
        components: [{ id: "source", classId: "Source", properties: {} }],
      })]),
    });
    try {
      await runtime.loadScripts([
        componentScript("Source", `
          export function onDestroyed(ctx) {
            ctx.setVariable("replacement", ctx.addComponent(ctx.self.owner, "Replacement"));
          }
        `),
        componentScript("Replacement", `
          export function onBeginPlay(ctx) {
            ctx.self.owner.setVariable("replacementBegan", true);
          }
        `),
      ]);
      await runtime.realizePlayWorld();
      const owner = runtime.getWorld().findActor("owner")!;
      const component = owner.components[0]!;
      runtime.stop();
      expect(component.getVariable("replacement")).toBeNull();
      expect(owner.components).toEqual([component]);
      expect(owner.getVariable("replacementBegan")).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });

  it("allows Actor Begin Play to call an authored component interface before component Begin Play", async () => {
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: sceneOf([createActor("owner", "Owner", {
        classId: "Owner",
        components: [{ id: "health", classId: "Health", properties: {} }],
      })]),
    });
    try {
      runtime.getWorld().interfaceRegistry.register({
        guid: "damageable", name: "Damageable",
        methods: [{ name: "Damage", outputs: { health: -1 } }],
      });
      await runtime.loadScripts([
        componentScript("Health", `
          export function damage(ctx) {
            const health = ctx.getVariable("health") - ctx.args.amount;
            ctx.setVariable("health", health);
            return { health };
          }
          export function onBeginPlay(ctx) {
            ctx.setVariable("healthAtBeginPlay", ctx.getVariable("health"));
          }
        `, {
          variables: [{ name: "health", type: "float", defaultValue: 50 }],
          implementedInterfaces: ["damageable"],
          interfaceImplementations: [{
            interfaceGuid: "damageable", method: "Damage", exportName: "damage",
          }],
        }),
        componentScript("Owner", `
          export function onBeginPlay(ctx) {
            const health = ctx.getComponent(ctx.self, "Health");
            const result = ctx.callInterface(health, "damageable", "Damage", { amount: 17 });
            ctx.setVariable("healthResult", result.health);
          }
        `, { parentClassId: "Actor" }),
      ]);
      await runtime.realizePlayWorld();
      const owner = runtime.getWorld().findActor("owner")!;
      const health = owner.components[0]!;
      expect(owner.getVariable("healthResult")).toBe(33);
      expect(health.getVariable("health")).toBe(33);
      expect(health.getVariable("healthAtBeginPlay")).toBe(33);
    } finally {
      runtime.stop();
    }
  });

  it("does not begin remaining components after a cooperative scene change", async () => {
    const messages: string[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      cooperativeSceneLoading: true,
      playSceneGuid: "first",
      sceneLibrary: { next: sceneOf([]) },
      playScene: sceneOf([createActor("owner", "Owner", {
        components: [
          { id: "change", classId: "ChangeScene", properties: {} },
          { id: "later", classId: "Later", properties: {} },
        ],
      })]),
      onCommand: (command) => {
        if (command.type === "log" && command.category === "Lifecycle") {
          messages.push(command.message);
        }
      },
    });
    try {
      await runtime.loadScripts([
        componentScript("ChangeScene", `
          export function onBeginPlay(ctx) {
            ctx.log("log", "Lifecycle", "change");
            ctx.changeScene("next");
          }
        `),
        componentScript("Later", `
          export function onBeginPlay(ctx) { ctx.log("log", "Lifecycle", "later"); }
        `),
      ]);
      await runtime.realizePlayWorld();
      expect(runtime.getWorld().currentScene?.assetGuid).toBe("next");
      expect(runtime.getWorld().findActor("owner")).toBeUndefined();
      expect(messages).toEqual(["change"]);
    } finally {
      runtime.stop();
    }
  });
});
