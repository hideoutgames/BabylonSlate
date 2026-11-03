import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultSceneSettings, type SerializedScene } from "@haptic/core";
import { createInProcessRuntime } from "./driver";
import { RuntimeParticles } from "./runtime-particles";

type Assign = Extract<CommandMessage, { type: "assignParticle" }>;
const assign = (componentId: string, play = true): Assign =>
  ({ type: "assignParticle", slotId: 1, actorGuid: "actor", componentId, particleSystemGuid: "system", play });
const playing = (playingFlag: boolean, componentId?: string): CommandMessage =>
  ({ type: "setParticlePlaying", actorGuid: "actor", playing: playingFlag, ...(componentId ? { componentId } : {}) });
const ended = (componentId: string, generation: number, reason: "finished" | "stopped" | "failed" = "finished") =>
  ({ type: "particlePlaybackEnded" as const, actorGuid: "actor", componentId, generation, reason });

/** `prepare` then `observe`, as the driver's `emit` does. */
function send(particles: RuntimeParticles, command: CommandMessage): CommandMessage {
  const prepared = particles.prepare(command);
  particles.observe(prepared);
  return prepared;
}

describe("RuntimeParticles", () => {
  it("gives every Play a newer generation and none to assignments and Stops that do not play", () => {
    const particles = new RuntimeParticles();
    expect(send(particles, assign("a"))).toMatchObject({ generation: 1 });
    expect(send(particles, assign("b", false))).not.toHaveProperty("generation");
    expect(send(particles, playing(true, "b"))).toMatchObject({ generation: 2 });
    // An already playing component still gets a new generation: its end reports carry the latest Play.
    expect(send(particles, playing(true))).toMatchObject({ generation: 3 });
    expect(send(particles, playing(false, "a"))).not.toHaveProperty("generation");
    // A clear never plays.
    expect(send(particles, { ...assign("a"), particleSystemGuid: null })).not.toHaveProperty("generation");
  });

  it("ends playback on a current report and ignores one an earlier Play made stale", () => {
    const particles = new RuntimeParticles();
    send(particles, assign("a"));
    send(particles, assign("b"));
    expect(particles.isPlaying("actor")).toBe(true);
    send(particles, playing(true, "a"));
    // Generation 1 was replaced by generation 3's Play: stale.
    expect(particles.ended(ended("a", 1))).toBe(false);
    expect(particles.isPlaying("actor", "a")).toBe(true);
    expect(particles.ended(ended("a", 3))).toBe(true);
    expect(particles.isPlaying("actor", "a")).toBe(false);
    expect(particles.isPlaying("actor")).toBe(true);
    // A failure ends playback too (the driver runs no event for it).
    expect(particles.ended(ended("b", 2, "failed"))).toBe(true);
    expect(particles.isPlaying("actor")).toBe(false);
    // Stop ends Is Playing at once; the drain's report then runs the event.
    send(particles, playing(true, "a"));
    send(particles, playing(false, "a"));
    expect(particles.isPlaying("actor", "a")).toBe(false);
    expect(particles.ended(ended("a", 4, "stopped"))).toBe(true);
    expect(particles.ended(ended("unknown", 9))).toBe(false);
  });

  it("forgets cleared components and every component when the active Scene changes", () => {
    const particles = new RuntimeParticles();
    send(particles, { type: "activeScene", sceneAssetGuid: "boot" } as CommandMessage);
    send(particles, assign("a"));
    send(particles, { ...assign("a"), particleSystemGuid: null });
    expect(particles.traceState().components).toEqual([]);
    send(particles, assign("a"));
    send(particles, { type: "activeScene", sceneAssetGuid: "boot" } as CommandMessage);
    expect(particles.isPlaying("actor")).toBe(true);
    send(particles, { type: "activeScene", sceneAssetGuid: "next" } as CommandMessage);
    expect(particles.isPlaying("actor")).toBe(false);
  });

  it("restores a trace frame's Play state and generations through the render host", () => {
    const recorded = new RuntimeParticles();
    send(recorded, assign("a"));
    send(recorded, assign("b"));
    send(recorded, assign("c", false));
    recorded.ended(ended("b", 2));
    const frame = recorded.traceState();
    expect(frame).toEqual({
      components: [
        { actorGuid: "actor", componentGuid: "a", playing: true, generation: 1 },
        { actorGuid: "actor", componentGuid: "b", playing: false, generation: 2 },
        { actorGuid: "actor", componentGuid: "c", playing: false, generation: 0 },
      ],
      nextGeneration: 3,
    });

    // A live run whose components all play under other generations.
    const live = new RuntimeParticles();
    for (const id of ["a", "b", "c"]) send(live, assign(id));
    const commands = live.restoreCommands(frame).map((command) => send(live, command));
    expect(commands).toEqual([
      { type: "setParticlePlaying", actorGuid: "actor", componentId: "a", playing: true, generation: 1 },
      { type: "setParticlePlaying", actorGuid: "actor", componentId: "b", playing: false },
      { type: "setParticlePlaying", actorGuid: "actor", componentId: "c", playing: false },
    ]);
    expect(live.traceState().components).toEqual(frame.components);
    // The next Play is newer than any the frame or the live run gave out.
    expect(send(live, playing(true, "a"))).toMatchObject({ generation: 4 });
    // The recorded generation is current again: its report ends playback.
    expect(live.ended(ended("a", 4))).toBe(true);
  });
});

