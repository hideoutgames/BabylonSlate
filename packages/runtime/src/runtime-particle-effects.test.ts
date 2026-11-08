import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { PARTICLE_TRANSIENT_EFFECT_BUDGET, createActor, createDefaultSceneSettings, type RuntimeAssetCatalogEntry } from "@haptic/core";
import { createInProcessRuntime } from "./driver";

const catalog: RuntimeAssetCatalogEntry[] = [
  { guid: "sparks", name: "Sparks", type: "ParticleSystem", path: "assets/Sparks.particles.hasset", dependencies: [], requiredDependencies: [] },
  { guid: "hero-texture", name: "Hero", type: "Texture", path: "assets/Hero.texture.hasset", dependencies: [], requiredDependencies: [] },
];

/** A Hero whose Begin Play runs `body` (the effects it spawns are logged by guid). */
async function session(body: string[], commands: CommandMessage[]) {
  const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, assetCatalog: catalog,
    playScene: { name: "Test", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [
      createActor("hero", "Hero", { classId: "Hero", transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }),
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

const logged = (commands: CommandMessage[], category: string) =>
  commands.flatMap((command) => (command.type === "log" && command.category === category ? [command.message] : []));
const assignments = (commands: CommandMessage[]) =>
  commands.filter((command): command is Extract<CommandMessage, { type: "assignParticle" }> => command.type === "assignParticle");
/** The generation of the latest Play sent for the actor (Play On Start can wait for owner admission). */
const lastPlay = (commands: CommandMessage[], actorGuid: string) => commands.flatMap((command) =>
  (command.type === "assignParticle" && command.actorGuid === actorGuid && command.play) ||
  (command.type === "setParticlePlaying" && command.actorGuid === actorGuid && command.playing)
    ? [command.generation!] : []).at(-1)!;

describe("Spawn Particles", () => {
  it("spawns an effect that plays at once, hands back its actor in the same frame and destroys itself when it ends", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await session([
      'const effect = ctx.spawnParticlesAtLocation("sparks", { x: 1, y: 2, z: 3 }, { pitch: 0, yaw: 90, roll: 0 }, { x: 2, y: 2, z: 2 }, true);',
      'ctx.log("log", "effect", effect.guid);',
      'ctx.log("log", "position", `${effect.transform.position.x},${effect.transform.position.y},${effect.transform.position.z}`);',
    ], commands);
    const [guid] = logged(commands, "effect");
    expect(logged(commands, "position")).toEqual(["1,2,3"]);
    const effect = runtime.getWorld().findActor(guid!)!;
    expect(effect.classId).toBe("Actor");
    expect(effect.transform.scale).toEqual({ x: 2, y: 2, z: 2 });
    const assignment = assignments(commands).find((command) => command.actorGuid === guid)!;
    expect(assignment).toMatchObject({ particleSystemGuid: "sparks" });
    // Playing by the end of the frame it spawned in.
    expect(lastPlay(commands, guid!)).toBeGreaterThan(0);
    runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: guid!, componentId: assignment.componentId,
      generation: lastPlay(commands, guid!), reason: "finished" });
    runtime.tick();
    expect(runtime.getWorld().findActor(guid!)).toBeUndefined();
    expect(commands.some((command) => command.type === "despawn" && command.actorGuid === guid)).toBe(true);
    runtime.stop();
  });

  it("keeps an effect without Auto Destroy, and ignores a stale report", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await session([
      'ctx.log("log", "effect", ctx.spawnParticlesAtLocation("sparks", { x: 0, y: 0, z: 0 }, undefined, undefined, false).guid);',
      'ctx.log("log", "effect", ctx.spawnParticlesAtLocation("sparks", { x: 0, y: 0, z: 0 }).guid);',
    ], commands);
    const [kept, stale] = logged(commands, "effect");
    for (const guid of [kept!, stale!]) {
      const assignment = assignments(commands).find((command) => command.actorGuid === guid)!;
      runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: guid, componentId: assignment.componentId,
        generation: lastPlay(commands, guid) - (guid === stale ? 1 : 0), reason: "finished" });
    }
    runtime.tick();
    expect(runtime.getWorld().findActor(kept!)).toBeDefined();
    expect(runtime.getWorld().findActor(stale!)).toBeDefined();
    runtime.stop();
  });

  it("attaches to an actor and its bone, and when the parent goes, stops, detaches at its world place and drains", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await session([
      'const effect = ctx.spawnParticlesAttached("sparks", ctx.self, "hand_r", { x: 0, y: 1, z: 0 }, undefined, true);',
      'ctx.log("log", "effect", effect.guid);',
    ], commands);
    const [guid] = logged(commands, "effect");
    const world = runtime.getWorld();
    const effect = world.findActor(guid!)!;
    expect(effect.getVariable("parentId")).toBe("hero");
    expect(commands.some((command) => command.type === "attachToBone" && command.boneName === "hand_r")).toBe(true);
    const assignment = assignments(commands).find((command) => command.actorGuid === guid)!;
    const generation = lastPlay(commands, guid!);
    commands.length = 0;
    world.destroyActor("hero");
    runtime.tick();
    expect(world.findActor("hero")).toBeUndefined();
    expect(effect.destroyed).toBe(false);
    expect(effect.getVariable("parentId")).toBeNull();
    expect(effect.transform.position).toEqual({ x: 10, y: 1, z: 0 });
    expect(commands).toEqual(expect.arrayContaining([
      { type: "setParticlePlaying", actorGuid: guid, componentId: assignment.componentId, playing: false },
    ]));
    runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: guid!, componentId: assignment.componentId,
      generation, reason: "stopped" });
    runtime.tick();
    expect(world.findActor(guid!)).toBeUndefined();
    runtime.stop();
  });

  it("spawns nothing for a guid that is not a Particle System, warning once", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await session([
      'ctx.log("log", "effect", String(ctx.spawnParticlesAtLocation("hero-texture", { x: 0, y: 0, z: 0 })));',
      'ctx.log("log", "effect", String(ctx.spawnParticlesAtLocation("hero-texture", { x: 0, y: 0, z: 0 })));',
      'ctx.log("log", "effect", String(ctx.spawnParticlesAtLocation("", { x: 0, y: 0, z: 0 })));',
      'ctx.log("log", "effect", String(ctx.spawnParticlesAttached("sparks", null, "", { x: 0, y: 0, z: 0 })));',
    ], commands);
    expect(logged(commands, "effect")).toEqual(["null", "null", "null", "null"]);
    expect(logged(commands, "particles").filter((message) => message.startsWith("particle.unknown_system"))).toHaveLength(2);
    expect(assignments(commands).filter((command) => command.particleSystemGuid === "hero-texture")).toEqual([]);
    runtime.stop();
  });

  it("stops the oldest effects beyond the budget and warns once", async () => {
    const commands: CommandMessage[] = [];
    const extra = 3;
    const runtime = await session([
      `for (let i = 0; i < ${PARTICLE_TRANSIENT_EFFECT_BUDGET + extra}; i += 1) ctx.log("log", "effect", ctx.spawnParticlesAtLocation("sparks", { x: i, y: 0, z: 0 }).guid);`,
    ], commands);
    const guids = logged(commands, "effect");
    expect(guids).toHaveLength(PARTICLE_TRANSIENT_EFFECT_BUDGET + extra);
    const stopped = commands.flatMap((command) => (command.type === "setParticlePlaying" && !command.playing ? [command.actorGuid] : []));
    expect(stopped).toEqual(guids.slice(0, extra));
    expect(logged(commands, "particles").filter((message) => message.startsWith("particle.transient_budget"))).toHaveLength(1);
    runtime.stop();
  });
});
