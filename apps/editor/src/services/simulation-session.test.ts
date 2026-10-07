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
      lockAuthoring: (reason) => documents.lockAuthoring(reason),
      getOpenDocuments: () => documents.getOpenDocumentsOrdered(),
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
