import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SaveGameService, type SaveGameStorage } from "@babylonslate/core";
import { ProjectSaveGamesSettings } from "./project-save-games-settings";

const harness = vi.hoisted(() => ({
  storage: null as SaveGameStorage | null,
  settings: vi.fn(),
  definition: { id: "progress", schemaVersion: 1, fields: [{ id: "score", name: "Score", type: "int" as const, defaultValue: 0 }] },
}));
vi.mock("@babylonslate/vfs", async (importOriginal) => ({ ...await importOriginal<typeof import("@babylonslate/vfs")>(), createSaveGameStorage: () => harness.storage }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  projectGuid: "project",
  projectDocument: { settings: { saveGame: { definitionGuid: "progress", defaultProfile: "default", defaultSlot: "default", wipeOnPlay: false } } },
  assetRegistry: { getByGuid: () => ({ path: "Progress.savegame.babasset", header: { guid: "progress", name: "Progress", type: "SaveGame" } }), list: () => [] },
  openDocuments: [{ id: "progress", ref: { kind: "save-game", path: "Progress.savegame.babasset" }, content: harness.definition }],
  updateProjectSettings: harness.settings,
})));
let preview: SaveGameService;
let exported: SaveGameService;
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const files = new Map<string, string>();
  harness.storage = {
    read: async (key) => files.get(key) ?? null,
    write: async (key, value) => { files.set(key, value); },
    remove: async (key) => { files.delete(key); },
    list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)),
    withLock: async (_key, operation) => operation(),
  };
  harness.settings.mockClear();
  preview = new SaveGameService({ projectId: "project", definition: harness.definition, storage: harness.storage, preview: true });
  exported = new SaveGameService({ projectId: "project", definition: harness.definition, storage: harness.storage });
  preview.getSaveData().Score = 42;
  expect((await preview.saveGame()).ok).toBe(true);
  expect((await preview.saveGame({ profile: "guest", slot: "checkpoint" })).ok).toBe(true);
  expect((await exported.saveGame()).ok).toBe(true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Preview Saves manager", () => {
  it("inspects typed fields and filters named profiles", async () => {
    render(<ProjectSaveGamesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect default" }));
    await screen.findByText("42");
    fireEvent.change(screen.getByLabelText("Profile", { exact: true }), { target: { value: "guest" } });
    await screen.findByRole("button", { name: "Inspect checkpoint" });
    expect(screen.queryByRole("button", { name: "Inspect default" })).toBeNull();
  });

  it("confirms destructive reset, removes all preview profiles, and retains exported-game data", async () => {
    render(<ProjectSaveGamesSettings />);
    await screen.findByRole("button", { name: "Inspect default" });
    fireEvent.click(screen.getByRole("button", { name: "Reset Preview Saves" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((await preview.listSaves()).ok).toBe(true);
    expect((await preview.loadGame()).ok).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset Preview Saves" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Saves" }));
    await waitFor(() => expect(screen.getByText("Preview saves reset.")).toBeTruthy());
    expect(await preview.listSaves()).toEqual({ ok: true, value: [] });
    expect(await preview.listSaves({ profile: "guest" })).toEqual({ ok: true, value: [] });
    expect((await exported.loadGame()).ok).toBe(true);
  });

  it("enables Play reset without losing the selected definition or slot", async () => {
    render(<ProjectSaveGamesSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Wipe Preview Saves On Play" }));
    expect(harness.settings).toHaveBeenCalledWith({ saveGame: { definitionGuid: "progress", defaultProfile: "default", defaultSlot: "default", wipeOnPlay: true } });
    await screen.findByRole("button", { name: "Inspect default" });
  });
});
