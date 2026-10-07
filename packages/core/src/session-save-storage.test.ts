import { describe, expect, it } from "vitest";
import type { SaveGameStorage } from "./save-game";
import { SaveGameService } from "./save-game-service";
import { createSaveStorageClient, createSaveStorageServer } from "./save-game-rpc";
import { createSessionSaveStorage } from "./session-save-storage";

function backingStore() {
  const files = new Map<string, string>();
  const storage: SaveGameStorage = {
    async read(key) { return files.get(key) ?? null; },
    async write(key, text) { files.set(key, text); },
    async remove(key) { files.delete(key); },
    async list(prefix) { return [...files.keys()].filter((key) => key.startsWith(prefix)); },
    async withLock(_key, operation) { return operation(); },
  };
  return { files, storage };
}

describe("session save storage", () => {
  it("isolates real save generations through the worker RPC and discards them on close", async () => {
    const backing = backingStore();
    const options = {
      projectId: "simulation-project", preview: true,
      definition: { id: "score", schemaVersion: 1, fields: [
        { id: "points", name: "points", type: "int" as const, defaultValue: 0 },
      ] },
    };
    const saved = new SaveGameService({ ...options, storage: backing.storage });
    saved.getSaveData().points = 12;
    expect(await saved.saveGame()).toMatchObject({ ok: true });
    const before = [...backing.files];
    const overlay = createSessionSaveStorage(backing.storage);
    expect(overlay.retainedBytes()).toBe(0);
    const client = createSaveStorageClient((request) => server.receive(request));
    const server = createSaveStorageServer(overlay, (response) => client.receive(response));
    const simulation = new SaveGameService({ ...options, storage: client.storage });
    expect(await simulation.loadGame()).toMatchObject({ ok: true });
    expect(simulation.getSaveData().points).toBe(12);
    simulation.getSaveData().points = 99;
    expect(await simulation.saveGame()).toMatchObject({ ok: true });
    expect(await simulation.loadGame()).toMatchObject({ ok: true });
    expect(simulation.getSaveData().points).toBe(99);
    expect([...backing.files]).toEqual(before);
    overlay.dispose(); client.dispose(); server.dispose();
    const reopened = new SaveGameService({ ...options, storage: backing.storage });
    expect(await reopened.loadGame()).toMatchObject({ ok: true });
    expect(reopened.getSaveData().points).toBe(12);
    expect(overlay.retainedBytes()).toBe(0);
  });

  it("merges writes and tombstones into read-through lists without touching backing keys", async () => {
    const { storage, files } = backingStore();
    files.set("slots/a", "a"); files.set("slots/b", "b"); files.set("outside", "x");
    const overlay = createSessionSaveStorage(storage);
    await overlay.remove("slots/a");
    await overlay.write("slots/c", "c");
    expect(await overlay.read("slots/a")).toBeNull();
    expect(await overlay.list("slots/")).toEqual(["slots/b", "slots/c"]);
    expect(await overlay.requestPersistence!()).toBe(false);
    expect([...files.keys()]).toEqual(["slots/a", "slots/b", "outside"]);
    overlay.dispose();
    await expect(overlay.write("slots/d", "d")).rejects.toThrow("closed");
  });

  it("rejects budget overflow atomically and permits replacement within the budget", async () => {
    const { storage } = backingStore();
    const overlay = createSessionSaveStorage(storage, { byteBudget: 12, entryLimit: 2 });
    await overlay.write("a", "12345");
    await expect(overlay.write("a", "123456")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await overlay.read("a")).toBe("12345");
    await overlay.write("a", "1");
    await overlay.remove("b");
    await expect(overlay.remove("c")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(overlay.retainedBytes()).toBe(6);
    overlay.dispose();
  });

  it("serializes transactions, then rejects queued and active transactions at disposal", async () => {
    const { storage } = backingStore();
    const overlay = createSessionSaveStorage(storage);
    await overlay.write("count", "0");
    await Promise.all(Array.from({ length: 4 }, () => overlay.withLock("slot", async () => {
      const before = Number(await overlay.read("count"));
      await overlay.write("count", String(before + 1));
    })));
    expect(await overlay.read("count")).toBe("4");
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const active = overlay.withLock("slot", async () => { entered(); await blocked; });
    await ready;
    let ran = false;
    const queued = overlay.withLock("slot", async () => { ran = true; });
    const results = Promise.allSettled([active, queued]);
    overlay.dispose();
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(ran).toBe(false);
    expect(overlay.retainedBytes()).toBe(0);
    finish();
  });

  it("rejects late backing reads after close and uses writes accepted during a read", async () => {
    const { storage } = backingStore();
    let finish!: (value: string) => void;
    storage.read = () => new Promise((resolve) => { finish = resolve; });
    const overlay = createSessionSaveStorage(storage);
    const pending = overlay.read("slot");
    await overlay.write("slot", "new"); finish("old");
    expect(await pending).toBe("new");
    const late = overlay.read("other");
    overlay.dispose(); finish("old");
    await expect(late).rejects.toThrow("closed");
  });
});
