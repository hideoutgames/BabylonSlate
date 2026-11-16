import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import {
  createActor,
  createDefaultSceneLayer,
  createDefaultSceneSettings,
  createMeshComponent,
  type SerializedActor,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@haptic/core";
import { createInProcessRuntime } from "./driver";
import type { RuntimePropertyWrites } from "./runtime-property-writes";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import type { CompiledScript } from "./script-host";

type Runtime = ReturnType<typeof createInProcessRuntime>;
/** The in-process driver's property write and Scene Layer layout seams. */
const internals = (runtime: Runtime) => runtime as unknown as { propertyWrites: RuntimePropertyWrites; overlay: SceneLayerOverlay };

function sceneOf(actors: SerializedActor[]): SerializedScene {
  return { name: "Test", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors };
}

function tickScript(classId: string, body: string[], extra?: Partial<CompiledScript>): CompiledScript {
  return {
    assetGuid: `${classId}-script`, classId, parentClassId: "Actor", anchors: [],
    source: ["export function onTick(ctx) {", '  if (ctx.getVariable("writes") !== true) return;', ...body.map((line) => `  ${line}`), "}"].join("\n"),
    entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
    ...extra,
  };
}

/** Writes each named property's current value back, so every write is unchanged. */
const rewrite = (componentId: string, names: readonly string[]) => [
  `{ const c = ctx.getComponentById(ctx.self, ${JSON.stringify(componentId)});`,
  ...names.map((name) => `  ctx.setVariableOn(c, ${JSON.stringify(name)}, ctx.getVariableFrom(c, ${JSON.stringify(name)}));`),
  "}",
];

const hero = () => createActor("hero", "Hero", { classId: "Hero", components: [
  createMeshComponent("mesh"),
  { id: "rb", classId: "RigidBodyComponent", properties: { motionType: "kinematic", mass: 2, gravityScale: 0 } },
  { id: "col", classId: "ColliderComponent", properties: { shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }, isTrigger: false } },
  { id: "ink", classId: "OutlineComponent", properties: { width: 2, color: [0.1, 0.2, 0.3], throughMeshes: false } },
  { id: "fog", classId: "FogVolumeComponent", properties: { shape: "sphere", density: 0.2, size: [4, 6, 8] } },
] });

const hud = (): SerializedSceneLayer => ({
  ...createDefaultSceneLayer(), name: "HUD",
  actors: [createActor("panel", "Panel", { classId: "Hud", components: [
    { id: "score", classId: "2DTextComponent", properties: { text: "0", size: 24, bold: false, wrapWidth: 200, wrapHeight: 100 } },
    { id: "label", classId: "2DTextComponent", properties: { text: "Score", size: 18, wrapWidth: 200, wrapHeight: 100 } },
  ] })],
});

const runtimes: Runtime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.stop(); });

async function start(options: { actors: SerializedActor[]; scripts: CompiledScript[]; layer?: SerializedSceneLayer; physics?: boolean; presets?: boolean }) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, dt: 1 / 60,
    ...(options.physics ? { physicsWorld: "3d" as const } : {}),
    ...(options.presets ? { collisionPresets: [{ id: "solid", name: "Solid", layer: 1, mask: 3, overlapMask: 0 }] } : {}),
    playScene: sceneOf(options.actors), onCommand: (command) => commands.push(command),
    ...(options.layer ? { sceneLayerLibrary: { hud: options.layer } } : {}) });
  runtimes.push(runtime);
  await runtime.loadScripts(options.scripts);
  await runtime.realizePlayWorld();
  const layer = options.layer ? runtime.createSceneLayer("hud", 0) : null;
  runtime.start();
  runtime.tick();
  return { runtime, commands, layer };
}

/** Commands one tick sends, by type. */
function tickCommands(runtime: Runtime, commands: CommandMessage[]): Record<string, number> {
  const from = commands.length;
  runtime.tick();
  const counts: Record<string, number> = {};
  for (const command of commands.slice(from)) counts[command.type] = (counts[command.type] ?? 0) + 1;
  return counts;
}

