import {
  isAssetDocumentKind,
  isSceneWorkspaceKind,
  parseDocumentId,
  type ProjectStorage,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { readJournalLines, truncateJournal } from "@babylonslate/assets";
import {
  commandToJournalPayload,
  diffGraphCommands,
  planSceneChange,
  replayJournalLines,
  resolveJournalLines,
  ReplaceSceneCommand,
  SetAssetDocumentCommand,
  type EditApplyResult,
  type EditCommand,
  type EditSession,
  type HistoryAdmissionResult,
} from "@babylonslate/edit";
import { shouldApplyAssetDocumentChange } from "../lib/asset-document-change";
import { resolveClassRenameRecovery } from "../lib/class-rename-recovery";
import { classParentLookup } from "../lib/content-browser-helpers";
import { afterMutatingApply, isMutatingApplyBlocked } from "../lib/document-lock-apply";
import type { JournalBuffer } from "../lib/journal-buffer";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { notifyDocumentEdited } from "../lib/notify-document-edited";
import { isPluginDocumentReadOnly } from "../lib/plugin-ui";
import {
  descendantClassIds,
  prefabAssetTemplateKey,
  prefabAssetTemplates,
  prefabTemplatesByClassId,
  scenesEqualForPrefabSync,
  stampUserComponentOverrides,
  syncSceneActorsFromPrefabs,
} from "../lib/prefab-instance-sync";
import type { DocumentContent, DocumentService } from "./document-service";
import type { ProjectService } from "./project-service";
import { classIdForGraphPath } from "./script-compiler";
import type { SimulationDocumentTransaction } from "./simulation-document";
import type { SourceControlService } from "./source-control-service";

/** Scene instance sync scope; omit both lists to sync every Class and Prefab. */
export type PrefabSyncOptions = {
  classIds?: readonly string[];
  prefabGuids?: readonly string[];
  quiet?: boolean;
};

export interface DocumentEditingServiceOptions {
  documents: DocumentService;
  /** Per-document Undo / Redo; its lifecycle (close, rename, clear) stays with the owner. */
  editSession: EditSession;
  project: ProjectService;
  sourceControl: SourceControlService;
  /** Batched crash-recovery journal shared with Save, close and rename. */
  journal: JournalBuffer;
  derivedStorage: () => Promise<ProjectStorage>;
  /** Re-derive chrome (dirty, Undo / Redo) after a document changed. */
  bump: () => void;
  scheduleDebouncedSave: () => void;
  /** An edit applied but cleared its document's Undo history; once per gesture. */
  onHistoryCleared: (documentId: string) => void;
  /** Registry-adjacent changes outside the registry generation (plugins, search index). */
  registryTick: () => number;
  /** Unsaved project settings; recovery then keeps the replayed journal. */
  isProjectDirty: () => boolean;
  /** Recovery replay finished, or found nothing to replay. */
  onRecoveryResolved: () => void;
}

/**
 * The document edit pipeline, without React: guarded `apply*` edits through
 * the `EditSession`, Undo / Redo, the Simulation history-admission apply, the
 * crash-journal append and recovery replay, and the prefab instance sync that
 * follows Class and Prefab edits. `DocumentProvider` constructs one and its
 * actions delegate here; re-rendering and notices are injected callbacks.
 */
export class DocumentEditingService {
  private readonly documents: DocumentService;
  private readonly editSession: EditSession;
  private readonly project: ProjectService;
  private readonly sourceControl: SourceControlService;
  private readonly journal: JournalBuffer;
  private readonly options: DocumentEditingServiceOptions;
  private prefabTemplatesCache: {
    registry: unknown;
    key: string;
    templates: ReturnType<typeof prefabTemplatesByClassId>;
  } | null = null;

  constructor(options: DocumentEditingServiceOptions) {
    this.options = options;
    this.documents = options.documents;
    this.editSession = options.editSession;
    this.project = options.project;
    this.sourceControl = options.sourceControl;
    this.journal = options.journal;
  }

  /** Plugin read-only, an authoring session lock, or a source-control lock refuses edits. */
  isApplyBlocked(path: string): boolean {
    return isMutatingApplyBlocked(
      this.sourceControl,
      path,
      isPluginDocumentReadOnly(this.project.plugins, path),
      this.documents.getAuthoringLock().readOnly,
    );
  }

  /** Apply a graph edit through the command layer (marks dirty + undoable). */
  async applyGraphChange(id: string, next: SerializedGraph): Promise<boolean> {
    const doc = this.documents.getState().openDocuments.get(id);
    if (!doc || doc.ref.kind !== "graph" || !doc.content) {
      return false;
    }
    if (this.isApplyBlocked(doc.ref.path)) {
      return false;
    }
    const previous = doc.content as SerializedGraph;
    const commands = diffGraphCommands(previous, next);
    if (commands.length === 0) {
      return false;
    }
    const result = this.editSession.applyBatch(id, previous, commands)!;
    this.documents.updateGraph(id, result.doc);
    this.reportHistoryOutcome(id, result);
    await this.notifyAppliedCommand(id, result.command);
    void afterMutatingApply(this.sourceControl, doc.ref.path);
    if (commands.some((command) => command.type === "graph.setComponents")) {
      await this.syncPrefabsForClassPath(doc.ref.path);
    }
    return true;
  }

  /** Apply a scene edit through the command layer (marks dirty + undoable). */
  async applySceneChange(
    id: string,
    next: SerializedScene,
    options?: { prefabSync?: boolean },
  ): Promise<boolean> {
    const doc = this.documents.getState().openDocuments.get(id);
    if (!doc || !isSceneWorkspaceKind(doc.ref.kind) || !doc.content) {
      return false;
    }
    if (this.isApplyBlocked(doc.ref.path)) {
      return false;
    }
    const previous = doc.content as SerializedScene;
    const intended = options?.prefabSync
      ? next
      : stampUserComponentOverrides(previous, next, this.prefabTemplatesForStamping());
    // Deltas, or one whole-scene replacement for fields no delta covers:
    // either way the edit reaches Undo and the journal.
    const commands = planSceneChange(previous, intended);
    if (commands.length === 0) {
      return false;
    }
    const result = this.editSession.applyBatch(id, previous, commands)!;
    this.documents.updateScene(id, result.doc);
    this.reportHistoryOutcome(id, result);
    await this.notifyAppliedCommand(id, result.command);
    void afterMutatingApply(this.sourceControl, doc.ref.path);
    return true;
  }

  /** Replace an asset tab's payload; `mergeKey` folds a continuous gesture into one Undo step. */
  async applyAssetDocumentChange(
    id: string,
    next: Record<string, unknown>,
    mergeKey?: string,
  ): Promise<boolean> {
    const doc = this.documents.getState().openDocuments.get(id);
    if (
      !doc ||
      !isAssetDocumentKind(doc.ref.kind) ||
      doc.ref.kind === "scene" ||
      doc.ref.kind === "graph" ||
      doc.ref.kind === "trace" ||
      !doc.content
    ) {
      return false;
    }
    if (this.isApplyBlocked(doc.ref.path)) {
      return false;
    }
    const previous = doc.content as Record<string, unknown>;
    if (!shouldApplyAssetDocumentChange(previous, next)) {
      return false;
    }
    const command = new SetAssetDocumentCommand(previous, next, mergeKey);
    const result = this.editSession.apply(id, previous, command);
    this.documents.updateAssetDocument(id, result.doc);
    this.reportHistoryOutcome(id, result);
    await this.notifyAppliedCommand(id, command);
    void afterMutatingApply(this.sourceControl, doc.ref.path);
    if (doc.ref.kind === "prefab") await this.syncPrefabsForPrefabPath(doc.ref.path);
    return true;
  }

  /**
   * Exclusive Simulation lease on a Scene whose Keep installs one
   * history-admitted whole-scene replacement, or leaves the document, its
   * dirty state, Undo and Redo unchanged.
   */
  beginSimulationDocument(id: string): SimulationDocumentTransaction {
    const lease = this.documents.beginSimulationDocument(id);
    return {
      baseline: lease.baseline,
      release: lease.release,
      applyScene: async (candidate) => {
        const path = lease.baseline.ref.path;
        const registry = this.project.registry;
        const asset = registry?.list().find(entry => entry.path === path);
        if (asset && registry?.getRoot(asset.rootId)?.readOnly) return { ok: false, reason: "The Scene belongs to a read-only asset source." };
        if (isMutatingApplyBlocked(this.sourceControl, path, isPluginDocumentReadOnly(this.project.plugins, path), false)) {
          return { ok: false, reason: "The Scene is read-only or locked by source control." };
        }
        try {
          const admitted = lease.apply<HistoryAdmissionResult<SerializedScene> |
            { ok: true; status: "unchanged"; doc: SerializedScene; command: null }>(previous => {
            if (ReplaceSceneCommand.isNoop(previous, candidate)) return { scene: previous,
              value: { ok: true as const, status: "unchanged" as const, doc: previous, command: null } };
            const command = new ReplaceSceneCommand(previous, candidate, { maxHistoryBytes: this.editSession.getStack(id).byteBudget });
            const result = this.editSession.applyWithHistoryAdmission(id, previous, command);
            return { scene: result.ok ? result.doc : previous, value: result };
          });
          if (!admitted.ok) return admitted;
          const result = admitted.value;
          if (!result.ok) return { ok: false, reason: result.reason === "history-budget"
            ? `Apply Simulation Changes needs ${result.requiredBytes} bytes of Undo history; the limit is ${result.maxBytes} bytes. The document is unchanged; discard or retry after the budget is changed.`
            : "The complete Simulation transaction could not account for its Undo history." };
          if (result.status === "applied" && result.command) {
            // The commit is already atomic. Notification failures must never be
            // reported as a failed Keep after the document/history changed.
            try { await this.notifyAppliedCommand(id, result.command); }
            catch (error) { console.error("Simulation changes applied; editor notification failed", error); }
            void afterMutatingApply(this.sourceControl, path);
          }
          return { ok: true, status: result.status };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : "The complete Simulation transaction could not be applied." };
        }
      },
    };
  }

  /** Undo or Redo one step of `targetId`, or of the active document. */
  stepHistory(direction: "undo" | "redo", targetId?: string): void {
    const { activeDocumentId: currentId, openDocuments } = this.documents.getState();
    const activeDocumentId = targetId ?? currentId;
    if (!activeDocumentId) return;
    const doc = openDocuments.get(activeDocumentId);
    if (!doc?.content) return;
    if (this.isApplyBlocked(doc.ref.path)) return;
    if (doc.ref.kind === "graph") {
      const stack = this.editSession.getStack<SerializedGraph>(activeDocumentId);
      const content = doc.content as SerializedGraph;
      const result = direction === "undo" ? stack.undo(content) : stack.redo(content);
      if (!result) return;
      this.documents.updateGraph(activeDocumentId, result.doc, "compare");
      void this.notifyAppliedCommand(activeDocumentId, result.command);
      if (
        JSON.stringify(content.components) !==
        JSON.stringify(result.doc.components)
      ) {
        void this.syncPrefabsForClassPath(doc.ref.path);
      }
      return;
    }
    if (doc.ref.kind === "scene" || doc.ref.kind === "scene-layer") {
      const stack = this.editSession.getStack<SerializedScene>(activeDocumentId);
      const content = doc.content as SerializedScene;
      const result = direction === "undo" ? stack.undo(content) : stack.redo(content);
      if (!result) return;
      this.documents.updateSceneFromHistory(activeDocumentId, result.doc);
      void this.notifyAppliedCommand(activeDocumentId, result.command);
      return;
    }
    if (isAssetDocumentKind(doc.ref.kind)) {
      const stack = this.editSession.getStack<Record<string, unknown>>(activeDocumentId);
      const content = doc.content as Record<string, unknown>;
      const result = direction === "undo" ? stack.undo(content) : stack.redo(content);
      if (!result) return;
      this.documents.updateAssetDocument(activeDocumentId, result.doc, "compare");
      void this.notifyAppliedCommand(activeDocumentId, result.command);
      if (doc.ref.kind === "prefab") void this.syncPrefabsForPrefabPath(doc.ref.path);
    }
  }

  /**
   * Bring the open Scene's Class and Prefab instances up to date. `quiet`
   * (scene open) patches the content without a command and drops its history.
   */
  async syncPrefabInstances(options?: PrefabSyncOptions): Promise<void> {
    if (this.documents.getAuthoringLock().readOnly) return;
    const open = [...this.documents.getState().openDocuments.values()];
    const sceneDoc = open.find((entry) => entry.ref.kind === "scene");
    if (!sceneDoc?.content) return;
    const assets = this.project.registry?.list() ?? [];
    const graphs = collectClassGraphsForPalette({
      assets,
      openDocuments: open,
      classIdForPath: classIdForGraphPath,
    });
    const parentOf = classParentLookup(assets);
    // A targeted sync touches only the edited Class lineage or Prefab assets.
    const targeted = options?.classIds !== undefined || options?.prefabGuids !== undefined;
    const classIds = options?.classIds ?? (targeted ? [] : Object.keys(graphs));
    const assetTemplates = prefabAssetTemplates({ assets, openDocuments: open });
    const prefabKeys = options?.prefabGuids?.map(prefabAssetTemplateKey);
    const templates = {
      ...prefabTemplatesByClassId({
        classIds: [...classIds],
        parentOf,
        graphs,
      }),
      ...(targeted
        ? Object.fromEntries((prefabKeys ?? []).flatMap((key) =>
            assetTemplates[key] ? [[key, assetTemplates[key]] as const] : []))
        : assetTemplates),
    };
    const scene = sceneDoc.content as SerializedScene;
    const next = syncSceneActorsFromPrefabs(scene, templates);
    if (scenesEqualForPrefabSync(scene, next)) return;
    if (options?.quiet) {
      // The open-time sync rewrites instances without a command, so history
      // recorded before it (such as history kept from a closed tab) no longer
      // fits the content and must not replay onto it.
      this.editSession.dropDocument(sceneDoc.id);
      this.documents.patchLoadedContent(sceneDoc.id, next);
      this.options.bump();
      return;
    }
    await this.applySceneChange(sceneDoc.id, next, { prefabSync: true });
  }

  /** Replay the crash-recovery journal onto its documents, opening cold ones first. */
  async replayRecoveryJournal(): Promise<void> {
    const authoring = this.documents.getAuthoringLock();
    if (authoring.readOnly) return;
    const guid = this.project.guid;
    if (!guid) return;
    const derived = await this.options.derivedStorage();
    const lines = resolveClassRenameRecovery(await this.journal.afterFlush(guid, () =>
      readJournalLines(derived, guid),
    ), this.project.registry);
    if (this.documents.getAuthoringLock() !== authoring) return;
    if (lines.length === 0) {
      this.options.onRecoveryResolved();
      return;
    }

    // Ensure every journal target document is open so replay is not skipped.
    // Resolved ids follow renames, so a renamed document opens at its new path.
    for (const { docId } of resolveJournalLines(lines)) {
      if (this.documents.getAuthoringLock() !== authoring) return;
      const ref = parseDocumentId(docId);
      if (!ref || !isAssetDocumentKind(ref.kind)) continue;
      if (this.documents.getState().openDocuments.get(docId)?.content != null) continue;
      const { kind, path } = ref;
      try {
        await this.documents.openDocument(
          this.project,
          { kind, path, label: path.split("/").pop() ?? path },
          null,
          false,
        );
      } catch {
        // A missing document is skipped by replayJournalLines too.
      }
    }

    if (this.documents.getAuthoringLock() !== authoring) return;

    const openDocs = new Map<string, DocumentContent>();
    for (const doc of this.documents.getOpenDocumentsOrdered()) {
      if (isAssetDocumentKind(doc.ref.kind) && doc.content) {
        openDocs.set(doc.id, doc.content);
      }
    }

    const { documents, skipped } = replayJournalLines(lines, openDocs);
    for (const [id, content] of documents) {
      const doc = this.documents.getDocument(id);
      if (!doc || doc.content === content) continue;
      // Replay can end at the saved content, so compare rather than mark dirty.
      if (isSceneWorkspaceKind(doc.ref.kind)) {
        this.documents.updateScene(id, content as SerializedScene, "compare");
      } else if (doc.ref.kind === "graph") {
        this.documents.updateGraph(id, content as SerializedGraph, "compare");
      } else {
        this.documents.updateAssetDocument(id, content as Record<string, unknown>, "compare");
      }
    }
    // Undo can leave the journal at the saved content. There is nothing to
    // save in that case, so retire the replayed journal without a no-op edit.
    // Retain skipped records and any edits made while the clear is queued.
    if (skipped.length === 0) {
      await this.journal.afterFlush(guid, () => truncateJournal(derived, guid, () =>
        this.project.guid === guid &&
        this.documents.getDirtyDocuments().length === 0 &&
        !this.options.isProjectDirty(),
      ));
    }
    this.options.onRecoveryResolved();
    this.options.bump();
  }

  /** Tell the user once per gesture when an edit could not reach Undo history. */
  private reportHistoryOutcome(id: string, result: EditApplyResult<unknown>): void {
    if (result.history !== "cleared") return;
    this.options.onHistoryCleared(id);
  }

  /** Chrome and the scheduled save first, then the buffered journal record. */
  private notifyAppliedCommand(id: string, command: EditCommand<unknown>): Promise<void> {
    const guid = this.project.guid;
    const line = {
      v: 1 as const,
      docId: id,
      at: new Date().toISOString(),
      command: commandToJournalPayload(command),
    };
    return notifyDocumentEdited({
      scheduleDebouncedSave: this.options.scheduleDebouncedSave,
      bump: this.options.bump,
      journal: async () => {
        if (guid) this.journal.append(guid, line);
      },
    });
  }

  private classGraphsForPrefabSync() {
    const assets = this.project.registry?.list() ?? [];
    const graphs = collectClassGraphsForPalette({
      assets,
      openDocuments: [...this.documents.getState().openDocuments.values()],
      classIdForPath: classIdForGraphPath,
    });
    return {
      graphs,
      parentOf: classParentLookup(assets),
    };
  }

  /**
   * Prefab templates for stamping user component overrides (Class prefabs and
   * Prefab assets), rebuilt only when one can have changed: the registry (its
   * generation or registry tick) or an open Class or Prefab document (the
   * graph- and prefab-kind revisions).
   */
  private prefabTemplatesForStamping() {
    const registry = this.project.registry;
    const revisions = this.documents.getRevisions();
    const key = `${this.project.registryGeneration}:${this.options.registryTick()}:${revisions.graph}:${revisions.prefab}`;
    const cached = this.prefabTemplatesCache;
    if (cached && cached.registry === registry && cached.key === key) return cached.templates;
    const { graphs, parentOf } = this.classGraphsForPrefabSync();
    const templates = {
      ...prefabTemplatesByClassId({
        classIds: Object.keys(graphs),
        parentOf,
        graphs,
      }),
      ...prefabAssetTemplates({
        assets: registry?.list() ?? [],
        openDocuments: [...this.documents.getState().openDocuments.values()],
      }),
    };
    this.prefabTemplatesCache = { registry, key, templates };
    return templates;
  }

  private async syncPrefabsForClassPath(path: string): Promise<void> {
    const { graphs, parentOf } = this.classGraphsForPrefabSync();
    await this.syncPrefabInstances({
      classIds: descendantClassIds(
        classIdForGraphPath(path),
        Object.keys(graphs),
        parentOf,
      ),
    });
  }

  private async syncPrefabsForPrefabPath(path: string): Promise<void> {
    const guid = this.project.registry?.getByPath(path)?.header.guid;
    if (guid) await this.syncPrefabInstances({ prefabGuids: [guid] });
  }
}
