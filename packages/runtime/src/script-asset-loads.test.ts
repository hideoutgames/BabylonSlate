import { describe, expect, it } from "vitest";
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
