import { describe, expect, it } from "vitest";
import { ANIM_POSE_OUTPUT_NODE_ID, createDefaultAnimGraph } from "@haptic/anim-graph";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene, createDefaultSceneLayer, type RuntimeAssetCatalogEntry, type SerializedComponent } from "@haptic/core";
import { Actor, ActorComponent } from "@haptic/object-model";
import { createInProcessRuntime } from "./driver";
import { ScriptHost, type ScriptHostServices } from "./script-host";
import type { ScriptDiagnosticReport } from "./script-host-services";
import { RuntimeAssetCatalog } from "./asset-catalog";

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

const panel = (properties: Record<string, unknown>): SerializedComponent =>
  ({ id: "pp", classId: "2DPostProcessingPanelComponent", properties: { enabled: true, ...properties } });

const catalogEntry = (guid: string, name: string, type = "Material"): RuntimeAssetCatalogEntry =>
  ({ guid, name, type, path: `Content/${name}.hasset`, dependencies: [], requiredDependencies: [] });

/**
 * A demand-driven session (it has a Class catalog) with a HUD Scene Layer holding one panel actor. `set` writes the
 * panel's Material from its argument (a literal or a Soft variable's value alike reach Set Variable as a guid);
 * `read` stores what the script reads back.
 */
async function hudRuntime(ready: readonly string[] = []) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1,
    preferSoftwarePhysics: true,
    sessionGeneration: 1,
    playScene: createDefaultScene(),
    playSceneGuid: "root",
    classAssetGuids: { PanelOwner: "panel-owner" },
    sceneLayerLibrary: { hud: { ...createDefaultSceneLayer(), name: "HUD",
      actors: [createActor("frame", "Frame", { classId: "PanelOwner", components: [panel({ materialGuid: "blur" })] })] } },
    assetCatalog: [catalogEntry("blur", "Blur"), catalogEntry("glow", "Glow"), catalogEntry("wobble", "Wobble")],
    materialParameterCatalog: {
      blur: { domain: "postProcess", planHash: "blur", parameters: {} },
      glow: { domain: "postProcess", planHash: "glow", parameters: {} },
      wobble: { domain: "postProcess", planHash: "wobble", parameters: {} },
    },
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts([{
    assetGuid: "panel-owner", classId: "PanelOwner", parentClassId: "SceneLayerActor", anchors: [],
    source: [
      'const pp = (ctx) => ctx.getComponentById(ctx.self, "pp");',
      'export function set(ctx) { ctx.setVariableOn(pp(ctx), "materialGuid", ctx.args.material); }',
      'export function read(ctx) { ctx.setVariable("readBack", ctx.getVariableFrom(pp(ctx), "materialGuid")); }',
    ].join("\n"),
    entryPoints: ["set", "read"].map((name) => ({ name, event: name, isAsync: false })),
  }]);
  runtime.setAssetLoadStates(["blur", ...ready].map((guid) => ({ guid, state: "ready" as const })));
  await runtime.realizePlayWorld();
  const layer = runtime.createSceneLayer("hud", 0)!;
  runtime.start();
  runtime.tick();
  const frame = runtime.getWorld().findActor(`${layer.guid}:frame`)!;
  const component = frame.components.find((entry) => entry.classId === "2DPostProcessingPanelComponent")!;
  const set = (material: string) => runtime.invokeScriptEvent("PanelOwner", "set", frame, { material });
  const readBack = () => { runtime.invokeScriptEvent("PanelOwner", "read", frame); return frame.getVariable("readBack"); };
  const preloads = () => commands.flatMap((command) => command.type === "assetPreload" ? [command] : []);
  /** The Material each panel list sent for the frame. */
  const shown = () => commands.flatMap((command) => command.type === "sceneLayerPostProcessPanels"
    ? [command.panels.find((entry) => entry.componentId === "pp")?.materialGuid ?? null] : []);
  const logs = (severity: string) => commands.flatMap((command) => command.type === "log" && command.severity === severity ? [command.message] : []);
  /** The host reports the preload loaded: its states first, then the result, as Play's host sends them. */
  const load = (guid: string, success = true) => {
    const request = preloads().find((entry) => entry.assetGuids.includes(guid))!;
    if (success) runtime.setAssetLoadStates([{ guid, state: "ready" }]);
    runtime.notifyAssetPreloadResult({ preloadId: request.preloadId, success, error: success ? undefined : `${guid} is damaged` });
  };
  return { runtime, commands, frame, component, set, readBack, preloads, shown, logs, load };
}

