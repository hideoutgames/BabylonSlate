import { describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  documentId,
  MAIN_SCENE_FILE,
  type DocumentRef,
  type ProjectStorage,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { appendJournalLines, readJournalLines, sealJournalForRecovery } from "@babylonslate/assets";
import {
  commandToJournalPayload,
  DEFAULT_EDIT_BYTE_BUDGET,
  EditSession,
  serializeJournalLine,
  SetSceneNameCommand,
} from "@babylonslate/edit";
import { FakeLockProvider } from "@babylonslate/source-control";
import { MemorySecretStore, MemoryStorageAdapter } from "@babylonslate/vfs";
import { JournalBuffer } from "../lib/journal-buffer";
import { DocumentEditingService } from "./document-editing-service";
import { DocumentService } from "./document-service";
import type { ProjectService } from "./project-service";
import { classIdForGraphPath } from "./script-compiler";
import { SourceControlService } from "./source-control-service";

const LOCKED_PLUGIN = {
  folderPath: "plugins/Locked",
  settingsPath: "plugins/Locked/plugin.json",
  readOnly: true,
};

/** A loaded document, as read back from its JSON file. */
function fromDisk<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createEditing(options: {
  maxBytes?: number;
  derivedStorage?: () => Promise<ProjectStorage>;
  onRecoveryResolved?: () => void;
  sourceControl?: SourceControlService;
  scheduleDebouncedSave?: () => void;
} = {}) {
  const documents = new DocumentService();
  const editSession = new EditSession({ maxBytes: options.maxBytes ?? DEFAULT_EDIT_BYTE_BUDGET });
  const files = new Map<string, unknown>();
  const project = {
    guid: "project-guid",
    plugins: [LOCKED_PLUGIN],
    registry: null,
    registryGeneration: 0,
    loadDocument: vi.fn(async (_kind: string, path: string) => fromDisk(files.get(path))),
  } as unknown as ProjectService;
  const journalLines: Array<{ docId: string; command: { type: string } }> = [];
  const journal = new JournalBuffer(async (_guid, lines) => {
    journalLines.push(...lines.map((line) => JSON.parse(line) as (typeof journalLines)[number]));
  });
  const historyCleared: string[] = [];
  const editing = new DocumentEditingService({
    documents,
    editSession,
    project,
    sourceControl: options.sourceControl ?? new SourceControlService(),
    journal,
    derivedStorage: options.derivedStorage ?? (() => Promise.reject(new Error("Recovery is not part of these tests."))),
    bump: () => {},
    scheduleDebouncedSave: options.scheduleDebouncedSave ?? (() => {}),
    onHistoryCleared: (id) => historyCleared.push(id),
    registryTick: () => 0,
    isProjectDirty: () => false,
    onRecoveryResolved: options.onRecoveryResolved ?? (() => {}),
  });
  const open = async (ref: DocumentRef, content: unknown) => {
    files.set(ref.path, content);
    return documents.openDocument(project, ref, null, true);
  };
  const journaled = async () => {
    await journal.flush();
    return journalLines.map((line) => ({ docId: line.docId, type: line.command.type }));
  };
  return { documents, editSession, editing, historyCleared, open, journaled, project };
}

const SCENE_REF: DocumentRef = { kind: "scene", path: MAIN_SCENE_FILE, label: "Main" };
const SCENE_ID = documentId(SCENE_REF);

describe("DocumentEditingService", () => {
  it("records a scene edit no delta represents as one undoable, journalled replacement", async () => {
    const { documents, editing, open, journaled } = createEditing();
    await open(SCENE_REF, createDefaultScene("2d"));
    const before = documents.getDocument(SCENE_ID)!.content as SerializedScene;
    const after = structuredClone(before);
    (after.actors[0] as SerializedActor & { tags?: string[] }).tags = ["enemy"];

    expect(await editing.applySceneChange(SCENE_ID, after)).toBe(true);
    expect(documents.getDocument(SCENE_ID)!.content).toEqual(after);
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(true);
    expect(await journaled()).toEqual([{ docId: SCENE_ID, type: "scene.replace" }]);

    editing.stepHistory("undo");
    expect(documents.getDocument(SCENE_ID)!.content).toEqual(before);
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(false);
    editing.stepHistory("redo");
    expect(documents.getDocument(SCENE_ID)!.content).toEqual(after);
  });

  it("refuses a scene edit that would repeat an actor id", async () => {
    const { documents, editing, open, journaled } = createEditing();
    await open(SCENE_REF, createDefaultScene("2d"));
    const before = documents.getDocument(SCENE_ID)!.content as SerializedScene;
    const copy = { ...structuredClone(before.actors[0]!), name: "Copy" };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await editing.applySceneChange(SCENE_ID, { ...before, actors: [...before.actors, copy] })).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(`duplicate actor id "${copy.id}"`) }));
    } finally { error.mockRestore(); }
    expect(documents.getDocument(SCENE_ID)!.content).toBe(before);
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(false);
    expect(await journaled()).toEqual([]);
  });

  it("applies asset edits over the Undo memory limit, clears history and reports it once per gesture", async () => {
    const { documents, editSession, editing, historyCleared, open } = createEditing({ maxBytes: 1_000 });
    const ref: DocumentRef = { kind: "material", path: "assets/Rock.material.babasset", label: "Rock" };
    const id = await open(ref, { name: "Rock", roughness: 0.5 });
    await editing.applyAssetDocumentChange(id, { name: "Rock", roughness: 0.6 });
    expect(editSession.getStack(id).canUndo).toBe(true);

    const large = (fill: string) => ({ name: "Rock", roughness: 0.6, notes: fill.repeat(2_000) });
    expect(await editing.applyAssetDocumentChange(id, large("a"), "notes")).toBe(true);
    expect(await editing.applyAssetDocumentChange(id, large("b"), "notes")).toBe(true);
    expect(documents.getDocument(id)!.content).toEqual(large("b"));
    expect(editSession.getStack(id).canUndo).toBe(false);
    expect(historyCleared).toEqual([id]);

    // A new gesture over the limit is reported again.
    editSession.getStack(id).endGesture();
    await editing.applyAssetDocumentChange(id, large("c"), "notes");
    expect(historyCleared).toEqual([id, id]);
  });

  it.each([
    {
      kind: "graph" as const,
      content: { nodes: [], edges: [] } as SerializedGraph,
      apply: (editing: DocumentEditingService, id: string, content: unknown) =>
        editing.applyGraphChange(id, {
          ...(content as SerializedGraph),
          members: [{ id: "speed", kind: "variable", name: "Speed", typeId: "float", defaultValue: 1 }],
        }),
    },
    {
      kind: "material" as const,
      content: { name: "Rock", roughness: 0.5 },
      apply: (editing: DocumentEditingService, id: string, content: unknown) =>
        editing.applyAssetDocumentChange(id, { ...(content as Record<string, unknown>), roughness: 0.9 }),
    },
  ])("refuses a $kind edit inside a read-only plugin and leaves it unchanged", async ({ kind, content, apply }) => {
    const { documents, editing, open, journaled } = createEditing();
    const lockedId = await open({ kind, path: "plugins/Locked/Asset.babasset", label: "Locked" }, content);
    const editableId = await open({ kind, path: "assets/Asset.babasset", label: "Editable" }, content);
    const locked = documents.getDocument(lockedId)!.content;

    expect(await apply(editing, lockedId, locked)).toBe(false);
    expect(documents.getDocument(lockedId)!.content).toBe(locked);
    expect(documents.getDocument(lockedId)!.dirty).toBe(false);
    expect(await apply(editing, editableId, documents.getDocument(editableId)!.content)).toBe(true);
    expect((await journaled()).map((line) => line.docId)).toEqual([editableId]);
  });

  it.each([
    { scene: "a writable Scene", path: "assets/Level.babasset", teammateLock: false, saved: true },
    { scene: "a read-only plugin Scene", path: "plugins/Locked/Level.babasset", teammateLock: false, saved: false },
    { scene: "a Scene a teammate locked", path: "assets/Level.babasset", teammateLock: true, saved: false },
  ])("leaves only $scene for Save after the open-time prefab sync updates its instance", async ({ path, teammateLock, saved }) => {
    const fake = new FakeLockProvider();
    if (teammateLock) fake.addTheirs(path, "Teammate");
    const sourceControl = new SourceControlService();
    const saves = vi.fn();
    try {
      await sourceControl.configure({
        settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, enabled: true }, projectGuid: "project-guid",
        platform: "web", testMode: true, secretStore: new MemorySecretStore(), nativeHttp: null, fake,
      });
      sourceControl.pausePolling();
      await sourceControl.refresh();
      const { documents, editing, open } = createEditing({ sourceControl, scheduleDebouncedSave: saves });
      const classPath = "assets/Hero.class.babasset";
      const sprite: SerializedComponent = { id: "component-sprite", classId: "SpriteComponent", properties: {}, parentId: null };
      await open({ kind: "graph", path: classPath, label: "Hero" }, { nodes: [], edges: [], components: [sprite] });
      const instance = createActor("hero", "Hero", { classId: classIdForGraphPath(classPath) });
      const sceneId = await open({ kind: "scene", path, label: "Level" }, { ...createDefaultScene("2d"), actors: [instance] });
      sourceControl.onOpenDocument(path);

      await editing.syncPrefabInstances({ quiet: true });
      const synced = documents.getDocument(sceneId)!;
      expect((synced.content as SerializedScene).actors[0]!.components.map((component) => component.sourceId))
        .toEqual([sprite.id]);
      expect(synced.dirty).toBe(saved);
      expect(saves).toHaveBeenCalledTimes(saved ? 1 : 0);
      // Like an edit, the sync takes the writable Scene's lock before Auto-Save writes it.
      await vi.waitFor(() => expect(sourceControl.lockStateForPath(path)).toBe(saved ? "mine" : teammateLock ? "theirs" : null));
    } finally { sourceControl.dispose(); }
  });

  it("leaves a Scene, its Undo history and Auto-Save alone when its instances differ from the Class only by key order", async () => {
    const saves = vi.fn();
    const { documents, editSession, editing, open } = createEditing({ scheduleDebouncedSave: saves });
    const classPath = "assets/Hero.class.babasset";
    const properties = { speed: 2, tint: { r: 1, g: 0.5, b: 0 }, mode: "walk" };
    const sprite: SerializedComponent = {
      id: "component-sprite", classId: "SpriteComponent", properties, parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    };
    await open({ kind: "graph", path: classPath, label: "Hero" }, { nodes: [], edges: [], components: [sprite] });
    // The same row as sync writes it, with every object's keys in another order.
    const instanceRow: SerializedComponent = {
      sourceId: sprite.id,
      transform: { scale: [1, 1, 1], rotation: [0, 0, 0, 1], position: [0, 0, 0] },
      parentId: null,
      properties: { mode: "walk", tint: { b: 0, g: 0.5, r: 1 }, speed: 2 },
      classId: "SpriteComponent",
      id: "hero-SpriteComponent-1",
    };
    const instance = { ...createActor("hero", "Hero", { classId: classIdForGraphPath(classPath) }), components: [instanceRow] };
    const sceneId = await open(
      { kind: "scene", path: "assets/Level.scene.babasset", label: "Level" },
      { ...createDefaultScene("2d"), actors: [instance] },
    );
    const edited = { ...(documents.getDocument(sceneId)!.content as SerializedScene), name: "Edited" };
    expect(await editing.applySceneChange(sceneId, edited)).toBe(true);
    const opened = documents.getDocument(sceneId)!.content;
    saves.mockClear();

    await editing.syncPrefabInstances({ quiet: true });

    expect(documents.getDocument(sceneId)!.content).toBe(opened);
    expect(editSession.getStack(sceneId).canUndo).toBe(true);
    expect(saves).not.toHaveBeenCalled();
  });

  it("keeps the Scene, dirty state and history when a Simulation result exceeds the Undo memory limit", async () => {
    const { documents, editSession, editing, open, journaled } = createEditing({ maxBytes: 1_024 });
    await open(SCENE_REF, createDefaultScene("2d"));
    const baseline = documents.getDocument(SCENE_ID)!.content as SerializedScene;
    const candidate = fromDisk({ ...baseline, name: "Simulated", actors: baseline.actors.map((actor) => ({ ...actor, properties: { blob: "x".repeat(4_000) } })) });

    const simulation = editing.beginSimulationDocument(SCENE_ID);
    const result = await simulation.applyScene(candidate);
    simulation.release();

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("Undo history") });
    expect(documents.getDocument(SCENE_ID)!.content).toBe(baseline);
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(false);
    expect(editSession.getStack(SCENE_ID).canUndo).toBe(false);
    expect(await journaled()).toEqual([]);
  });

  it("keeps an admitted Simulation result as one Undo step and one journal record", async () => {
    const { documents, editing, open, journaled } = createEditing();
    await open(SCENE_REF, createDefaultScene("2d"));
    const baseline = documents.getDocument(SCENE_ID)!.content as SerializedScene;
    const candidate = fromDisk({ ...baseline, name: "Simulated" });

    const simulation = editing.beginSimulationDocument(SCENE_ID);
    expect(await simulation.applyScene(candidate)).toEqual({ ok: true, status: "applied" });
    simulation.release();
    expect(documents.getDocument(SCENE_ID)!.content).toEqual(candidate);
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(true);
    expect(await journaled()).toEqual([{ docId: SCENE_ID, type: "scene.replace" }]);

    editing.stepHistory("undo");
    expect(documents.getDocument(SCENE_ID)!.content).toEqual(baseline);
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(false);
  });

  it("keeps the recovery journal when one of its records cannot be read", async () => {
    const derived = new MemoryStorageAdapter("documents");
    await derived.openDocumentsProject("derived-root");
    const resolved = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { documents, editing, open } = createEditing({
      derivedStorage: async () => derived,
      onRecoveryResolved: resolved,
    });
    await open(SCENE_REF, createDefaultScene("2d"));
    const opened = documents.getDocument(SCENE_ID)!.content as SerializedScene;
    // The readable record ends at the saved content, which alone would clear the journal.
    await appendJournalLines(derived, "project-guid", [serializeJournalLine({
      v: 1, docId: SCENE_ID, at: "2026-10-11T10:00:00Z",
      command: commandToJournalPayload(new SetSceneNameCommand(opened.name, opened.name)),
    }), "{\"v\":1,\"docId\""]);
    await sealJournalForRecovery(derived, "project-guid");

    await editing.replayRecoveryJournal();
    expect(resolved).toHaveBeenCalled();
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(false);
    expect(await readJournalLines(derived, "project-guid")).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 unreadable recovery record"));
    warn.mockRestore();
  });

  it("does not replay a project's recovery journal into another project opened during the read", async () => {
    const derived = new MemoryStorageAdapter("documents");
    await derived.openDocumentsProject("derived-root");
    let switchProject = () => {};
    const resolved = vi.fn();
    const { documents, editing, open, project } = createEditing({
      derivedStorage: async () => { switchProject(); return derived; },
      onRecoveryResolved: resolved,
    });
    await open(SCENE_REF, createDefaultScene("2d"));
    const opened = documents.getDocument(SCENE_ID)!.content as SerializedScene;
    await appendJournalLines(derived, "project-guid", [serializeJournalLine({
      v: 1, docId: SCENE_ID, at: "2026-10-11T10:00:00Z",
      command: commandToJournalPayload(new SetSceneNameCommand(opened.name, "Recovered")),
    })]);
    await sealJournalForRecovery(derived, "project-guid");
    // The same Scene path in the project that replaced it.
    switchProject = () => { (project as { guid: string }).guid = "other-project-guid"; };

    await editing.replayRecoveryJournal();
    expect(documents.getDocument(SCENE_ID)!.content).toBe(opened);
    expect(documents.getDocument(SCENE_ID)!.dirty).toBe(false);
    expect(resolved).not.toHaveBeenCalled();
  });
});
