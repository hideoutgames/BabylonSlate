import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultSceneSettings, type ParticleParameterCatalog, type SerializedScene } from "@haptic/core";
import { createInProcessRuntime } from "./driver";
import { RuntimeParticles } from "./runtime-particles";

const catalog: ParticleParameterCatalog = {
  sparksSystem: [
    { name: "Heat", type: "float", defaultValue: [2] },
    { name: "Tint", type: "color", defaultValue: [1, 1, 1, 1] },
  ],
  smokeSystem: [{ name: "Heat", type: "vec3", defaultValue: [0, 0, 0] }],
};

function scene(): SerializedScene {
  return {
    name: "Test",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("emitter", "Emitter", {
        classId: "Hero",
        components: [
          { id: "sparks", classId: "ParticleComponent", properties: { particleSystemGuid: "sparksSystem", playOnStart: true,
            parameterOverrides: { Tint: [0, 1, 0, 1] } } },
          { id: "smoke", classId: "ParticleComponent", properties: { particleSystemGuid: "smokeSystem", playOnStart: true } },
        ],
      }),
    ],
  };
}

async function runtimeWith(source: string[], commands: CommandMessage[]) {
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, playScene: scene(),
    particleParameterCatalog: catalog, onCommand: (command) => commands.push(command) });
  await runtime.loadScripts([{
    assetGuid: "hero-script",
    classId: "Hero",
    parentClassId: "Actor",
    anchors: [],
    source: source.join("\n"),
    entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
  }]);
  runtime.start();
  runtime.realizePlayWorld();
  runtime.tick();
  return runtime;
}

const parameterCommands = (commands: CommandMessage[]) => commands.filter((command) => command.type === "setParticleParameter");
const logs = (commands: CommandMessage[], category: string) =>
  commands.flatMap((command) => (command.type === "log" && command.category === category ? [command.message] : []));

describe("particle parameters in Class graphs", () => {
  it("set, read and reset values on the components whose System declares the name, sized to its type", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWith([
      "export function onBeginPlay(ctx) {",
      '  const sparks = ctx.getComponentById(ctx.self, "sparks");',
      '  const log = (value) => ctx.log("log", "P", JSON.stringify(value));',
      '  log(ctx.getParticleFloatParameter(ctx.self, "Heat"));',
      '  ctx.setParticleFloatParameter(ctx.self, "Heat", 5);',
      '  log(ctx.getParticleFloatParameter(ctx.self, "Heat"));',
      '  log(ctx.getParticleColorParameter(ctx.self, "Tint"));',
      '  ctx.callComponentFunction(sparks, "setParticleColorParameter", { name: "Tint", value: { x: 1, y: 0, z: 0, w: 0.5 } });',
      '  log(ctx.callComponentFunction(sparks, "getParticleColorParameter", { name: " Tint " }));',
      '  log(ctx.resetParticleParameter(ctx.self, "Tint"));',
      "}",
    ], commands);
    expect(logs(commands, "P")).toEqual([
      JSON.stringify({ found: true, value: 2 }),
      JSON.stringify({ found: true, value: 5 }),
      // The component's override, before any runtime value.
      JSON.stringify({ found: true, value: { x: 0, y: 1, z: 0, w: 1 } }),
      JSON.stringify({ found: true, value: { x: 1, y: 0, z: 0, w: 0.5 } }),
      "true",
    ]);
    expect(parameterCommands(commands)).toEqual([
      { type: "setParticleParameter", actorGuid: "emitter", componentId: "sparks", name: "Heat", value: [5] },
      { type: "setParticleParameter", actorGuid: "emitter", componentId: "smoke", name: "Heat", value: [5, 5, 5] },
      { type: "setParticleParameter", actorGuid: "emitter", componentId: "sparks", name: "Tint", value: [1, 0, 0, 0.5] },
      // Reset goes back to the override.
      { type: "setParticleParameter", actorGuid: "emitter", componentId: "sparks", name: "Tint", value: [0, 1, 0, 1] },
    ]);
    runtime.stop();
  });

  it("ignores a name no System declares, warning once per name", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWith([
      "export function onBeginPlay(ctx) {",
      '  ctx.setParticleFloatParameter(ctx.self, "Missing", 1);',
      '  ctx.setParticleFloatParameter(ctx.self, "Missing", 2);',
      '  ctx.log("log", "P", JSON.stringify([ctx.getParticleFloatParameter(ctx.self, "Missing"), ctx.resetParticleParameter(ctx.self, "Missing")]));',
      '  ctx.callComponentFunction(ctx.getComponentById(ctx.self, "smoke"), "setParticleFloatParameter", { name: "Tint", value: 1 });',
      "}",
    ], commands);
    expect(parameterCommands(commands)).toEqual([]);
    expect(logs(commands, "P")).toEqual([JSON.stringify([{ found: false, value: 0 }, false])]);
    const warnings = commands.filter((command) => command.type === "log" && command.category === "Particles");
    expect(warnings.map((command) => command.type === "log" && command.severity)).toEqual(["warning", "warning"]);
    expect(warnings.map((command) => command.type === "log" && command.message.match(/"(\w+)"/)?.[1])).toEqual(["Missing", "Tint"]);
    runtime.stop();
  });

  it("keeps runtime values in later assignments and records and restores them through trace frames", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWith([
      "export function onBeginPlay(ctx) {",
      '  ctx.setParticleFloatParameter(ctx.self, "Heat", 5);',
      "}",
    ], commands);
    runtime.executeConsoleCommand("snapshot start");
    runtime.tick();
    runtime.executeConsoleCommand("snapshot stop");
    const frame = runtime.stopTrace()!.frames[0]!;
    expect(frame.particles?.parameters).toEqual([
      { actorGuid: "emitter", componentGuid: "sparks", values: { Heat: [5] } },
      { actorGuid: "emitter", componentGuid: "smoke", values: { Heat: [5, 5, 5] } },
    ]);
    commands.length = 0;
    runtime.restoreFromTrace(frame);
    expect(parameterCommands(commands)).toEqual([
      { type: "setParticleParameter", actorGuid: "emitter", componentId: "sparks", name: "Heat", value: [5] },
      { type: "setParticleParameter", actorGuid: "emitter", componentId: "smoke", name: "Heat", value: [5, 5, 5] },
    ]);
    runtime.stop();
  });
});