describe("component asset properties a script sets before their asset loads", () => {
  it("keeps showing the previous Material while the new one loads, then applies it, warning once", async () => {
    const { runtime, component, set, readBack, preloads, shown, logs, load } = await hudRuntime();
    try {
      expect(shown().at(-1)).toBe("blur");
      set("wobble");
      runtime.tick();
      expect(component.getVariable("materialGuid")).toBe("blur");
      expect(shown().at(-1)).toBe("blur");
      expect(readBack()).toBe("wobble");
      expect(preloads().map((entry) => entry.assetGuids)).toEqual([["wobble"]]);
      expect(logs("warning")).toEqual([
        'Material "Wobble" was not loaded with this Class; it applies to Material on 2D Post Processing Panel of actor "Frame" ' +
        "when loaded. Set the variable to Hard (Load With Owner), or load it first with Load Asset (Async), to have it ready at once.",
      ]);
      // The same write again, every tick, starts nothing more and warns no more.
      set("wobble");
      runtime.tick();
      expect(preloads()).toHaveLength(1);
      load("wobble");
      await flush();
      runtime.tick();
      expect(component.getVariable("materialGuid")).toBe("wobble");
      expect(shown().at(-1)).toBe("wobble");
      expect(readBack()).toBe("wobble");
      expect(logs("warning")).toHaveLength(1);
      expect(logs("error")).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("applies a Material that loaded with its owner at once, with no load and no warning", async () => {
    const { runtime, component, set, preloads, shown, logs } = await hudRuntime(["wobble"]);
    try {
      set("wobble");
      runtime.tick();
      expect(component.getVariable("materialGuid")).toBe("wobble");
      expect(shown().at(-1)).toBe("wobble");
      expect(preloads()).toEqual([]);
      expect(logs("warning")).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("applies only the latest write when an earlier load finishes after it", async () => {
    const { runtime, component, set, readBack, shown, load } = await hudRuntime();
    try {
      set("wobble");
      set("glow");
      expect(readBack()).toBe("glow");
      load("glow");
      await flush();
      load("wobble");
      await flush();
      runtime.tick();
      expect(component.getVariable("materialGuid")).toBe("glow");
      expect(shown()).not.toContain("wobble");
      // A later write of a loaded Material supersedes one still loading.
      set("wobble");
      set("blur");
      load("wobble");
      await flush();
      expect(component.getVariable("materialGuid")).toBe("blur");
    } finally { runtime.stop(); }
  });

  it("drops the write when the actor is destroyed while its Material loads", async () => {
    const { runtime, commands, frame, component, set, preloads, load, shown, logs } = await hudRuntime();
    try {
      set("wobble");
      const writes: unknown[] = [];
      const write = component.setVariable.bind(component);
      component.setVariable = (name, value) => { writes.push([name, value]); write(name, value); };
      runtime.getWorld().destroyActorInstance(frame);
      runtime.tick();
      expect(frame.destroyed).toBe(true);
      // The actor's loads end with it.
      expect(commands).toContainEqual({ type: "assetPreloadRelease", preloadId: preloads()[0]!.preloadId });
      load("wobble");
      await flush();
      runtime.tick();
      expect(writes).not.toContainEqual(["materialGuid", "wobble"]);
      expect(shown()).not.toContain("wobble");
      expect(logs("error")).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("keeps the previous Material and reports an error when the load fails", async () => {
    const { runtime, component, set, readBack, load, logs } = await hudRuntime();
    try {
      set("wobble");
      load("wobble", false);
      await flush();
      expect(component.getVariable("materialGuid")).toBe("blur");
      expect(readBack()).toBe("blur");
      expect(logs("error")).toHaveLength(1);
      expect(logs("error")[0]).toContain('Material "Wobble" failed to load, so Material on 2D Post Processing Panel of actor "Frame" keeps its current value');
      expect(logs("error")[0]).toContain("wobble is damaged");
    } finally { runtime.stop(); }
  });

  it("refuses a Material the game does not include, naming it, and loads nothing", async () => {
    const { runtime, component, set, readBack, preloads, logs } = await hudRuntime();
    try {
      set("missing-guid");
      runtime.tick();
      expect(component.getVariable("materialGuid")).toBe("blur");
      expect(readBack()).toBe("blur");
      expect(preloads()).toEqual([]);
      expect(logs("error")).toEqual([
        'Material missing-guid is not included in this game, so Material on 2D Post Processing Panel of actor "Frame" keeps its current value. ' +
        "Reference it from a Class, Scene or Data asset the game ships, or add its folder to Always Package Folders.",
      ]);
    } finally { runtime.stop(); }
  });
});

/**
 * A demand-driven session whose actor runs a graph with a Slot; its Class plays (or stops) a clip there with Play
 * Slot Animation. `swing` and `kick` ship with the game but nothing loaded them.
 */
async function slotRuntime() {
  const commands: CommandMessage[] = [];
  const graph = createDefaultAnimGraph();
  const stateGraph = graph.stateMachine.states[0]!.stateGraph;
  stateGraph.nodes.push({ id: "slot", type: "anim.pose.slot", position: { x: 0, y: 0 }, data: {} });
  stateGraph.edges = [
    { id: "player->slot", source: "player", sourceHandle: "pose", target: "slot", targetHandle: "source" },
    { id: "slot->output", source: "slot", sourceHandle: "pose", target: ANIM_POSE_OUTPUT_NODE_ID, targetHandle: "pose" },
  ];
  const clip = (guid: string, name: string) => ({ guid, type: "Animation", name, clipName: name, durationMs: 300 });
  const runtime = createInProcessRuntime({
    seed: 1,
    dt: 0.1,
    preferSoftwarePhysics: true,
    sessionGeneration: 1,
    playScene: { ...createDefaultScene(), actors: [createActor("hero", "Hero", { classId: "Hero",
      components: [{ id: "anim", classId: "AnimationGraphComponent", properties: { graphGuid: "graph" } }] })] },
    playSceneGuid: "root",
    classAssetGuids: { Hero: "hero-class" },
    animGraphs: { graph },
    animClipCatalog: [clip("swing", "Swing"), clip("kick", "Kick")],
    assetCatalog: [catalogEntry("swing", "Swing", "Animation"), catalogEntry("kick", "Kick", "Animation"), catalogEntry("graph", "Graph", "AnimationGraph3D")],
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts([{
    assetGuid: "hero-class", classId: "Hero", parentClassId: "Actor", anchors: [],
    source: [
      'const graph = (ctx) => ctx.getComponentById(ctx.self, "anim");',
      'export function play(ctx) { ctx.setVariable("handle", ctx.playSlotAnimation(graph(ctx), ctx.args.clip, "", 0, 0.1, 1, 1, 0)); }',
      'export function stop(ctx) { ctx.stopSlotAnimation(graph(ctx), "", 0); }',
    ].join("\n"),
    entryPoints: ["play", "stop"].map((name) => ({ name, event: name, isAsync: false })),
  }]);
  await runtime.realizePlayWorld();
  runtime.start();
  runtime.tick();
  const hero = runtime.getWorld().findActor("hero")!;
  const play = (clipGuid: string) => { runtime.invokeScriptEvent("Hero", "play", hero, { clip: clipGuid }); return hero.getVariable("handle"); };
  const stop = () => runtime.invokeScriptEvent("Hero", "stop", hero);
  const preloads = () => commands.flatMap((command) => command.type === "assetPreload" ? [command.assetGuids] : []);
  /** The clips the graph's last evaluation showed. */
  const shown = () => {
    const state = commands.filter((command) => command.type === "animState").at(-1) as Extract<CommandMessage, { type: "animState" }> | undefined;
    return (state?.layers ?? []).map((layer) => layer.clipAssetGuid).filter(Boolean);
  };
  const logs = (severity: string) => commands.flatMap((command) => command.type === "log" && command.severity === severity ? [command.message] : []);
  /** The host reports the clip's preload settled: its states first, then the result, as Play's host sends them. */
  const load = (guid: string, success = true) => {
    const request = commands.find((command) => command.type === "assetPreload" && command.assetGuids.includes(guid)) as
      Extract<CommandMessage, { type: "assetPreload" }>;
    if (success) runtime.setAssetLoadStates([{ guid, state: "ready" }]);
    runtime.notifyAssetPreloadResult({ preloadId: request.preloadId, success, error: success ? undefined : `${guid} is damaged` });
  };
  return { runtime, play, stop, preloads, shown, logs, load };
}

describe("Play Slot Animation with a clip its owner did not load", () => {
  it("loads the clip, warning once, and plays it once it has loaded", async () => {
    const { runtime, play, preloads, shown, logs, load } = await slotRuntime();
    try {
      expect(play("swing")).toBeGreaterThan(0);
      expect(preloads()).toEqual([["swing"]]);
      expect(logs("warning")).toEqual([
        'Animation "Swing" was not loaded with its owner; it plays on Animation Graph of actor "Hero" once loaded. ' +
        "Set the variable to Hard (Load With Owner), or load it first with Load Asset (Async), to have it ready at once.",
      ]);
      runtime.tick();
      runtime.tick();
      expect(shown()).toEqual([]);
      load("swing");
      await flush();
      runtime.tick();
      expect(shown()).toEqual(["swing"]);
      // Loaded now: the next play starts at once, loading and warning no more.
      play("swing");
      runtime.tick();
      expect(shown()).toContain("swing");
      expect(preloads()).toHaveLength(1);
      expect(logs("warning")).toHaveLength(1);
      expect(logs("error")).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("plays only the latest request when an earlier clip loads after a Stop or a later play", async () => {
    const { runtime, play, stop, shown, load } = await slotRuntime();
    try {
      play("swing");
      stop();
      load("swing");
      await flush();
      runtime.tick();
      expect(shown()).toEqual([]);
      play("kick");
      // Swing unloaded again, so it loads once more (its owner's earlier load answers at once).
      runtime.setAssetLoadStates([{ guid: "swing", state: "unloaded" }]);
      play("swing");
      load("kick");
      await flush();
      runtime.tick();
      expect(shown()).toEqual(["swing"]);
    } finally { runtime.stop(); }
  });

  it("reports a clip that fails to load, or that the game does not include, and plays nothing", async () => {
    const { runtime, play, preloads, shown, logs, load } = await slotRuntime();
    try {
      play("swing");
      load("swing", false);
      await flush();
      runtime.tick();
      expect(shown()).toEqual([]);
      play("not-shipped");
      expect(preloads()).toEqual([["swing"]]);
      expect(logs("error")).toEqual([
        expect.stringContaining('Animation "Swing" failed to load, so Play Slot Animation on Animation Graph of actor "Hero" plays nothing'),
        'Animation not-shipped is not included in this game, so Play Slot Animation on Animation Graph of actor "Hero" plays nothing. ' +
        "Reference it from a Class, Scene or Data asset the game ships, or add its folder to Always Package Folders.",
      ]);
      expect(logs("error")[0]).toContain("swing is damaged");
    } finally { runtime.stop(); }
  });
});

function host(extra: Partial<ScriptHostServices>) {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const ready = new Set<string>();
  const reports: ScriptDiagnosticReport[] = [];
  const spawned: unknown[] = [];
  const services: ScriptHostServices = {
    log() {}, print() {}, destroyActor() {}, executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError() {},
    prepareAssets: (guids) => new Promise<void>((resolve, reject) => {
      pending.set(guids[0]!, { resolve: () => { ready.add(guids[0]!); resolve(); }, reject });
    }),
    getAssetLoadState: (guid) => ready.has(guid) ? "ready" : "unloaded",
    getAssetCatalog: () => new RuntimeAssetCatalog([catalogEntry("decal-mat", "Splat"), catalogEntry("mat-b", "Other")]),
    locateScriptNode: () => ({ assetGuid: "class-a", graphId: "event", nodeId: "set-node" }),
    reportScriptDiagnostic: (report) => { reports.push(report); },
    spawnDecal: (decal) => { spawned.push(decal.materialGuid); },
    ...extra,
  };
  return { host: new ScriptHost(services), pending, reports, spawned };
}

describe("on-demand loads outside Set Variable", () => {
  it("warns once per asset and node, located at the node that wrote it", async () => {
    let node = "set-node";
    const { host: scripts, reports } = host({ locateScriptNode: () => ({ assetGuid: "class-a", graphId: "event", nodeId: node }) });
    const actor = new Actor({ classId: "Hero", guid: "hero" });
    const decal = new ActorComponent({ classId: "DecalComponent", guid: "decal" });
    actor.attachComponent(decal);
    const ctx = scripts.createContext(actor, 0, 0);
    ctx.setVariableOn(decal, "materialGuid", "decal-mat");
    ctx.setVariableOn(decal, "materialGuid", "mat-b");
    ctx.setVariableOn(decal, "materialGuid", "decal-mat");
    node = "other-node";
    ctx.setVariableOn(decal, "materialGuid", "mat-b");
    expect(reports.map((report) => [report.severity, report.code, report.location?.nodeId, report.message.split(";")[0]])).toEqual([
      ["warning", "runtime.assetLoadOnDemand", "set-node", 'Material "Splat" was not loaded with this Class'],
      ["warning", "runtime.assetLoadOnDemand", "set-node", 'Material "Other" was not loaded with this Class'],
      ["warning", "runtime.assetLoadOnDemand", "other-node", 'Material "Other" was not loaded with this Class'],
    ]);
  });

  it("spawns a decal once its Material loads, and drops it when the caller is destroyed first", async () => {
    const { host: scripts, pending, reports, spawned } = host({});
    const actor = new Actor({ classId: "Hero", guid: "hero" });
    const ctx = scripts.createContext(actor, 0, 0);
    ctx.spawnDecal("decal-mat", { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(spawned).toEqual([]);
    expect(reports[0]!.message).toContain('Material "Splat" was not loaded with this Class; the decal spawns when it is loaded.');
    pending.get("decal-mat")!.resolve();
    await flush();
    expect(spawned).toEqual(["decal-mat"]);
    // Loaded now: the next decal spawns at once.
    ctx.spawnDecal("decal-mat", { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(spawned).toEqual(["decal-mat", "decal-mat"]);
    ctx.spawnDecal("mat-b", { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    actor.destroyed = true;
    pending.get("mat-b")!.resolve();
    await flush();
    expect(spawned).toEqual(["decal-mat", "decal-mat"]);
  });

  it("refuses a decal Material the game does not include", () => {
    const { host: scripts, pending, reports, spawned } = host({});
    const ctx = scripts.createContext(new Actor({ classId: "Hero", guid: "hero" }), 0, 0);
    ctx.spawnDecal("not-shipped", { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(pending.size).toBe(0);
    expect(spawned).toEqual([]);
    expect(reports.map((report) => [report.severity, report.message.split(",")[0]])).toEqual([["error", "Material not-shipped is not included in this game"]]);
  });
});