describe("unchanged component property writes", () => {
  it("send nothing for ten unchanged writes on Tick, read back, and sync no physics or layout", async () => {
    const { runtime, commands, layer } = await start({
      actors: [hero()], layer: hud(), physics: true,
      scripts: [
        tickScript("Hero", [...rewrite("rb", ["mass", "gravityScale"]), ...rewrite("col", ["isTrigger"]), ...rewrite("ink", ["width"]), ...rewrite("fog", ["density"]),
          'ctx.setVariable("readBack", ctx.getVariableFrom(ctx.getComponentById(ctx.self, "fog"), "density"));']),
        tickScript("Hud", [...rewrite("score", ["text", "size", "bold"]), ...rewrite("label", ["text"]),
          'ctx.callComponentFunction(ctx.getComponentById(ctx.self, "label"), "setText", { text: "Score" });']),
      ],
    });
    const world = runtime.getWorld();
    const actors = [world.findActor("hero")!, world.findActor(`${layer!.guid}:panel`)!];
    const idle = tickCommands(runtime, commands);
    const refresh = vi.spyOn(internals(runtime).propertyWrites, "refreshComponent");
    const sync = runtime.getPhysicsSync()!;
    const applyComponent = vi.spyOn(sync, "applyComponent");
    const syncActor = vi.spyOn(sync, "syncActor");
    const layouts = vi.spyOn(internals(runtime).overlay, "applyLayouts");
    const idleLayouts = (tickCommands(runtime, commands), layouts.mock.calls.length);
    layouts.mockClear();
    for (const actor of actors) actor.setVariable("writes", true);
    const writing = tickCommands(runtime, commands);
    expect(writing).toEqual(idle);
    expect(refresh).not.toHaveBeenCalled();
    expect(applyComponent).not.toHaveBeenCalled();
    expect(syncActor).not.toHaveBeenCalled();
    expect(layouts).toHaveBeenCalledTimes(idleLayouts);
    expect(actors[0]!.getVariable("readBack")).toBe(0.2);
  });

  it("applies a changed write exactly as before", async () => {
    const { runtime, commands } = await start({ actors: [hero()], physics: true,
      scripts: [tickScript("Hero", ['ctx.setVariableOn(ctx.getComponentById(ctx.self, "fog"), "density", 0.5);', 'ctx.setVariableOn(ctx.getComponentById(ctx.self, "rb"), "mass", 3);'])] });
    const actor = runtime.getWorld().findActor("hero")!;
    actor.setVariable("writes", true);
    const applyComponent = vi.spyOn(runtime.getPhysicsSync()!, "applyComponent");
    const changed = tickCommands(runtime, commands);
    expect(commands.filter((command) => command.type === "setFogVolumes").at(-1)).toMatchObject({ volumes: [{ properties: { density: 0.5 } }] });
    expect(changed.setFogVolumes).toBe(2);
    expect(applyComponent).toHaveBeenCalledTimes(2);
    // The same values on the next tick are unchanged.
    const again = tickCommands(runtime, commands);
    expect(again.setFogVolumes).toBeUndefined();
    expect(applyComponent).toHaveBeenCalledTimes(2);
  });

  it("applies an array mutated in place and written back", async () => {
    const { runtime, commands } = await start({ actors: [hero()],
      scripts: [tickScript("Hero", ['const c = ctx.getComponentById(ctx.self, "ink"); const color = ctx.getVariableFrom(c, "color"); color[0] = 1; ctx.setVariableOn(c, "color", color);'])] });
    runtime.getWorld().findActor("hero")!.setVariable("writes", true);
    tickCommands(runtime, commands);
    expect(commands.filter((command) => command.type === "setActorOutlines").at(-1)).toMatchObject({ outlines: [{ id: "ink", color: [1, 0.2, 0.3] }] });
  });

  it("still makes an equal Layer write Custom", async () => {
    const { runtime } = await start({ actors: [createActor("hero", "Hero", { classId: "Hero", components: [
      { id: "col", classId: "ColliderComponent", properties: { shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }, collisionPreset: "solid", layer: 1 } },
    ] })], physics: true, presets: true,
    scripts: [tickScript("Hero", rewrite("col", ["layer"]))] });
    const actor = runtime.getWorld().findActor("hero")!;
    const collider = actor.components.find((component) => component.guid === "col")!;
    expect(collider.getVariable("collisionPreset")).toBe("solid");
    actor.setVariable("writes", true);
    runtime.tick();
    expect(collider.getVariable("collisionPreset")).toBe("custom");
  });

  it("still re-sends a Particle component on an equal write", async () => {
    const { runtime, commands } = await start({ actors: [createActor("fx", "Sparks", { classId: "Hero", components: [
      { id: "sparks", classId: "ParticleComponent", properties: { particleSystemGuid: "sys-1", playOnStart: true } },
    ] })], scripts: [tickScript("Hero", rewrite("sparks", ["playOnStart"]))] });
    runtime.getWorld().findActor("fx")!.setVariable("writes", true);
    expect(tickCommands(runtime, commands).assignParticle).toBe(1);
  });

  it("still re-sends a mesh material on an equal Material write", async () => {
    const { runtime, commands } = await start({ actors: [createActor("hero", "Hero", { classId: "Hero", components: [
      { ...createMeshComponent("mesh"), properties: { ...createMeshComponent("mesh").properties, materialGuid: "mat-1" } },
    ] })], scripts: [tickScript("Hero", rewrite("mesh", ["materialGuid"]))] });
    runtime.getWorld().findActor("hero")!.setVariable("writes", true);
    expect(tickCommands(runtime, commands).assignMaterial).toBe(1);
  });

  it("still re-anchors on an equal 2D Anchor write", async () => {
    const layer: SerializedSceneLayer = {
      ...createDefaultSceneLayer(), name: "HUD",
      settings: { ...createDefaultSceneLayer().settings, layerBounds: { width: 16, height: 9 } },
      actors: [
        createActor("visual", "Visual", { classId: "SceneLayerActor", transform: { position: [-7, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }),
        createActor("badge", "Badge", { classId: "Hud", parentId: "visual", components: [
          { id: "anchor", classId: "2DAnchorComponent", properties: { anchor: "topLeft", offsetX: 1, offsetY: -0.5 } },
        ] }),
      ],
    };
    const { runtime, layer: live } = await start({ actors: [], layer, scripts: [tickScript("Hud", rewrite("anchor", ["offsetX"]))] });
    const visual = runtime.getWorld().findActor(`${live!.guid}:visual`)!;
    const anchored = visual.transform.position.x;
    visual.transform.position.x = 5;
    runtime.getWorld().findActor(`${live!.guid}:badge`)!.setVariable("writes", true);
    runtime.tick();
    expect(visual.transform.position.x).toBe(anchored);
  });

  it("still takes the clamped scroll back on an equal Scroll Y write", async () => {
    const layer: SerializedSceneLayer = { ...createDefaultSceneLayer(), name: "HUD", actors: [createActor("menu", "Menu", { classId: "Hud", components: [
      { id: "viewport", classId: "2DScrollBoxComponent", properties: { width: 4, height: 4, scrollY: 99 } },
      { id: "column", classId: "2DVerticalBoxComponent", parentId: "viewport", properties: { width: 4, heightMode: "content", gap: 1 } },
      { id: "a", classId: "2DTextComponent", parentId: "column", properties: { text: "One", wrapWidth: 200, wrapHeight: 300 } },
      { id: "b", classId: "2DTextComponent", parentId: "column", properties: { text: "Two", wrapWidth: 200, wrapHeight: 300 } },
    ] })] };
    const { runtime, layer: live } = await start({ actors: [], layer, scripts: [tickScript("Hud", rewrite("viewport", ["scrollY"]))] });
    const menu = runtime.getWorld().findActor(`${live!.guid}:menu`)!;
    const viewport = menu.components.find((component) => component.guid === "viewport")!;
    expect(viewport.getVariable("scrollY")).toBe(99);
    menu.setVariable("writes", true);
    runtime.tick();
    expect(viewport.getVariable("scrollY")).toBe(3);
  });

  it("applies the first changed write on a spawned actor and on its replacement", async () => {
    const { runtime, commands } = await start({ actors: [],
      scripts: [tickScript("Hero", ['ctx.setVariableOn(ctx.getComponentById(ctx.self, "fog"), "density", 0.5);'], { components: hero().components })] });
    const densities = () => commands.filter((command) => command.type === "setFogVolumes").map((command) => command.volumes[0]?.properties.density);
    for (let round = 0; round < 2; round++) {
      const actor = runtime.spawnScriptedActor({ classId: "Hero" })!;
      runtime.tick();
      const sent = densities().length;
      actor.setVariable("writes", true);
      runtime.tick();
      expect(densities().slice(sent)).toEqual([0.5]);
      runtime.tick();
      expect(densities()).toHaveLength(sent + 1);
      runtime.getWorld().destroyActor(actor.guid);
      runtime.tick();
    }
  });
});
