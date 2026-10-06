import { describe, expect, it } from "vitest";
import {
  SaveGameError,
  cloneSaveGameValue,
  createSaveGameData,
  generateSaveGameTypes,
  validateSaveGameDefinition,
  type SaveGameDefinition,
  type SaveGameStorage,
  type SaveGameServiceOptions,
} from "./save-game";
import { SaveGameService } from "./save-game-service";

const definition: SaveGameDefinition = {
  id: "progress-definition", schemaVersion: 1,
  fields: [
    { id: "coins-id", name: "coins", type: "int", defaultValue: 0 },
    { id: "spawn-id", name: "spawn", type: "vector3", defaultValue: { x: 0, y: 1, z: 0 } },
    { id: "items-id", name: "items", type: "asset", array: true, defaultValue: [] },
  ],
};

/** Actual mutable boundary lets tests interrupt writes and contend on one store. */
class FaultStorage implements SaveGameStorage {
  readonly files = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  failWrite: "torn" | "full" | "silent" | null = null;
  failRead = false;
  async read(key: string): Promise<string | null> {
    if (this.failRead) throw new Error("Storage disconnected");
    return this.files.get(key) ?? null;
  }
  async write(key: string, text: string): Promise<void> {
    const fail = this.failWrite;
    this.failWrite = null;
    if (fail === "full") throw new DOMException("Disk full", "QuotaExceededError");
    if (fail === "torn" || fail === "silent") {
      this.files.set(key, text.slice(0, 20));
      if (fail === "torn") throw new Error("Interrupted write");
      return;
    }
    this.files.set(key, text);
  }
  async remove(key: string): Promise<void> { this.files.delete(key); }
  async list(prefix: string): Promise<string[]> { return [...this.files.keys()].filter((key) => key.startsWith(prefix)); }
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.locks.get(key) ?? Promise.resolve()).then(operation);
    this.locks.set(key, pending.then(() => undefined, () => undefined));
    return pending;
  }
}

function make(storage = new FaultStorage(), extra: Partial<SaveGameServiceOptions> = {}) {
  return new SaveGameService({ projectId: "sample-project", definition, storage, ...extra });
}
function generationKey(storage: FaultStorage, name: "a" | "b") {
  return [...storage.files.keys()].find((key) => key.endsWith(`generation-${name}.save`))!;
}

/** Model an independently produced, checksummed future-version file. */
async function editPayload(text: string, change: (payload: Record<string, unknown>) => void): Promise<string> {
  const envelope = JSON.parse(text);
  const payload = JSON.parse(envelope.payload);
  change(payload);
  envelope.payload = JSON.stringify(payload);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(envelope.payload));
  envelope.checksum = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return JSON.stringify(envelope);
}

