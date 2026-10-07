import { EditSession, ReplaceSceneCommand } from "@babylonslate/edit";
import type { SimulationSceneCaptureResult } from "@babylonslate/runtime";
import { expect, it, vi } from "vitest";
import { createDefaultScene, type SaveGameStorage } from "@babylonslate/core";
import { DocumentService } from "./document-service";
import { GameSessionOwner } from "./game-session-owner";
import type { PlaySessionResult } from "./play-session";
import type { ProjectService } from "./project-service";
import { ProjectWriteAdmission } from "./project-write-admission";
import { SimulationSession } from "./simulation-session";

it("takes its baseline after admitted writes, protects it, and discards save writes on release", async () => {
  const documents = new DocumentService();
  const sceneId = await documents.openDocument({ loadDocument: async () => createDefaultScene() } as unknown as ProjectService,
    { kind: "scene", path: "assets/Main.scene.babasset", label: "Main" });
  const admission = new ProjectWriteAdmission();
  let finishSave!: () => void;
  const saving = admission.run(async () => {
    await new Promise<void>((resolve) => { finishSave = resolve; });
    documents.updateScene(sceneId, { ...createDefaultScene(), name: "Last Admitted Edit" });
  });
  const owner = new GameSessionOwner<PlaySessionResult>();
  const ticket = owner.begin("simulate")!;
  const saved = new Map([["score", "10"]]);
  const backingStorage: SaveGameStorage = {
    async read(key) { return saved.get(key) ?? null; },
    async write(key, value) { saved.set(key, value); },
    async remove(key) { saved.delete(key); },
    async list(prefix) { return [...saved.keys()].filter((key) => key.startsWith(prefix)); },
    async withLock(_key, operation) { return operation(); },
  };
  const restore = vi.fn();
  const preparing = SimulationSession.prepare({
    ticket, backingStorage,
    viewport: { documentId: sceneId, host: {} as HTMLElement, suspend: async () => {}, restore },
    source: {
      lockAuthoringWrites: (reason) => admission.lock(reason),
      beginSimulationDocument: id => {
        const lease = documents.beginSimulationDocument(id);
        return { baseline: lease.baseline, release: lease.release, applyScene: async () => ({ ok: false, reason: "Discard-only fixture" }) };
      },
    },
  });
  expect(admission.blocked).toBe(true);
  expect(documents.getAuthoringLock().readOnly).toBe(false);
  finishSave();
  await saving;
  const simulation = await preparing;
  expect(simulation.baseline.content).toMatchObject({ name: "Last Admitted Edit" });
  expect(() => documents.updateScene(sceneId, createDefaultScene())).toThrow();
  const revisions = documents.getRevisions();
  await simulation.storage.write("score", "100");
  expect(saved.get("score")).toBe("10");
  await simulation.suspendAuthoring(owner);
  await owner.stop(ticket);
  simulation.dispose(true);
  simulation.dispose(true);
  expect(restore).toHaveBeenCalledOnce();
  expect(documents.getRevisions()).toBe(revisions);
  expect(documents.getAuthoringLock().readOnly).toBe(false);
  expect(admission.blocked).toBe(false);
  await expect(simulation.storage.read("score")).rejects.toThrow(/closed/i);
});

