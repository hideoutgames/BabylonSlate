import { useCallback, useMemo, type RefObject } from "react";
import type { AssetDocumentKind, ProjectDocument } from "@haptic/core";
import { documentId, removeAlwaysPackageFolders } from "@haptic/core";
import {
  clearDeletedAssetRefs,
  clearDeletedRefsFromProjectSettings,
  renamedAssetPath,
  replaceClassAssetReferences,
  type ClassAssetReplacement,
} from "@haptic/assets";
import { journalCheckpointLine, journalRepathLine, type EditSession } from "@haptic/edit";
import {
  classIdFromClassAsset,
} from "../lib/class-asset-lookup";
import { refreshMtimeSnapshotAfterEditorSave } from "../lib/external-change";
import type { JournalBuffer } from "../lib/journal-buffer";
import { isPluginDocumentReadOnly } from "../lib/plugin-ui";
import type { ProjectSaveState } from "../lib/project-save-state";
import type { DocumentService } from "../services/document-service";
import type { PlayContentService } from "../services/play-content-service";
import type { ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import type { DocumentActions } from "./document-context-types";

export interface AssetFileOperationDeps {
  documentService: DocumentService;
  projectService: ProjectService;
  editSessionRef: RefObject<EditSession>;
  journalBuffer: JournalBuffer;
  sourceControlRef: RefObject<SourceControlService>;
  projectDocumentRef: RefObject<ProjectDocument | null>;
  projectSaveState: RefObject<ProjectSaveState>;
  setProjectDocument: (document: ProjectDocument | null) => void;
  /** Re-derives the document context value. */
  bump: () => void;
  captureLayoutForId: (id: string) => void;
  moveDockLayouts: (oldId: string, newId: string) => void;
  captureAllLayouts: () => void;
  collectGraphTypeSchemas: PlayContentService["collectGraphTypeSchemas"];
  captureMtimeSnapshot: () => Promise<void>;
  enqueueProjectWrite: <T>(operation: () => Promise<T>) => Promise<T>;
  cancelDebouncedSave: () => void;
  scheduleDebouncedSave: () => void;
  saveProjectNow: (next: ProjectDocument) => Promise<void>;
}

/**
 * Asset file operations that reach open documents: rename and move (the one
 * repath path for tabs, Undo, journal and dock layouts), Class reference
 * replacement and delete repair. Every callback keeps its identity for the
 * provider's lifetime.
 */
export function useAssetFileOperations({
  documentService,
  projectService,
  editSessionRef,
  journalBuffer,
  sourceControlRef,
  projectDocumentRef,
  projectSaveState,
  setProjectDocument,
  bump,
  captureLayoutForId,
  moveDockLayouts,
  captureAllLayouts,
  collectGraphTypeSchemas,
  captureMtimeSnapshot,
  enqueueProjectWrite,
  cancelDebouncedSave,
  scheduleDebouncedSave,
  saveProjectNow,
}: AssetFileOperationDeps) {
  /**
   * The one rename path: the tab, its undo history, crash-journal lines, Focus
   * state and Anim mode move to the new id together. DocumentService also
   * notifies the project session store (camera, graph pan/zoom, module cards)
   * through `subscribeDocumentIdentity`.
   */
  const repathDocument = useCallback(
    (kind: AssetDocumentKind, oldPath: string, newPath: string) => {
      if (oldPath !== newPath) documentService.assertAuthoringWritable();
      const oldId = documentId({ kind, path: oldPath });
      const wasOpen = oldPath !== newPath && !!documentService.getDocument(oldId);
      // The workspace remounts under the new id; keep its live dock layout.
      if (wasOpen) captureLayoutForId(oldId);
      const moved = documentService.repathDocument(kind, oldPath, newPath);
      if (moved) {
        const { newId } = moved;
        editSessionRef.current.rekeyDocument(oldId, newId);
        const guid = projectService.guid;
        if (wasOpen && guid) {
          // Unsaved edits journalled under the old id replay onto the moved
          // file, together with any later Undo journalled under the new id.
          // The marker goes through the batch buffer so it lands after the
          // buffered edits it renames.
          journalBuffer.append(
            guid,
            journalRepathLine(oldId, newId, new Date().toISOString()),
          );
        }
        moveDockLayouts(oldId, newId);
      }
      bump();
    },
    [
      bump,
      captureLayoutForId,
      documentService,
      journalBuffer,
      moveDockLayouts,
      projectService,
      editSessionRef,
    ],
  );

  const replaceClassReferencesBeforeDelete = useCallback(async (
    replacements: readonly ClassAssetReplacement[],
    deletingGuids: ReadonlySet<string>,
    onProgress?: (currentName: string) => Promise<void>,
  ) => {
    const registry = projectService.registry;
    const schemas = collectGraphTypeSchemas();
    const definitionFields = (guid: string) => schemas.structs?.[guid]?.fields;
    const openChanges = documentService.getOpenDocumentsOrdered().flatMap((doc) => {
      if (doc.ref.kind === "content-browser" || doc.ref.kind === "trace" || !doc.content) return [];
      const asset = registry?.list().find((entry) => entry.path === doc.ref.path);
      if (asset && deletingGuids.has(asset.header.guid)) return [];
      const walked = replaceClassAssetReferences(doc.content, replacements, definitionFields);
      if (!walked.changed) return [];
      if ((asset && registry?.getRoot(asset.rootId)?.readOnly) || isPluginDocumentReadOnly(projectService.plugins, doc.ref.path)) {
        throw new Error(`${doc.ref.path} is read-only and still references a selected Class.`);
      }
      return [{ doc, content: walked.value }];
    });
    await projectService.replaceClassReferencesBeforeDelete(replacements, deletingGuids, onProgress);
    // The referrer files now name the replacement. Open tabs follow at once,
    // from their current content, so a failed Project Settings write below
    // cannot leave a tab whose next Save writes the old reference back.
    for (const { doc } of openChanges) {
      const open = documentService.getDocument(doc.id);
      if (!open?.content) continue;
      const walked = replaceClassAssetReferences(open.content, replacements, definitionFields);
      if (!walked.changed) continue;
      documentService.applyFileRewrite(open.id, walked.value);
    }
    bump();
    const current = projectDocumentRef.current;
    if (current) {
      const settings = replaceClassAssetReferences(current.settings, replacements);
      if (settings.changed) {
        await onProgress?.("Project Settings");
        const next = { ...current, settings: settings.value };
        await saveProjectNow(next);
        setProjectDocument(next);
      }
    }
  }, [bump, collectGraphTypeSchemas, documentService, projectService, saveProjectNow, setProjectDocument, projectDocumentRef]);

  const renameAsset = useCallback((guid: string, newName: string) => enqueueProjectWrite(async () => {
    cancelDebouncedSave();
    try {
      const registry = projectService.registry;
      const before = registry?.getByGuid(guid);
      if (!registry || !before) throw new Error("The asset is unavailable.");
      const nextPath = renamedAssetPath(before.path, newName);
      const replacements: ClassAssetReplacement[] = before.header.type === "Class"
        ? [{ guid, classId: classIdFromClassAsset(before), replacement: { guid, classId: classIdFromClassAsset({ ...before, path: nextPath }) } }]
        : [];
      const schemas = collectGraphTypeSchemas();
      const definitionFields = (definitionGuid: string) => schemas.structs?.[definitionGuid]?.fields;
      const openChanges = documentService.getOpenDocumentsOrdered().flatMap((doc) => {
        if (!doc.content || doc.ref.kind === "content-browser" || doc.ref.kind === "trace") return [];
        const walked = replaceClassAssetReferences(doc.content, replacements, definitionFields);
        if (!walked.changed) return [];
        const asset = registry.list().find((entry) => entry.path === doc.ref.path);
        if ((asset && registry.getRoot(asset.rootId)?.readOnly) || isPluginDocumentReadOnly(projectService.plugins, doc.ref.path)) {
          throw new Error(`${doc.ref.path} is read-only and still references this Class.`);
        }
        return [{ doc }];
      });
      const renamed = await projectService.renameAsset(guid, newName, {
        beforeWrite: async (paths) => {
          for (const path of new Set([...paths, ...openChanges.map(({ doc }) => doc.ref.path)])) {
            const error = sourceControlRef.current.refuseIfTheirs(path);
            if (error) throw new Error(error);
          }
          const projectGuid = projectService.guid;
          if (!projectGuid || openChanges.length === 0) return;
          const at = new Date().toISOString();
          for (const { doc } of openChanges) {
            const checkpoint = journalCheckpointLine(doc.id, doc.content, at);
            checkpoint.command.assetGuid = registry.getByPath(doc.ref.path)?.header.guid;
            checkpoint.command.classReferences = replacements.map(({ guid: classGuid, classId }) => ({ guid: classGuid, classId }));
            journalBuffer.append(projectGuid, checkpoint);
          }
          // Snapshots still name the old Class. Recovery resolves GUIDs against
          // disk, so a failed rename cannot leave rewritten recovery content.
          await journalBuffer.flush(projectGuid, { rejectOnError: true });
        },
      });
      // The rename moved files and may have rewritten project.json: neither is external.
      await refreshMtimeSnapshotAfterEditorSave(captureMtimeSnapshot);
      // Every open tab, from its current content: an edit or a first read
      // while the rename wrote can add a reference the walk above missed.
      const rewritten = new Set(openChanges.map(({ doc }) => doc.id));
      for (const open of documentService.getOpenDocumentsOrdered()) {
        if (!open.content || open.ref.kind === "content-browser" || open.ref.kind === "trace") continue;
        const walked = replaceClassAssetReferences(open.content, replacements, definitionFields);
        if (!walked.changed) continue;
        documentService.applyFileRewrite(open.id, walked.value);
        rewritten.add(open.id);
      }
      // Content Browser file operations are not undoable. Old edit commands,
      // also those of a tab closed meanwhile, must not reintroduce the Class
      // id that no longer exists.
      for (const id of rewritten) editSessionRef.current.dropDocument(id);
      // The registry stamped the file's payload name; an open tab follows it.
      for (const doc of documentService.getOpenDocumentsOrdered()) {
        if (doc.ref.path === before.path) documentService.applyAssetRename(doc.id, renamed.header.name);
      }
      const current = projectDocumentRef.current;
      if (current && replacements.length) {
        const settings = replaceClassAssetReferences(current.settings, replacements);
        if (settings.changed) setProjectDocument({ ...current, settings: settings.value });
      }
      bump();
      return renamed;
    } finally {
      if (documentService.getDirtyDocuments().length || projectSaveState.current.isDirty(projectDocumentRef.current)) scheduleDebouncedSave();
    }
  }), [bump, cancelDebouncedSave, captureMtimeSnapshot, collectGraphTypeSchemas, documentService, enqueueProjectWrite, journalBuffer, projectService, scheduleDebouncedSave, setProjectDocument, editSessionRef, projectDocumentRef, projectSaveState, sourceControlRef]);

  const repairAfterAssetDelete = useCallback(
    async (
      deletedGuids: ReadonlySet<string>,
      deletedClassNames: ReadonlySet<string> = new Set(),
      onProgress?: (currentName: string) => Promise<void>,
      deletedFolders: readonly string[] = [],
    ) => {
      const schemas = collectGraphTypeSchemas();
      const definitionFields = (guid: string) => schemas.structs?.[guid]?.fields;
      const unrepaired = await projectService.clearDeletedAssetReferences(deletedGuids, {
        deletedClassNames,
        onProgress,
      });
      for (const doc of documentService.getOpenDocumentsOrdered()) {
        if (doc.ref.kind === "content-browser" || !doc.content) continue;
        await onProgress?.(doc.ref.path);
        const walked = clearDeletedAssetRefs(
          doc.content,
          deletedGuids,
          deletedClassNames,
          definitionFields,
        );
        if (!walked.changed) continue;
        documentService.applyFileRewrite(doc.id, walked.value);
      }
      const current = projectDocumentRef.current;
      await onProgress?.("Refreshing Assets");
      await projectService.remountRegistry();
      const paths = projectService.registry?.listDocumentPaths({
        rootId: "project",
      });
      if (current) {
        await onProgress?.("Saving Project");
        const cleared = clearDeletedRefsFromProjectSettings(
          current.settings,
          deletedGuids,
          deletedClassNames,
        ).value;
        const settings = {
          ...cleared,
          alwaysPackageFolders: removeAlwaysPackageFolders(cleared.alwaysPackageFolders, deletedFolders),
        };
        const next = {
          ...current,
          settings,
          ...(paths ? { scenes: paths.scenes, graphs: paths.graphs } : {}),
        };
        setProjectDocument(next);
        captureAllLayouts();
        await saveProjectNow(next);
      }
      bump();
      // Everything else is repaired first; the delete then reports what was not.
      if (unrepaired.length > 0) {
        const cause = unrepaired[0]!.error;
        throw new Error(
          `References to the deleted assets remain in ${unrepaired.map((entry) => entry.path).join(", ")}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    },
    [
      bump,
      captureAllLayouts,
      collectGraphTypeSchemas,
      documentService,
      projectService,
      saveProjectNow,
      setProjectDocument,
      projectDocumentRef,
    ],
  );

  const actions = useMemo(
    (): Pick<
      DocumentActions,
      | "repathDocument"
      | "renameAsset"
      | "replaceClassReferencesBeforeDelete"
      | "repairAfterAssetDelete"
    > => ({
      repathDocument,
      renameAsset,
      replaceClassReferencesBeforeDelete,
      repairAfterAssetDelete,
    }),
    [
      repathDocument,
      renameAsset,
      replaceClassReferencesBeforeDelete,
      repairAfterAssetDelete,
    ],
  );

  return { actions };
}