// The storage double is the sole mock boundary; every result passes real schema,
// checksum, generation selection, operation queue and migration code.
describe("SaveGameService recovery and lifecycle", () => {
  it("captures a detached snapshot at the boundary and applies staged state before notification", async () => {
    const storage = new FaultStorage();
    let paused = false;
    let world = { x: 10 };
    let loadedCoins: unknown;
    const service = make(storage, {
      atBoundary: async (operation) => { paused = true; try { return await operation(); } finally { paused = false; } },
      captureState: () => { expect(paused).toBe(true); return world; },
      stageState: (snapshot) => { expect(paused).toBe(false); expect(world.x).toBe(99); return snapshot; },
      applyState: (snapshot) => { expect(paused).toBe(true); world = snapshot as { x: number }; },
      onGameLoaded: () => { expect(paused).toBe(true); loadedCoins = service.getSaveData().coins; },
      encode: async (snapshot) => {
        expect(paused).toBe(false);
        world.x = 99;
        service.getSaveData().coins = 77;
        return JSON.stringify(snapshot);
      },
    });
    const data = service.getSaveData();
    data.coins = 42;
    expect(await service.saveGame()).toMatchObject({ ok: true, value: { sequence: 1 } });
    expect(await service.loadGame()).toMatchObject({ ok: true, value: { recovered: false } });
    expect(service.getSaveData()).toBe(data);
    expect(data.coins).toBe(42);
    expect(world).toEqual({ x: 10 });
    expect(loadedCoins).toBe(42);
  });

  it("recovers the last committed state after an interrupted replacement and can save again", async () => {
    const storage = new FaultStorage();
    const service = make(storage);
    service.getSaveData().coins = 10;
    await service.saveGame();
    service.getSaveData().coins = 20;
    await service.saveGame();
    service.getSaveData().coins = 30;
    storage.failWrite = "torn";
    expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await service.loadGame()).toMatchObject({ ok: true, value: { recovered: true } });
    expect(service.getSaveData().coins).toBe(20);
    service.getSaveData().coins = 40;
    expect(await service.saveGame()).toMatchObject({ ok: true, value: { sequence: 3 } });
    const reopened = make(storage);
    expect(await reopened.loadGame()).toMatchObject({ ok: true, value: { recovered: false } });
    expect(reopened.getSaveData().coins).toBe(40);
  });

  it("detects silent storage damage before reporting success and preserves the other generation", async () => {
    const storage = new FaultStorage();
    const service = make(storage);
    service.getSaveData().coins = 8;
    await service.saveGame();
    service.getSaveData().coins = 99;
    storage.failWrite = "silent";
    expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(await service.loadGame()).toMatchObject({ ok: true, value: { recovered: true } });
    expect(service.getSaveData().coins).toBe(8);
  });

  it("rejects checksum tampering and exposes damaged slots without silently creating new data", async () => {
    const storage = new FaultStorage();
    const service = make(storage);
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "missing" } });
    await service.saveGame();
    const key = generationKey(storage, "a");
    storage.files.set(key, storage.files.get(key)!.replace("coins-id\\\":0", "coins-id\\\":999"));
    const damaged = storage.files.get(key);
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(await service.listSaves()).toMatchObject({ ok: true, value: [{ slot: "default", status: "corrupt" }] });
    await service.newGame();
    expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(storage.files.get(key)).toBe(damaged);
    expect(await service.deleteSave()).toEqual({ ok: true, value: undefined });
    expect(await service.saveGame()).toMatchObject({ ok: true });
  });

  it("distinguishes full and unavailable storage without losing an existing save or treating errors as missing", async () => {
    const storage = new FaultStorage();
    const service = make(storage);
    service.getSaveData().coins = 12;
    await service.saveGame();
    storage.failWrite = "full";
    service.getSaveData().coins = 99;
    expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "storage-full" } });
    storage.failRead = true;
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "unavailable" } });
    storage.failRead = false;
    expect(await service.loadGame()).toMatchObject({ ok: true });
    expect(service.getSaveData().coins).toBe(12);
  });

  it("serializes concurrent service instances so every successful write advances the generation", async () => {
    const storage = new FaultStorage();
    const first = make(storage);
    const second = make(storage);
    first.getSaveData().coins = 1;
    second.getSaveData().coins = 2;
    const results = await Promise.all([first.saveGame(), second.saveGame(), first.saveGame(), second.saveGame()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.ok ? result.value.sequence : 0).sort()).toEqual([1, 2, 3, 4]);
    expect(await make(storage).loadGame()).toMatchObject({ ok: true, value: { sequence: 4 } });
    expect(storage.files.size).toBe(2);
  });

  it("never falls back over a newer incompatible schema or overwrites it from an older game", async () => {
    const storage = new FaultStorage();
    const service = make(storage);
    await service.saveGame();
    await service.saveGame();
    const key = generationKey(storage, "b");
    storage.files.set(key, await editPayload(storage.files.get(key)!, (payload) => { payload.schemaVersion = 2; }));
    const before = [...storage.files];
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(await service.listSaves()).toMatchObject({ ok: true, value: [{ status: "incompatible", schemaVersion: 2 }] });
    expect([...storage.files]).toEqual(before);
  });

  it("keeps unsupported formats intact even when another generation is readable", async () => {
    const storage = new FaultStorage();
    const service = make(storage);
    await service.saveGame();
    await service.saveGame();
    const key = generationKey(storage, "b");
    const envelope = JSON.parse(storage.files.get(key)!);
    envelope.formatVersion = 200;
    storage.files.set(key, JSON.stringify(envelope));
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
  });

  it("does not change live data or notify gameplay when staging or application fails", async () => {
    const storage = new FaultStorage();
    const original = make(storage);
    original.getSaveData().coins = 10;
    await original.saveGame();
    let applied = false;
    let notified = false;
    const staging = make(storage, {
      stageState: () => { throw new SaveGameError("incompatible", "Unknown actor class"); },
      applyState: () => { applied = true; },
      onGameLoaded: () => { notified = true; },
    });
    staging.getSaveData().coins = 99;
    expect(await staging.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(staging.getSaveData().coins).toBe(99);
    expect(applied).toBe(false);
    const applying = make(storage, {
      applyState: () => { throw new Error("Cannot restore world"); },
      onGameLoaded: () => { notified = true; },
    });
    applying.getSaveData().coins = 88;
    expect(await applying.loadGame()).toMatchObject({ ok: false, error: { code: "apply-failed" } });
    expect(applying.getSaveData().coins).toBe(88);
    expect(notified).toBe(false);
  });
});

