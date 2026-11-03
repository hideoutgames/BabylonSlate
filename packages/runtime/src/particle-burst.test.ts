import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultSceneSettings } from "@haptic/core";
import { createAudioHostBindings } from "./audio-particle-emitter";
import { createInProcessRuntime } from "./driver";

describe("Emit Particle Burst commands", () => {
  it("sends whole positive counts, a slot only when one is chosen, and the component when one is named", () => {
    const commands: CommandMessage[] = [];
    const bindings = createAudioHostBindings({ frameId: () => 0, scriptVoiceId: () => "v", emit: (command) => commands.push(command) });
    bindings.emitParticleBurst!("actor", 12.7, -1);
    bindings.emitParticleBurst!("actor", 3, 2, "sparks");
    bindings.emitParticleBurst!("actor", 0, 0);
    bindings.emitParticleBurst!("actor", -4, 0);
    bindings.emitParticleBurst!("actor", Number.NaN, 0);
    expect(commands).toEqual([
      { type: "emitParticleBurst", actorGuid: "actor", count: 12 },
      { type: "emitParticleBurst", actorGuid: "actor", count: 3, slot: 2, componentId: "sparks" },
    ]);
  });

  it("reaches the render host from the Particle component's Emit Burst", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { name: "Test", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [
        createActor("emitter", "Emitter", { classId: "Hero", components: [
          { id: "sparks", classId: "ParticleComponent", properties: { particleSystemGuid: "system", playOnStart: true } },
        ] }),
      ] },
      onCommand: (command) => commands.push(command) });
    await runtime.loadScripts([{ assetGuid: "hero", classId: "Hero", parentClassId: "Actor", anchors: [],
      source: [
        "export function onBeginPlay(ctx) {",
        '  const sparks = ctx.getComponentById(ctx.self, "sparks");',
        '  ctx.callComponentFunction(sparks, "emitParticleBurst", { count: 6, slot: 1 });',
        '  ctx.callComponentFunction(sparks, "emitParticleBurst", { count: 4 });',
        "}",
      ].join("\n"),
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }] }]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "emitParticleBurst")).toEqual([
      { type: "emitParticleBurst", actorGuid: "emitter", count: 6, slot: 1, componentId: "sparks" },
      { type: "emitParticleBurst", actorGuid: "emitter", count: 4, componentId: "sparks" },
    ]);
    runtime.stop();
  });
});
