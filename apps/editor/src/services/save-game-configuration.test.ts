import { expect, it } from "vitest";
import { createSessionSaveStorage, SaveGameService, type SaveGameStorage } from "@babylonslate/core";
import { prepareSaveGameConfiguration } from "./save-game-configuration";

it("wipes only disposable Preview data during Simulation preparation", async () => {
  const files = new Map<string, string>();
  const storage: SaveGameStorage = {
    async read(key) { return files.get(key) ?? null; },
    async write(key, text) { files.set(key, text); },
    async remove(key) { files.delete(key); },
    async list(prefix) { return [...files.keys()].filter((key) => key.startsWith(prefix)); },
    async withLock(_key, operation) { return operation(); },
  };
  const definition = { id: "progress", schemaVersion: 1, fields: [
    { id: "score", name: "score", type: "int" as const, defaultValue: 0 },
  ] };
  const original = new SaveGameService({ projectId: "project", definition, storage, preview: true });
  original.getSaveData().score = 8;
  expect(await original.saveGame()).toMatchObject({ ok: true });
  const before = [...files];
  const overlay = createSessionSaveStorage(storage);
  const configuration = await prepareSaveGameConfiguration({
    projectId: "project",
    settings: { definitionGuid: "progress", defaultSlot: "default", defaultProfile: "default", wipeOnPlay: true },
    loadDefinition: async () => definition,
    storage: overlay,
  });
  const simulation = new SaveGameService({ ...configuration!, storage: overlay });
  expect(await simulation.loadGame()).toMatchObject({ ok: false, error: { code: "missing" } });
  expect([...files]).toEqual(before);
  overlay.dispose();
  expect(await original.loadGame()).toMatchObject({ ok: true });
  expect(original.getSaveData().score).toBe(8);
});
