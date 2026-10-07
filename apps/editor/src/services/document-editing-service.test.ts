import { describe, expect, it, vi } from "vitest";
import {
  createDefaultScene,
  documentId,
  MAIN_SCENE_FILE,
  type DocumentRef,
  type SerializedActor,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { DEFAULT_EDIT_BYTE_BUDGET, EditSession } from "@babylonslate/edit";
import { JournalBuffer } from "../lib/journal-buffer";
import { DocumentEditingService } from "./document-editing-service";
import { DocumentService } from "./document-service";
import type { ProjectService } from "./project-service";
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

function createEditing(options: { maxBytes?: number } = {}) {
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
    sourceControl: new SourceControlService(),
    journal,
    derivedStorage: () => Promise.reject(new Error("Recovery is not part of these tests.")),
    bump: () => {},
    scheduleDebouncedSave: () => {},
    onHistoryCleared: (id) => historyCleared.push(id),
    registryTick: () => 0,
    isProjectDirty: () => false,
    onRecoveryResolved: () => {},
  });
  const open = async (ref: DocumentRef, content: unknown) => {
    files.set(ref.path, content);
    return documents.openDocument(project, ref, null, true);
  };
  const journaled = async () => {
    await journal.flush();
    return journalLines.map((line) => ({ docId: line.docId, type: line.command.type }));
  };
  return { documents, editSession, editing, historyCleared, open, journaled };
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
});
