import { describe, expect, it } from "vitest";
import type { SaveGameStorage } from "./save-game";
import { createSaveStorageClient, createSaveStorageServer } from "./save-game-rpc";

function fixture() {
  const files = new Map<string, string>();
  let queue = Promise.resolve();
  const storage: SaveGameStorage = {
    read: async (key) => files.get(key) ?? null,
    write: async (key, text) => { files.set(key, text); },
    remove: async (key) => { files.delete(key); },
    list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)),
    withLock<T>(_key: string, work: () => Promise<T>): Promise<T> {
      const next = queue.then(work);
      queue = next.then(() => {}, () => {});
      return next;
    },
  };
  const client = createSaveStorageClient((request) => server.receive(request));
  const server = createSaveStorageServer(storage, (response) => client.receive(response));
  return { client, server, storage };
}

describe("worker save storage", () => {
  it("keeps the lock for the entire read-modify-write transaction across callers", async () => {
    const { client, server, storage } = fixture();
    await storage.write("counter", "0");
    await Promise.all(Array.from({ length: 8 }, () => client.storage.withLock("project", async () => {
      const old = Number(await client.storage.read("counter"));
      await client.storage.write("counter", String(old + 1));
    })));
    expect(await storage.read("counter")).toBe("8");
    client.dispose(); server.dispose();
  });

  it("releases a terminated worker's lock even when another acquisition is queued", async () => {
    const { client, server, storage } = fixture();
    let started!: () => void;
    const acquired = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const held = client.storage.withLock("project", async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
    }).catch(() => {});
    await acquired;
    const waiting = client.storage.withLock("project", async () => {}).catch(() => {});
    server.dispose(); client.dispose(); finish();
    await Promise.all([held, waiting]);
    const next = await storage.withLock("project", async () => "available");
    expect(next).toBe("available");
  });

  it("preserves native storage-full error codes across the worker boundary", async () => {
    const { client, server, storage } = fixture();
    storage.write = async () => { throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); };
    await expect(client.storage.write("slot", "data")).rejects.toMatchObject({ code: "ENOSPC" });
    client.dispose(); server.dispose();
  });
});