describe("RuntimeParticles parameter values", () => {
  const assign = (componentId: string, parameters?: Record<string, number[]>): CommandMessage =>
    ({ type: "assignParticle", slotId: 1, actorGuid: "actor", componentId, particleSystemGuid: "system", play: false,
      ...(parameters ? { parameters } : {}) });

  it("merge runtime values over the assignment's overrides and forget them when the component goes", () => {
    const particles = new RuntimeParticles();
    particles.setValue("actor", "a", "Heat", [5]);
    expect(particles.prepare(assign("a", { Heat: [1], Tint: [0, 1, 0, 1] }))).toMatchObject({ parameters: { Heat: [5], Tint: [0, 1, 0, 1] } });
    expect(particles.prepare(assign("b"))).not.toHaveProperty("parameters");
    particles.observe({ type: "assignParticle", slotId: 1, actorGuid: "actor", componentId: "a", particleSystemGuid: null });
    expect(particles.value("actor", "a", "Heat")).toBeUndefined();
  });

  it("restore resets values set after the frame to the override, or to the default without one", () => {
    const particles = new RuntimeParticles();
    particles.setValue("actor", "a", "Heat", [5]);
    const frame = particles.traceState();
    particles.setValue("actor", "a", "Tint", [1, 0, 0, 1]);
    particles.setValue("actor", "b", "Heat", [9]);
    const overrides = (_actor: string, component: string): Record<string, number[]> => (component === "a" ? { Tint: [0, 1, 0, 1] } : {});
    expect(particles.restoreParameterCommands(frame, overrides)).toEqual([
      { type: "setParticleParameter", actorGuid: "actor", componentId: "b", name: "Heat", value: null },
      { type: "setParticleParameter", actorGuid: "actor", componentId: "a", name: "Tint", value: [0, 1, 0, 1] },
      { type: "setParticleParameter", actorGuid: "actor", componentId: "a", name: "Heat", value: [5] },
    ]);
    expect(particles.traceState().parameters).toEqual(frame.parameters);
  });
});
