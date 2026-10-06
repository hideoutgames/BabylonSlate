import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, type SaveGameDefinition, type SaveGameStorage, type SerializedComponent } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import type { CompiledScript } from "./script-host";

class MemoryStorage implements SaveGameStorage {
  readonly files = new Map<string, string>();
  async read(key: string) { return this.files.get(key) ?? null; }
  async write(key: string, text: string) { this.files.set(key, text); }
  async remove(key: string) { this.files.delete(key); }
  async list(prefix: string) { return [...this.files.keys()].filter((key) => key.startsWith(prefix)); }
  async withLock<T>(_key: string, operation: () => Promise<T>) { return operation(); }
}
const definition: SaveGameDefinition = {
  id: "progress", schemaVersion: 1, fields: [{ id: "coins", name: "coins", type: "int", defaultValue: 0 }],
};
const selected: SerializedComponent = {
  id: "save", classId: "SaveGameComponent",
  properties: { saveTransform: true, persistDestruction: true, actorVariables: ["health", "target", "targetComponent"], componentVariables: { inventory: ["charge"] } },
};
const components: SerializedComponent[] = [selected, { id: "inventory", classId: "ActorComponent", properties: { charge: 3 } }];
const heroScript: CompiledScript = {
  assetGuid: "hero-asset", classId: "Hero", parentClassId: "Actor", anchors: [], components,
  variables: [{ name: "health", type: "float", defaultValue: 100 }],
  entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }, { name: "loaded", event: "onGameLoaded", isAsync: false }],
  source: `export function begin(ctx) { ctx.self.setVariable('begins', 1); }
    export function loaded(ctx) {
      ctx.self.setVariable('loadedHealth', ctx.self.getVariable('health'));
      ctx.self.setVariable('loadedCoins', ctx.getSaveData().coins);
      ctx.self.setVariable('loadedTarget', ctx.self.getVariable('target'));
    }`,
};
async function boot(storage: MemoryStorage, options: { sceneId?: string; onCommand?: (command: CommandMessage) => void; scripts?: CompiledScript[]; actorScript?: CompiledScript; definition?: SaveGameDefinition; referenceTarget?: boolean } = {}) {
  const scene = createDefaultScene();
  const actorScript = options.actorScript ?? heroScript;
  scene.actors = [createActor("hero", "Hero", { classId: actorScript.classId, components: structuredClone(components) }),
    createActor("door", "Door", { components: [{ id: "door-save", classId: "SaveGameComponent", properties: {} }] })];
  if (options.referenceTarget) scene.actors.push(createActor("reference-only", "Reference Target"));
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: scene, playSceneGuid: options.sceneId ?? "level", onCommand: options.onCommand });
  const service = runtime.configureSaveGame({ projectId: "project", definition: options.definition ?? definition, storage });
  await runtime.loadScripts([actorScript, ...(options.scripts ?? [])]);
  await runtime.realizePlayWorld();
  runtime.start();
  return { runtime, service };
}
function hero(runtime: RuntimeDriver) { return runtime.getWorld().findActor("hero")!; }

