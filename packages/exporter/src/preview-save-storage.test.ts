import { describe, expect, it } from "vitest";
import { SaveGameService, type SaveGameDefinition, type SaveGameStorage } from "@babylonslate/core";
import { createPreviewSaveStorageClient, createPreviewSaveStorageHost } from "./preview-save-storage";

const projectId = "preview-project";
const namespace = `save-games/${projectId}/preview`;
const definition: SaveGameDefinition = {
  id: "progress", schemaVersion: 1,
  fields: [{ id: "coins-id", name: "coins", type: "int", defaultValue: 0 }],
};

function fixture() {
  const files = new Map<string, string>();
  let queue = Promise.resolve();
  // The host boundary stands in for native private storage. The iframe has no
  // filesystem or native bridge; all service operations cross the real RPC.
  const storage: SaveGameStorage = {
    read: async (key) => files.get(key) ?? null,
    write: async (key, text) => { files.set(key, text); },
    remove: async (key) => { files.delete(key); },
    list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)),
    withLock<T>(_key: string, operation: () => Promise<T>): Promise<T> {
      const pending = queue.then(operation);
      queue = pending.then(() => {}, () => {});
      return pending;
    },
  };
  const parent = {};
  const frame = {};
  const origin = "https://editor.example";
  let client: ReturnType<typeof createPreviewSaveStorageClient> | null = null;
  const host = createPreviewSaveStorageHost(storage, projectId, {
    source: () => frame,
    origin: () => origin,
    send: (data) => client?.receive({ source: parent, origin, data }),
  });
  function connect() {
    client = createPreviewSaveStorageClient({
      source: () => parent,
      origin: () => origin,
      send: (data) => host.receive({ source: frame, origin, data }),
    });
    return client;
  }
  return { files, storage, parent, frame, origin, host, connect };
}

describe("Preview iframe save storage", () => {
  it("shares the editor host store and reset tools while isolating exported game saves", async () => {
    const setup = fixture();
    const client = setup.connect();
    const preview = new SaveGameService({ projectId, definition, preview: true, storage: client.storage });
    const editor = new SaveGameService({ projectId, definition, preview: true, storage: setup.storage });
    const game = new SaveGameService({ projectId, definition, storage: setup.storage });

    game.getSaveData().coins = 99;
    expect((await game.saveGame()).ok).toBe(true);
    preview.getSaveData().coins = 41;
    expect((await preview.saveGame()).ok).toBe(true);
    expect((await editor.loadGame()).ok).toBe(true);
    expect(editor.getSaveData().coins).toBe(41);

    expect((await editor.resetPreviewData()).ok).toBe(true);
    expect(await preview.listSaves()).toEqual({ ok: true, value: [] });
    game.getSaveData().coins = 0;
    expect((await game.loadGame()).ok).toBe(true);
    expect(game.getSaveData().coins).toBe(99);
    client.dispose(); setup.host.dispose();
  });

  it("rejects requests outside the authorized project preview namespace", async () => {
    const setup = fixture();
    const client = setup.connect();
    const gameKey = `save-games/${projectId}/game/default/default/generation-a.save`;
    setup.files.set(gameKey, "player progress");
    await expect(client.storage.read(gameKey)).rejects.toThrow("outside");
    await expect(client.storage.remove(gameKey)).rejects.toThrow("outside");
    await expect(client.storage.write("save-games/other/preview/data", "bad")).rejects.toThrow("outside");
    await expect(client.storage.read(`${namespace}/../game/default/default/generation-a.save`)).rejects.toThrow("outside");
    await expect(client.storage.withLock(`save-games/${projectId}/game`, async () => {})).rejects.toThrow("outside");
    expect(setup.files.get(gameKey)).toBe("player progress");
    expect(setup.files.size).toBe(1);
    client.dispose(); setup.host.dispose();
  });

  it("ignores messages from another window or origin without displacing the active session", async () => {
    const setup = fixture();
    const client = setup.connect();
    const data = { type: "babylonslate-preview-save-storage", action: "open", session: "untrusted" };
    setup.host.receive({ source: {}, origin: setup.origin, data });
    setup.host.receive({ source: setup.frame, origin: "https://other.example", data });
    await client.storage.withLock(namespace, async () => {
      await client.storage.write(`${namespace}/probe`, "trusted");
    });
    expect(setup.files.get(`${namespace}/probe`)).toBe("trusted");
    client.dispose(); setup.host.dispose();
  });

  it("releases a previous iframe session's lock on reload and ignores its late close", async () => {
    const setup = fixture();
    const previous = setup.connect();
    let acquired!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { acquired = resolve; });
    const held = previous.storage.withLock(namespace, async () => {
      acquired();
      await new Promise<void>((resolve) => { finish = resolve; });
    }).catch(() => {});
    await started;
    const current = setup.connect();
    previous.dispose(); finish();
    await current.storage.withLock(namespace, async () => {
      await current.storage.write(`${namespace}/probe`, "new session");
    });
    await held;
    expect(setup.files.get(`${namespace}/probe`)).toBe("new session");
    current.dispose(); setup.host.dispose();
  });
});
