import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { DECAL_CLASS_ID, createActor, createDefaultSceneSettings, identitySerializedTransform } from "@haptic/core";
import { createInProcessRuntime } from "./driver";

/** A Hero whose Begin Play runs `body`, beside a decal actor with its own Material values. */
async function session(body: string[], commands: CommandMessage[]) {
  const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, assetCatalog: [],
    playScene: { name: "Test", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [
      createActor("hero", "Hero", { classId: "Hero" }),
      createActor("mark", "Mark", { components: [{
        id: "decal", classId: DECAL_CLASS_ID, transform: identitySerializedTransform(),
        properties: { materialGuid: "mud", tint: [1, 0.5, 0.5], opacity: 0.75 },
        materialInstance: { materialGuid: "mud", parameters: { Wetness: { kind: "float", value: 0.8 } } },
      }] }),
    ] },
    onCommand: (command) => commands.push(command) });
  await runtime.loadScripts([{ assetGuid: "hero-script", classId: "Hero", parentClassId: "Actor", anchors: [],
    source: ["export function onBeginPlay(ctx) {", ...body, "}"].join("\n"),
    entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }] }]);
  runtime.start();
  runtime.realizePlayWorld();
  runtime.tick();
  return runtime;
}

describe("decals in Play", () => {
  it("spawns a decal of a Material with its own Tint and Opacity, clamped, and none without a Material", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await session([
      'ctx.spawnDecal("scorch", { x: 1, y: 2, z: 3 }, { pitch: 0, yaw: 0, roll: 0 }, { x: 2, y: 1, z: 2 }, 5, 1, { x: 2, y: 0.5, z: -1, w: 1 }, 1.5);',
      'ctx.spawnDecal("", { x: 0, y: 0, z: 0 }, undefined);',
    ], commands);
    const spawned = commands.filter((command): command is Extract<CommandMessage, { type: "spawnDecal" }> => command.type === "spawnDecal");
    expect(spawned.map((command) => command.decal)).toEqual([{
      materialGuid: "scorch",
      tint: [1, 0.5, 0],
      opacity: 1,
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      size: [2, 1, 2],
      lifetime: 5,
      fadeOutDuration: 1,
    }]);
    runtime.stop();
  });

  it("sends an authored decal's Material, Tint, Opacity and its own Material values", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await session([], commands);
    const decals = commands.filter((command): command is Extract<CommandMessage, { type: "setDecals" }> => command.type === "setDecals").at(-1)!;
    expect(decals.decals).toEqual([expect.objectContaining({
      id: "decal",
      properties: expect.objectContaining({ materialGuid: "mud", tint: [1, 0.5, 0.5], opacity: 0.75 }),
      materialInstance: { materialGuid: "mud", parameters: { Wetness: { kind: "float", value: 0.8 } } },
    })]);
    runtime.stop();
  });
});
