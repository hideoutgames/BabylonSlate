import { describe, expect, it } from "vitest";
import type { CommandMessage, RuntimeInspectorAction } from "@haptic/bridge";
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
  it("set, read and reset a component's values when its System declares the name, sized to its type", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWith([
      "export function onBeginPlay(ctx) {",
      '  const sparks = ctx.getComponentById(ctx.self, "sparks");',
      '  const smoke = ctx.getComponentById(ctx.self, "smoke");',
      '  const call = (component, name, args) => ctx.callComponentFunction(component, name, args);',
      '  const log = (value) => ctx.log("log", "P", JSON.stringify(value));',
      '  log(call(sparks, "getParticleFloatParameter", { name: "Heat" }));',
      '  call(sparks, "setParticleFloatParameter", { name: "Heat", value: 5 });',
      '  call(smoke, "setParticleFloatParameter", { name: "Heat", value: 5 });',
      '  log(call(sparks, "getParticleFloatParameter", { name: "Heat" }));',
      '  log(call(sparks, "getParticleColorParameter", { name: "Tint" }));',
      '  call(sparks, "setParticleColorParameter", { name: "Tint", value: { x: 1, y: 0, z: 0, w: 0.5 } });',
      '  log(call(sparks, "getParticleColorParameter", { name: " Tint " }));',
      '  log(call(sparks, "resetParticleParameter", { name: "Tint" }).success);',
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
      '  const sparks = ctx.getComponentById(ctx.self, "sparks");',
      '  const call = (component, name, args) => ctx.callComponentFunction(component, name, args);',
      '  call(sparks, "setParticleFloatParameter", { name: "Missing", value: 1 });',
      '  call(sparks, "setParticleFloatParameter", { name: "Missing", value: 2 });',
      '  ctx.log("log", "P", JSON.stringify([call(sparks, "getParticleFloatParameter", { name: "Missing" }), call(sparks, "resetParticleParameter", { name: "Missing" }).success]));',
      '  call(ctx.getComponentById(ctx.self, "smoke"), "setParticleFloatParameter", { name: "Tint", value: 1 });',
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
      '  for (const id of ["sparks", "smoke"]) {',
      '    ctx.callComponentFunction(ctx.getComponentById(ctx.self, id), "setParticleFloatParameter", { name: "Heat", value: 5 });',
      "  }",
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

describe("Parameter Overrides and live edits", () => {
  it("send the component's overrides with its assignment, and none without", async () => {
    const commands: CommandMessage[] = [];
    const runtime = await runtimeWith(["export function onBeginPlay(ctx) {}"], commands);
    const assignments = commands.filter((command) => command.type === "assignParticle");
    expect(assignments.find((command) => command.componentId === "sparks")).toMatchObject({ parameters: { Tint: [0, 1, 0, 1] } });
    expect(assignments.find((command) => command.componentId === "smoke")).not.toHaveProperty("parameters");
    runtime.stop();
  });

  it("list a Particle component's parameters in the Simulation Inspector and set them live", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, sessionGeneration: 2,
      sessionMode: "simulate", playSceneGuid: "root", playScene: scene(), particleParameterCatalog: catalog,
      onCommand: (command) => commands.push(command) });
    await runtime.loadScripts([{ classId: "Hero", assetGuid: "hero-script", parentClassId: "Actor", source: "", anchors: [], entryPoints: [] }]);
    runtime.realizePlayWorld();
    runtime.start();
    try {
      let requestId = 0;
      const request = (action: RuntimeInspectorAction) => runtime.requestRuntimeInspector({ sessionGeneration: 2, requestId: ++requestId, action });
      const tree = await request({ kind: "identities" });
      const rows = tree.payload?.kind === "identities" ? tree.payload.rows : [];
      const sparks = rows.find((row) => row.kind === "component" && row.identity.componentGuid === "sparks")!.identity;
      runtime.pause();
      const selection = await request({ kind: "selection", target: sparks });
      expect(selection.payload).toMatchObject({ kind: "selection", properties: expect.arrayContaining([
        expect.objectContaining({ key: "particle:Heat", typeId: "particle:float", capability: "live", value: 2 }),
        expect.objectContaining({ key: "particle:Tint", typeId: "particle:color", capability: "live", value: { x: 0, y: 1, z: 0, w: 1 } }),
      ]) });
      commands.length = 0;
      const heat = await request({ kind: "setProperty", target: sparks, sequence: 1, property: "particle:Heat", value: 7 });
      expect(heat).toMatchObject({ success: true, payload: { kind: "mutation", effectiveValue: 7 } });
      expect((await request({ kind: "setProperty", target: sparks, sequence: 2, property: "particle:Tint", value: { x: 1, y: 2 } })).success).toBe(false);
      expect((await request({ kind: "setProperty", target: sparks, sequence: 3, property: "particle:Tint",
        value: { x: 1, y: 0.5, z: 0, w: 1 } })).success).toBe(true);
      expect(commands.filter((command) => command.type === "setParticleParameter")).toEqual([
        { type: "setParticleParameter", actorGuid: "emitter", componentId: "sparks", name: "Heat", value: [7] },
        { type: "setParticleParameter", actorGuid: "emitter", componentId: "sparks", name: "Tint", value: [1, 0.5, 0, 1] },
      ]);
    } finally { runtime.stop(); }
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