async function retainingFixture(maxBytes = 1_000_000) {
  const documents = new DocumentService();
  const original = createDefaultScene();
  const id = await documents.openDocument({ loadDocument: async () => original } as unknown as ProjectService,
    { kind: "scene", path: "assets/Main.scene.babasset", label: "Main" });
  const edits = new EditSession({ maxBytes });
  const owner = new GameSessionOwner<PlaySessionResult>(), ticket = owner.begin("simulate")!;
  const storage: SaveGameStorage = { read: async () => null, write: async () => {}, remove: async () => {}, list: async () => [], withLock: async (_key, operation) => operation() };
  const simulation = await SimulationSession.prepare({ ticket, keepChanges: true, backingStorage: storage,
    viewport: { documentId: id, host: {} as HTMLElement, suspend: async () => {}, restore: () => {} },
    source: {
      lockAuthoringWrites: reason => new ProjectWriteAdmission().lock(reason),
      beginSimulationDocument: targetId => {
        const lease = documents.beginSimulationDocument(targetId);
        return { baseline: lease.baseline, release: lease.release, applyScene: async candidate => {
          const committed = lease.apply(previous => {
            const result = edits.applyWithHistoryAdmission(id, previous, new ReplaceSceneCommand(previous, candidate));
            return { scene: result.ok ? result.doc : previous, value: result };
          });
          if (!committed.ok) return committed;
          return committed.value.ok ? { ok: true, status: committed.value.status } : { ok: false, reason: "Undo history budget exceeded" };
        } };
      },
    },
  });
  const candidate = { ...original, name: "Final gameplay scene" };
  const capture = vi.fn(async (): Promise<SimulationSceneCaptureResult> => ({ ok: true, scene: candidate, byteSize: 1024,
    identity: { generation: ticket.generation, sceneAssetGuid: "scene", sceneInstanceId: "root", sceneLoadId: 1, tickIndex: 9, commandRevision: 4 } }));
  return { simulation, capture, documents, edits, original, candidate, id };
}

it("retries complete admission without recapturing, keeps locks until release, and makes one clean-restoring Undo", async () => {
  const { simulation, capture, documents, edits, original, candidate, id } = await retainingFixture();
  const other = documents.lockAuthoring("Another owner");
  expect(await simulation.resolveStop(capture)).toBe(false);
  expect(simulation.getRetention()).toMatchObject({ status: "failed" });
  expect(documents.getState().openDocuments.get(id)!.content).toBe(original);
  expect(edits.getStack(id).canUndo).toBe(false);
  other();
  expect(await simulation.resolveStop(capture)).toBe(true);
  expect(capture).toHaveBeenCalledOnce();
  expect(documents.getAuthoringLock().readOnly).toBe(true);
  expect(documents.getState().openDocuments.get(id)).toMatchObject({ content: candidate, dirty: true });
  expect(edits.getStack(id).undoDepth).toBe(1);
  simulation.dispose(true);
  const undone = edits.undo(id, candidate)!;
  documents.updateSceneFromHistory(id, undone.doc);
  expect(documents.getState().openDocuments.get(id)).toMatchObject({ content: original, dirty: false });
  const redone = edits.redo(id, undone.doc)!;
  documents.updateSceneFromHistory(id, redone.doc);
  expect(documents.getState().openDocuments.get(id)).toMatchObject({ content: candidate, dirty: true });
  expect(capture).toHaveBeenCalledOnce();
});

it("rejects an un-undoable result atomically and allows explicit discard", async () => {
  const { simulation, capture, documents, edits, original, id } = await retainingFixture(32);
  const revisions = documents.getRevisions();
  expect(await simulation.resolveStop(capture)).toBe(false);
  expect(simulation.getRetention()).toEqual({ status: "failed", reason: "Undo history budget exceeded" });
  expect(documents.getState().openDocuments.get(id)).toMatchObject({ content: original, dirty: false });
  expect(documents.getRevisions()).toBe(revisions);
  expect(edits.getStack(id).historyBytes).toBe(0);
  simulation.discardChanges();
  expect(await simulation.resolveStop(capture)).toBe(true);
  simulation.dispose(true);
  expect(capture).toHaveBeenCalledOnce();
});

it("lets Discard release a pending capture and ignores its late final state", async () => {
  const { simulation, documents, edits, original, id } = await retainingFixture();
  let finish!: (result: SimulationSceneCaptureResult) => void;
  const stopping = simulation.resolveStop(() => new Promise(resolve => { finish = resolve; }));
  simulation.discardChanges("Host closed");
  expect(await stopping).toBe(true);
  simulation.dispose(false);
  finish({ ok: false, code: "boundary", reason: "Late worker failure", path: "scene", identity: { generation: 1, sceneAssetGuid: "scene", sceneInstanceId: "root", sceneLoadId: 1, tickIndex: 1, commandRevision: 1 } });
  await Promise.resolve();
  expect(documents.getState().openDocuments.get(id)).toMatchObject({ content: original, dirty: false });
  expect(edits.getStack(id).historyBytes).toBe(0);
  expect(simulation.getRetention()).toEqual({ status: "discarded", reason: "Host closed" });
});