describe("runtime Save Game", () => {
  it("runs virtualized overlay actor and component creation after restore and before On Game Loaded", async () => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("menu", "Menu", { classId: "SceneLayerActor", components: [
      { id: "list", classId: "2DVirtualizedListComponent", properties: { width: 4, height: 1, itemClassId: "Row", itemCount: 0, overscan: 0 } },
    ] })];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer } });
    const service = runtime.configureSaveGame({ projectId: "project", definition, storage: new MemoryStorage() });
    const entryPoints = ["onBeginPlay", "onGameLoaded", "onDestroyed"].map((name) => ({ name, event: name, isAsync: false }));
    try {
      await runtime.loadScripts([
        { assetGuid: "row", classId: "Row", parentClassId: "SceneLayerActor", anchors: [], entryPoints,
          components: [{ id: "row-state", classId: "RowState", properties: {} }],
          source: `export function onBeginPlay(ctx) { ctx.self.setVariable('beganCoins', ctx.getSaveData().coins); }
            export function onGameLoaded(ctx) { ctx.self.setVariable('beganWhenLoaded', ctx.self.getVariable('beganCoins')); }
            export function onDestroyed(ctx) { ctx.self.setVariable('ended', true); }`,
        },
        { assetGuid: "row-state", classId: "RowState", parentClassId: "ActorComponent", anchors: [], entryPoints,
          source: `export function onBeginPlay(ctx) { ctx.self.setVariable('beganCoins', ctx.getSaveData().coins); }
            export function onGameLoaded(ctx) { ctx.self.setVariable('beganWhenLoaded', ctx.self.getVariable('beganCoins')); }
            export function onDestroyed(ctx) { ctx.self.setVariable('ended', true); }`,
        },
      ]);
      await runtime.realizePlayWorld();
      runtime.createSceneLayer("menu");
      runtime.start();
      service.getSaveData().coins = 7;
      expect((await service.saveGame()).ok).toBe(true);
      const list = runtime.getWorld().findActor("menu")!.components.find((component) => component.guid === "list")!;
      list.setVariable("itemCount", 1);
      service.getSaveData().coins = 99;
      expect((await service.loadGame()).ok).toBe(true);
      const row = runtime.getWorld().getActors().find((actor) => actor.classId === "Row")!;
      expect(row).toBeDefined();
      const component = row.components.find((item) => item.classId === "RowState")!;
      expect(row.getVariable("beganCoins")).toBe(7);
      expect(component.getVariable("beganCoins")).toBe(7);
      expect(row.getVariable("beganWhenLoaded")).toBe(7);
      expect(component.getVariable("beganWhenLoaded")).toBe(7);
      list.setVariable("itemCount", 0);
      expect((await service.loadGame()).ok).toBe(true);
      runtime.tick();
      expect(row.destroyed).toBe(true);
      expect(row.getVariable("ended")).toBe(true);
      expect(component.getVariable("ended")).toBe(true);
    } finally { runtime.stop(); }
  });

  it("restores selected state, references and persisted destruction before On Game Loaded", async () => {
    const storage = new MemoryStorage();
    const first = await boot(storage);
    try {
      hero(first.runtime).setVariable("health", 42);
      hero(first.runtime).setVariable("temporary", "not selected");
      hero(first.runtime).transform.position.x = 12;
      hero(first.runtime).components.find((component) => component.guid === "inventory")!.setVariable("charge", 9);
      first.service.getSaveData().coins = 7;
      first.runtime.getWorld().destroyActor("door");
      first.runtime.getWorld().flushPending();
      expect((await first.service.saveGame()).ok).toBe(true);
    } finally { first.runtime.stop(); }
    const next = await boot(storage);
    try {
      hero(next.runtime).setVariable("temporary", "keep current session value");
      const loaded = await next.service.loadGame();
      expect(loaded.ok).toBe(true);
      expect(hero(next.runtime).transform.position.x).toBe(12);
      expect(hero(next.runtime).getVariable("health")).toBe(42);
      expect(hero(next.runtime).getVariable("temporary")).toBe("keep current session value");
      expect(hero(next.runtime).components.find((component) => component.guid === "inventory")!.getVariable("charge")).toBe(9);
      expect(next.runtime.getWorld().findActor("door")).toBeUndefined();
      expect(hero(next.runtime).getVariable("loadedCoins")).toBe(7);
      expect(hero(next.runtime).getVariable("loadedHealth")).toBe(42);
      expect((await next.service.newGame()).ok).toBe(true);
      expect(hero(next.runtime).getVariable("health")).toBe(100);
      expect(hero(next.runtime).transform.position.x).toBe(0);
      expect(next.runtime.getWorld().findActor("door")).toBeDefined();
      expect(next.service.getSaveData().coins).toBe(0);
    } finally { next.runtime.stop(); }
  });

  it("recreates registered spawned actors with stable references despite different runtime spawn order", async () => {
    const storage = new MemoryStorage();
    const first = await boot(storage);
    try {
      const companion = first.runtime.spawnScriptedActor({ classId: "Hero" })!;
      first.runtime.registerSaveActor(companion, "companion");
      companion.setVariable("health", 18);
      hero(first.runtime).setVariable("target", companion);
      hero(first.runtime).setVariable("targetComponent", companion.components.find((component) => component.sourceId === "inventory"));
      hero(first.runtime).setVariable("parentId", companion.guid);
      expect((await first.service.saveGame()).ok).toBe(true);
    } finally { first.runtime.stop(); }
    const next = await boot(storage);
    try {
      const extra = next.runtime.spawnScriptedActor({ classId: "Hero" })!;
      expect((await next.service.loadGame()).ok).toBe(true);
      const restored = next.runtime.getWorld().findActor("companion")!;
      expect(restored).toBeDefined();
      expect(restored.getVariable("health")).toBe(18);
      expect(hero(next.runtime).getVariable("target")).toBe(restored);
      expect(hero(next.runtime).getVariable("loadedTarget")).toBe(restored);
      expect(hero(next.runtime).getVariable("parentId")).toBe("companion");
      expect(hero(next.runtime).getVariable("targetComponent")).toBe(restored.components.find((component) => component.sourceId === "inventory"));
      expect(restored.getVariable("begins")).toBeUndefined();
      expect(restored.getVariable("loadedHealth")).toBe(18);
      expect(extra.destroyed).toBe(true);
    } finally { next.runtime.stop(); }
  });

  it("captures a Tick request after the full simulation tick and leaves paused sessions paused", async () => {
    const ticking: CompiledScript = {
      ...heroScript, assetGuid: "tick-asset", classId: "TickSaver",
      entryPoints: [{ name: "tick", event: "onTick", isAsync: false }],
      source: `export function tick(ctx) {
        ctx.self.setVariable('health', 1);
        ctx.self.setVariable('pending', ctx.saveGame());
        ctx.self.setVariable('health', 2);
      }`,
    };
    const { runtime, service } = await boot(new MemoryStorage(), { scripts: [ticking] });
    try {
      const actor = runtime.spawnScriptedActor({ classId: "TickSaver" })!;
      runtime.tick();
      const result = await actor.getVariable("pending") as { ok: boolean };
      expect(result.ok).toBe(true);
      actor.setVariable("health", 99);
      runtime.pause();
      expect((await service.loadGame()).ok).toBe(true);
      expect(actor.getVariable("health")).toBe(2);
      const tick = runtime.getWorld().clock.tickIndex;
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(tick);
    } finally { runtime.stop(); }
  });

  it("rejects incompatible scenes without changing live values or discarding the checkpoint", async () => {
    const storage = new MemoryStorage();
    const first = await boot(storage);
    try { first.service.getSaveData().coins = 5; expect((await first.service.saveGame()).ok).toBe(true); }
    finally { first.runtime.stop(); }
    const original = [...storage.files];
    const other = await boot(storage, { sceneId: "different-level" });
    try {
      hero(other.runtime).setVariable("health", 27);
      expect(await other.service.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
      expect(hero(other.runtime).getVariable("health")).toBe(27);
      expect(other.service.getSaveData().coins).toBe(0);
      expect([...storage.files]).toEqual(original);
    } finally { other.runtime.stop(); }
  });

  it("rolls back selected values if a restored actor cannot be admitted by the renderer", async () => {
    const storage = new MemoryStorage();
    let reject = false;
    const { runtime, service } = await boot(storage, { onCommand: (command) => {
      if (reject && command.type === "spawn") { reject = false; throw new Error("renderer unavailable"); }
    } });
    try {
      const companion = runtime.spawnScriptedActor({ classId: "Hero" })!;
      runtime.registerSaveActor(companion, "companion");
      hero(runtime).setVariable("health", 42);
      service.getSaveData().coins = 10;
      expect((await service.saveGame()).ok).toBe(true);
      runtime.getWorld().destroyActor(companion.guid);
      runtime.getWorld().flushPending();
      hero(runtime).setVariable("health", 11);
      service.getSaveData().coins = 2;
      reject = true;
      expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "apply-failed" } });
      expect(hero(runtime).getVariable("health")).toBe(11);
      expect(service.getSaveData().coins).toBe(2);
      expect(runtime.getWorld().findActor("companion")).toBeUndefined();
      expect((await service.loadGame()).ok).toBe(true);
      expect(runtime.getWorld().findActor("companion")?.getVariable("health")).toBe(100);
    } finally { runtime.stop(); }
  });

  it("completes committed destruction and reports a rejected renderer notification separately", async () => {
    const storage = new MemoryStorage();
    const first = await boot(storage);
    try {
      first.runtime.getWorld().destroyActor("door");
      first.runtime.getWorld().flushPending();
      first.service.getSaveData().coins = 8;
      expect((await first.service.saveGame()).ok).toBe(true);
    } finally { first.runtime.stop(); }
    let reject = false;
    const next = await boot(storage, { onCommand: (command) => {
      if (reject && command.type === "despawn") { reject = false; throw new Error("renderer disconnected"); }
    } });
    try {
      reject = true;
      expect((await next.service.loadGame()).ok).toBe(true);
      expect(next.runtime.getWorld().findActor("door")).toBeUndefined();
      expect(next.service.getSaveData().coins).toBe(8);
      expect(next.runtime.getDiagnostics().entries().some((entry) => entry.message.includes("renderer disconnected"))).toBe(true);
    } finally { next.runtime.stop(); }
  });

  it("validates global scalar and array actor fields before capture and staged application", async () => {
    const storage = new MemoryStorage();
    const refs: SaveGameDefinition = { ...definition, fields: [...definition.fields,
      { id: "target", name: "target", type: "actor", defaultValue: null },
      { id: "party", name: "party", type: "actor", array: true, defaultValue: [] }] };
    const first = await boot(storage, { definition: refs, referenceTarget: true });
    try {
      first.service.getSaveData().target = "reference-only";
      first.service.getSaveData().party = ["hero", "reference-only"];
      expect((await first.service.saveGame()).ok).toBe(true);
      const original = [...storage.files];
      first.service.getSaveData().party = ["missing-actor"];
      expect(await first.service.saveGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
      expect([...storage.files]).toEqual(original);
    } finally { first.runtime.stop(); }
    const next = await boot(storage, { definition: refs });
    try {
      hero(next.runtime).setVariable("health", 23);
      expect(await next.service.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
      expect(next.service.getSaveData().target).toBeNull();
      expect(hero(next.runtime).getVariable("health")).toBe(23);
    } finally { next.runtime.stop(); }
  });

  it("restores renamed class assets and refuses a different asset reusing the old class name", async () => {
    const storage = new MemoryStorage();
    const first = await boot(storage);
    try {
      const companion = first.runtime.spawnScriptedActor({ classId: "Hero" })!;
      first.runtime.registerSaveActor(companion, "companion");
      companion.setVariable("health", 12);
      hero(first.runtime).setVariable("health", 21);
      expect((await first.service.saveGame()).ok).toBe(true);
    } finally { first.runtime.stop(); }
    const renamed = await boot(storage, { actorScript: { ...heroScript, classId: "RenamedHero" } });
    try {
      expect((await renamed.service.loadGame()).ok).toBe(true);
      expect(hero(renamed.runtime).getVariable("health")).toBe(21);
      expect(renamed.runtime.getWorld().findActor("companion")?.classId).toBe("RenamedHero");
      expect(renamed.runtime.getWorld().findActor("companion")?.getVariable("health")).toBe(12);
    } finally { renamed.runtime.stop(); }
    const replaced = await boot(storage, { actorScript: { ...heroScript, assetGuid: "different-asset" } });
    try {
      expect(await replaced.service.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
      expect(hero(replaced.runtime).getVariable("health")).toBe(100);
    } finally { replaced.runtime.stop(); }
  });

  it("restores selected Maps with distinct numeric/string keys and nested references before On Game Loaded", async () => {
    const storage = new MemoryStorage();
    const mapScript: CompiledScript = {
      ...heroScript,
      variables: [...heroScript.variables!, { name: "target", type: "Actor", container: "map", keyTypeId: "string", defaultValue: [] }],
      source: `export function loaded(ctx) {
        const map = ctx.self.getVariable('target');
        if (!(map instanceof Map) || !map.has(1)) return;
        ctx.self.setVariable('loadedMapActor', map.get(1).get('friend'));
        const component = ctx.self.components.find(item => item.guid === 'inventory');
        ctx.self.setVariable('loadedMapComponent', component.getVariable('charge').get('nested').get(2).component);
      }`,
      entryPoints: [{ name: "loaded", event: "onGameLoaded", isAsync: false }],
    };
    const first = await boot(storage, { actorScript: mapScript });
    try {
      const companion = first.runtime.spawnScriptedActor({ classId: "Hero" })!;
      first.runtime.registerSaveActor(companion, "map-companion");
      const inventory = companion.components.find((component) => component.sourceId === "inventory")!;
      hero(first.runtime).setVariable("target", new Map<string | number, unknown>([
        ["1", "string key"], [1, new Map([["friend", companion]])], ["__proto__", "safe map key"],
      ]));
      hero(first.runtime).components.find((component) => component.guid === "inventory")!.setVariable("charge",
        new Map([["nested", new Map([[2, { component: inventory, actors: [companion] }]])]]));
      expect((await first.service.saveGame()).ok).toBe(true);
    } finally { first.runtime.stop(); }
    const next = await boot(storage, { actorScript: mapScript });
    try {
      expect((await next.service.loadGame()).ok).toBe(true);
      const companion = next.runtime.getWorld().findActor("map-companion")!;
      const inventory = companion.components.find((component) => component.sourceId === "inventory")!;
      const map = hero(next.runtime).getVariable("target") as Map<string | number, unknown>;
      expect(map).toBeInstanceOf(Map);
      expect([...map.keys()]).toEqual(["1", 1, "__proto__"]);
      expect(map.get("1")).toBe("string key");
      expect(map.get("__proto__")).toBe("safe map key");
      expect((map.get(1) as Map<string, unknown>).get("friend")).toBe(companion);
      const componentMap = hero(next.runtime).components.find((component) => component.guid === "inventory")!
        .getVariable("charge") as Map<string, Map<number, { component: unknown; actors: unknown[] }>>;
      expect(componentMap.get("nested")).toBeInstanceOf(Map);
      expect(componentMap.get("nested")!.get(2)!.component).toBe(inventory);
      expect(componentMap.get("nested")!.get(2)!.actors[0]).toBe(companion);
      expect(hero(next.runtime).getVariable("loadedMapActor")).toBe(companion);
      expect(hero(next.runtime).getVariable("loadedMapComponent")).toBe(inventory);
    } finally { next.runtime.stop(); }
  });

  it("preserves the last valid checkpoint when a selected Map contains a cycle", async () => {
    const storage = new MemoryStorage();
    const { runtime, service } = await boot(storage);
    try {
      hero(runtime).setVariable("target", new Map([["checkpoint", 4]]));
      expect((await service.saveGame()).ok).toBe(true);
      const original = [...storage.files];
      const cycle = new Map<string, unknown>();
      cycle.set("path", { back: [cycle] });
      hero(runtime).setVariable("target", cycle);
      expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
      expect([...storage.files]).toEqual(original);
      expect((await service.loadGame()).ok).toBe(true);
      expect((hero(runtime).getVariable("target") as Map<string, number>).get("checkpoint")).toBe(4);
    } finally { runtime.stop(); }
  });

  it.each([
    { $saveReference: "map", entries: [["duplicate", 1], ["duplicate", 2]] },
    { $saveReference: "map", entries: [[{}, "invalid key"]] },
    { $saveReference: "map", entries: [["missing value"]] },
    { $saveReference: "map", entries: [], actor: "hero" },
  ])("rejects malformed imported Map data without replacing the checkpoint or live state: %j", async (invalidMap) => {
    const storage = new MemoryStorage();
    const { runtime, service } = await boot(storage);
    try {
      const liveMap = new Map([["checkpoint", 4]]);
      hero(runtime).setVariable("target", liveMap);
      expect((await service.saveGame()).ok).toBe(true);
      const original = [...storage.files];
      const exported = await service.exportSave();
      if (!exported.ok) throw new Error(exported.error.message);
      const envelope = JSON.parse(exported.value);
      const payload = JSON.parse(envelope.payload);
      payload.state.actors.find((actor: { id: string }) => actor.id === "hero").variables.target = invalidMap;
      envelope.payload = JSON.stringify(payload);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(envelope.payload));
      envelope.checksum = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      expect(await service.importSave(JSON.stringify(envelope))).toMatchObject({ ok: false, error: { code: "corrupt" } });
      expect([...storage.files]).toEqual(original);
      expect(hero(runtime).getVariable("target")).toBe(liveMap);
    } finally { runtime.stop(); }
  });
});