function particleScene(): SerializedScene {
  return {
    name: "Test",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("emitter", "Emitter", {
        classId: "Hero",
        components: [{ id: "sparks", classId: "ParticleComponent", properties: { particleSystemGuid: "system", playOnStart: true } }],
      }),
    ],
  };
}

describe("particle playback reports in the runtime", () => {
  async function runtimeWithHandler(commands: CommandMessage[]) {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: particleScene(), onCommand: (command) => commands.push(command) });
    await runtime.loadScripts([{
      assetGuid: "hero-script",
      classId: "Hero",
      parentClassId: "Actor",
      anchors: [],
      source: [
        "export function onParticlesFinished(ctx) {",
        '  const sparks = ctx.getComponentById(ctx.self, "sparks");',
        '  const playing = ctx.callComponentFunction(sparks, "isParticlesPlaying", {}).playing;',
        '  ctx.log("log", "Finished", `${ctx.args.reason}:${playing}:${ctx.isParticlesPlaying(ctx.self)}`);',
        "}",
      ].join("\n"),
      entryPoints: [{ name: "onParticlesFinished", event: "onParticlesFinished", isAsync: false, componentId: "sparks" }],
    }]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    return runtime;
  }
  /** The generation of the latest Play sent for the component (Play On Start waits for owner admission). */
  const lastPlay = (commands: CommandMessage[]) => commands.flatMap((command) =>
    (command.type === "assignParticle" && command.play) || (command.type === "setParticlePlaying" && command.playing)
      ? [command.generation!] : []).at(-1)!;
  const finishedLogs = (commands: CommandMessage[]) =>
    commands.flatMap((command) => (command.type === "log" && command.category === "Finished" ? [command.message] : []));

  it("runs Event On Particles Finished with its Reason for a current report and never for a stale or failed one", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWithHandler(commands);
    const generation = lastPlay(commands);
    expect(generation).toBeGreaterThan(0);

    runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: "emitter", componentId: "sparks",
      generation: generation - 1, reason: "finished" });
    expect(finishedLogs(commands)).toEqual([]);
    runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: "emitter", componentId: "sparks",
      generation, reason: "finished" });
    // Is Playing has already flipped when the event runs.
    expect(finishedLogs(commands)).toEqual(["Finished:false:false"]);
    runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: "emitter", componentId: "sparks",
      generation, reason: "failed" });
    expect(finishedLogs(commands)).toEqual(["Finished:false:false"]);
    runtime.stop();
  });

  it("reports Stopped for a drain that Stop started", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWithHandler(commands);
    const generation = lastPlay(commands);
    runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: "emitter", componentId: "sparks",
      generation, reason: "stopped" });
    expect(finishedLogs(commands)).toEqual(["Stopped:false:false"]);
    runtime.stop();
  });

  it("records the playing flag and generation in trace frames and restores them", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWithHandler(commands);
    runtime.executeConsoleCommand("snapshot start");
    runtime.tick();
    runtime.executeConsoleCommand("snapshot stop");
    const frame = runtime.stopTrace()!.frames[0]!;
    const generation = lastPlay(commands);
    expect(frame.particles).toEqual({
      components: [{ actorGuid: "emitter", componentGuid: "sparks", playing: true, generation }],
      nextGeneration: generation + 1,
    });
    // The run then finishes; a restore plays it again under the recorded generation.
    runtime.applyParticlePlaybackEnded({ type: "particlePlaybackEnded", actorGuid: "emitter", componentId: "sparks",
      generation, reason: "finished" });
    commands.length = 0;
    runtime.restoreFromTrace(frame);
    expect(commands.filter((command) => command.type === "setParticlePlaying")).toEqual([
      { type: "setParticlePlaying", actorGuid: "emitter", componentId: "sparks", playing: true, generation },
    ]);
    runtime.stop();
  });
});

describe("Retrigger and Restart Particles", () => {
  it("sends the component's Retrigger with its assignment and restart with Restart Particles", async () => {
    const commands: CommandMessage[] = [];
    const scene = particleScene();
    scene.actors[0]!.components![0]!.properties.retrigger = "restart";
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene, onCommand: (command) => commands.push(command) });
    await runtime.loadScripts([{ assetGuid: "hero-script", classId: "Hero", parentClassId: "Actor", anchors: [],
      source: [
        "export function onBeginPlay(ctx) {",
        "  ctx.restartParticles(ctx.self);",
        '  ctx.callComponentFunction(ctx.getComponentById(ctx.self, "sparks"), "restartParticles", {});',
        '  ctx.callComponentFunction(ctx.getComponentById(ctx.self, "sparks"), "playParticles", {});',
        "}",
      ].join("\n"),
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }] }]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.find((command) => command.type === "assignParticle")).toMatchObject({ componentId: "sparks", retrigger: "restart" });
    const plays = commands.filter((command) => command.type === "setParticlePlaying");
    expect(plays.map((command) => ({ componentId: command.componentId, restart: command.restart }))).toEqual(expect.arrayContaining([
      { componentId: undefined, restart: true },
      { componentId: "sparks", restart: true },
      { componentId: "sparks", restart: undefined },
    ]));
    // Every Restart is a Play with a newer generation.
    const generations = plays.map((command) => command.generation!);
    expect([...generations].sort((a, b) => a - b)).toEqual(generations);
    runtime.stop();
  });
});