describe("SaveGameService schema upgrades and portability", () => {
  it("uses stable field IDs for renames, defaults new fields and retains original migration bytes", async () => {
    const storage = new FaultStorage();
    const oldGame = make(storage);
    oldGame.getSaveData().coins = 7;
    await oldGame.saveGame();
    const original = [...storage.files.values()][0];
    const upgraded: SaveGameDefinition = {
      ...definition, schemaVersion: 3,
      fields: [
        { id: "coins-id", name: "gold", type: "int", defaultValue: 0 },
        { id: "lives-id", name: "lives", type: "int", defaultValue: 3 },
      ],
    };
    const service = make(storage, { definition: upgraded });
    service.registerMigration(1, async (snapshot) => { snapshot.fields["coins-id"] = Number(snapshot.fields["coins-id"]) * 10; });
    service.registerMigration(2, () => undefined);
    expect(await service.loadGame()).toMatchObject({ ok: true });
    expect(service.getSaveData()).toEqual({ gold: 70, lives: 3 });
    expect(service.getField("coins-id")).toBe(70);
    service.setField("coins-id", 71);
    expect(service.getSaveData().gold).toBe(71);
    expect([...storage.files.values()]).toEqual([original]);
    await service.saveGame();
    await service.saveGame();
    const archives = [...storage.files].filter(([key]) => key.includes("/original-v"));
    expect(archives).toHaveLength(1);
    expect(archives[0][1]).toBe(original);
    expect(await service.listSaves()).toMatchObject({ ok: true, value: [{ slot: "default", schemaVersion: 3, sequence: 3 }] });
  });

  it("rejects a missing custom migration predecessor while allowing default-only upgrades", async () => {
    const storage = new FaultStorage();
    const old = make(storage);
    old.getSaveData().coins = 12;
    await old.saveGame();
    const upgraded = { ...definition, schemaVersion: 3 };
    const service = make(storage, { definition: upgraded });
    let reachedLaterMigration = false;
    service.registerMigration(2, () => { reachedLaterMigration = true; });
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(reachedLaterMigration).toBe(false);
    expect(service.getSaveData().coins).toBe(0);
    const additive = make(storage, { definition: upgraded });
    expect(await additive.loadGame()).toMatchObject({ ok: true });
    expect(additive.getSaveData().coins).toBe(12);
  });

  it("reports failed migrations without changing the original file or live data", async () => {
    const storage = new FaultStorage();
    await make(storage).saveGame();
    const before = [...storage.files];
    const service = make(storage, { definition: { ...definition, schemaVersion: 2 } });
    service.getSaveData().coins = 25;
    service.registerMigration(1, (data) => { data.fields["coins-id"] = 999; throw new Error("Bad migration"); });
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "incompatible" } });
    expect(service.getSaveData().coins).toBe(25);
    expect([...storage.files]).toEqual(before);
  });

  it("isolates projects, profiles, case-sensitive named slots and preview reset", async () => {
    const storage = new FaultStorage();
    const game = make(storage);
    const preview = make(storage, { preview: true });
    const anotherProject = make(storage, { projectId: "another-project", preview: true });
    await game.saveGame();
    await preview.saveGame({ profile: "alice", slot: "Checkpoint" });
    await preview.saveGame({ profile: "alice", slot: "checkpoint" });
    await preview.saveGame({ profile: "bob", slot: "chapter/2" });
    await anotherProject.saveGame();
    expect(await preview.listSaves({ profile: "alice" })).toMatchObject({ ok: true, value: [{ slot: "Checkpoint" }, { slot: "checkpoint" }] });
    await preview.deleteSave({ profile: "alice", slot: "checkpoint" });
    expect(await preview.listSaves({ profile: "alice" })).toMatchObject({ ok: true, value: [{ slot: "Checkpoint" }] });
    expect(await game.resetPreviewData()).toMatchObject({ ok: false, error: { code: "invalid" } });
    await preview.resetPreviewData();
    expect(await preview.listSaves({ profile: "alice" })).toEqual({ ok: true, value: [] });
    expect(await preview.loadGame({ profile: "bob", slot: "chapter/2" })).toMatchObject({ ok: false, error: { code: "missing" } });
    expect(await game.loadGame()).toMatchObject({ ok: true });
    expect(await anotherProject.loadGame()).toMatchObject({ ok: true });
  });

  it("imports into a selected slot without applying gameplay and rejects foreign or damaged files", async () => {
    const source = make();
    source.getSaveData().coins = 55;
    await source.saveGame();
    const exported = await source.exportSave();
    if (!exported.ok) throw new Error("Export failed");
    const storage = new FaultStorage();
    const target = make(storage);
    target.getSaveData().coins = 2;
    expect(await target.importSave(exported.value, { profile: "guest", slot: "imported" })).toMatchObject({ ok: true, value: { profile: "guest", slot: "imported" } });
    expect(target.getSaveData().coins).toBe(2);
    await target.loadGame({ profile: "guest", slot: "imported" });
    expect(target.getSaveData().coins).toBe(55);
    const foreign = make(storage, { projectId: "other" });
    expect(await foreign.importSave(exported.value)).toMatchObject({ ok: false, error: { code: "incompatible" } });
    const before = [...storage.files];
    expect(await target.importSave(exported.value.slice(0, 50))).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect([...storage.files]).toEqual(before);
  });

  it("validates field types, array entries, reserved keys and independent defaults before persistence", async () => {
    const service = make();
    const another = make();
    (service.getSaveData().spawn as { x: number }).x = 8;
    expect(another.getSaveData().spawn).toEqual({ x: 0, y: 1, z: 0 });
    expect(() => service.setField("coins-id", 1.5)).toThrow(SaveGameError);
    expect(() => service.setField("items-id", [null, "asset-guid"])).not.toThrow();
    expect(() => service.setField("items-id", [7])).toThrow(SaveGameError);
    service.getSaveData().coins = NaN;
    expect(await service.saveGame()).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(() => cloneSaveGameValue(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(SaveGameError);
    expect(() => cloneSaveGameValue(new Array(2))).toThrow(SaveGameError);
    expect(() => validateSaveGameDefinition({ ...definition, fields: [definition.fields[0], definition.fields[0]] })).toThrow(SaveGameError);
    const data = service.getSaveData();
    expect(await service.newGame()).toMatchObject({ ok: true });
    expect(service.getSaveData()).toBe(data);
    expect(data.coins).toBe(0);
    expect(await service.loadGame()).toMatchObject({ ok: false, error: { code: "missing" } });
  });

  it("creates clone-safe defaults and typed declarations for reference arrays and authoring names", () => {
    const authored: SaveGameDefinition = {
      id: "typed", schemaVersion: 1,
      fields: [
        { id: "health", name: "Hit Points", type: "int", defaultValue: 100 },
        { id: "targets", name: "targets", type: "actor", array: true, defaultValue: [null] },
        { id: "ready", name: "ready", type: "bool", defaultValue: true },
      ],
    };
    expect(createSaveGameData(authored)).toEqual({ "Hit Points": 100, targets: [null], ready: true });
    expect(generateSaveGameTypes(authored)).toContain('"Hit Points": number;');
    expect(generateSaveGameTypes(authored)).toContain('"targets": Array<string | null>;');
    expect(() => generateSaveGameTypes(authored, "unsafe; type X")).toThrow(SaveGameError);
  });
});
