import { useCallback, useEffect, useMemo, type RefObject } from "react";
import type {
  AssetDocumentKind,
  PluginEnableOverride,
  ProjectDocument,
  ProjectStorage,
  SerializedGraph,
} from "@haptic/core";
import { documentId } from "@haptic/core";
import { derivedDataRoot, type AssetLoadScopeOptions, type AssetLoadState } from "@haptic/assets";
import type { ExportArtifact } from "@haptic/exporter";
import { requeueWithEditLock } from "../lib/document-lock-apply";
import { assertWritableUnderLock } from "../lib/locked-writes";
import {
  createProjectPluginAndRevealContent,
  isPluginDocumentReadOnly,
} from "../lib/plugin-ui";
import type { DocumentService } from "../services/document-service";
import type { ExportGameArtifactOptions } from "../services/export-game-artifact";
import type { PluginImportOptions, ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import type { DocumentActions } from "./document-context-types";

export interface ProjectAssetActionDeps {
  projectService: ProjectService;
  documentService: DocumentService;
  sourceControlRef: RefObject<SourceControlService>;
  projectDocumentRef: RefObject<ProjectDocument | null>;
  ensureDerived: () => Promise<ProjectStorage>;
  /** Re-derives the document context value. */
  bump: () => void;
  /** Advances `registryEpoch`. */
  bumpRegistry: () => void;
  scheduleDebouncedSave: () => void;
}

/**
 * Actions that hand project plugins, derived data, texture encoding, asset
 * loading, asset chunks and export to ProjectService. Every callback keeps
 * its identity for the provider's lifetime.
 */
export function useProjectAssetActions({
  projectService,
  documentService,
  sourceControlRef,
  projectDocumentRef,
  ensureDerived,
  bump,
  bumpRegistry,
  scheduleDebouncedSave,
}: ProjectAssetActionDeps) {
  const applyPluginOverrides = useCallback(
    async (overrides: Record<string, PluginEnableOverride>) => {
      await projectService.applyPluginOverrides(overrides);
      bump();
    },
    [bump, projectService],
  );

  const deleteProjectPlugin = useCallback(
    async (guid: string) => {
      await projectService.deleteProjectPlugin(guid);
      bump();
    },
    [bump, projectService],
  );

  const exportPlugin = useCallback(
    (guid: string) => projectService.exportPlugin(guid),
    [projectService],
  );

  const importPlugin = useCallback(
    async (bytes: Uint8Array, decision?: "keep" | "replace", options?: PluginImportOptions) => {
      const result = await projectService.importPlugin(bytes, decision, options);
      bump();
      return result;
    },
    [bump, projectService],
  );

  const readProjectDerivedText = useCallback(async (projectGuid: string, name: string) => {
    const storage = await ensureDerived();
    const path = `${derivedDataRoot(projectGuid)}/${name}`;
    return await storage.exists(path) ? storage.readText(path) : null;
  }, [ensureDerived]);

  const writeProjectDerivedText = useCallback(async (projectGuid: string, name: string, text: string) => {
    await (await ensureDerived()).writeText(`${derivedDataRoot(projectGuid)}/${name}`, text);
  }, [ensureDerived]);

  // A retry writes the Texture's file, so one someone else has locked waits.
  const retryFailedTextureEncoding = useCallback(async () => {
    const count = await projectService.retryAllFailedTextureEncoding((path) => sourceControlRef.current.lockedByOther(path) !== null);
    bump();
    return count;
  }, [bump, projectService, sourceControlRef]);

  const reclaimUnusedProjectStorage = useCallback(async () => {
    const result = await projectService.reclaimUnusedBlobs();
    bump();
    return result;
  }, [bump, projectService]);

  const retryTextureEncoding = useCallback(
    async (
      guid: string,
      options?: { maxDimension?: number; force?: boolean; usage?: string },
    ) => {
      const ok = await requeueWithEditLock(
        sourceControlRef.current,
        projectService.registry?.getByGuid(guid)?.path,
        () => projectService.retryTextureEncoding(guid, options),
      );
      bump();
      return ok;
    },
    [bump, projectService, sourceControlRef],
  );

  const textureAlignmentStale = useCallback<ProjectService["textureAlignmentStale"]>(
    (guid, usage) => projectService.textureAlignmentStale(guid, usage),
    [projectService],
  );

  // Writes the Texture's emission into its file (also when a rectangular light first shows it).
  const prepareAreaEmission = useCallback<ProjectService["prepareAreaEmission"]>(async (guid, options) => {
    const path = projectService.registry?.getByGuid(guid)?.path;
    if (path !== undefined) assertWritableUnderLock(sourceControlRef.current, path);
    await projectService.prepareAreaEmission(guid, options);
    bump();
  }, [bump, projectService, sourceControlRef]);

  // Rewrites the Texture file, so a written conversion locks it like a re-encode.
  const reconvertHdrEnvironment = useCallback<ProjectService["reconvertHdrEnvironment"]>(async (guid, faceSize, options) => {
    const written = await requeueWithEditLock(
      sourceControlRef.current,
      projectService.registry?.getByGuid(guid)?.path,
      () => projectService.reconvertHdrEnvironment(guid, faceSize, options),
    );
    bump();
    return written;
  }, [bump, projectService, sourceControlRef]);

  const onSessionDiagnostic = useCallback(
    (listener: (line: string) => void) => projectService.onDiagnostic(listener),
    [projectService],
  );

  const setShowPluginContent = useCallback(
    (show: boolean) => {
      documentService.setShowPluginContent(show);
      scheduleDebouncedSave();
      bumpRegistry();
    },
    [bumpRegistry, documentService, scheduleDebouncedSave],
  );

  const createProjectPlugin = useCallback(
    async (displayName: string) =>
      createProjectPluginAndRevealContent(
        (name) => projectService.createProjectPlugin(name),
        setShowPluginContent,
        displayName,
      ),
    [projectService, setShowPluginContent],
  );

  const exportProject = useCallback(async (snapshot?: ProjectDocument) => {
    return projectService.exportZip(snapshot);
  }, [projectService]);

  // The export pipeline (closure, compile, pack) loads on first export.
  const exportGameArtifact = useCallback(
    async (options: ExportGameArtifactOptions) => {
      const current = projectDocumentRef.current;
      const { exportProjectGameArtifact } = await import("../services/export-game-artifact");
      return exportProjectGameArtifact(projectService, current, options);
    },
    [projectService, projectDocumentRef],
  );

  const zipExportedGame = useCallback(async (artifact: ExportArtifact) => {
    const { zipExportInBackground } = await import("@haptic/exporter/desktop-package-client");
    return zipExportInBackground(artifact.files);
  }, []);

  const textureUsageBlockedReason = useCallback(
    (guid: string): string | null => {
      const registry = projectService.registry;
      const asset = registry?.getByGuid(guid);
      if (!asset || asset.header.type !== "Texture") return null;
      if (
        registry?.getRoot(asset.rootId)?.readOnly ||
        isPluginDocumentReadOnly(projectService.plugins, asset.path)
      ) {
        return "The Texture is read-only.";
      }
      const sourceControl = sourceControlRef.current;
      // Read-only under another user's lock, and after Edit Anyway too: a
      // re-encode writes the file, which no edit may while their lock holds.
      if (sourceControl.isDocumentReadOnly(asset.path) || sourceControl.lockedByOther(asset.path)) {
        const owner = sourceControl.lockForPath(asset.path)?.ownerName;
        return owner ? `The Texture is locked by ${owner}.` : "The Texture is locked.";
      }
      return null;
    },
    [projectService, sourceControlRef],
  );

  // An open Texture tab's Usage may be an unsaved Details edit that already
  // re-encoded; the texture alignment pass must not undo it with the saved Usage.
  useEffect(() => {
    projectService.setOpenTextureUsage((guid) => {
      const asset = projectService.registry?.getByGuid(guid);
      if (!asset) return undefined;
      const open = documentService
        .getState()
        .openDocuments.get(documentId({ kind: "texture", path: asset.path }));
      const usage = (open?.content as { usage?: unknown } | null | undefined)?.usage;
      return typeof usage === "string" ? usage : undefined;
    });
    return () => projectService.setOpenTextureUsage(null);
  }, [documentService, projectService]);

  const createAssetLoadScope = useCallback(
    (owner: string, options?: AssetLoadScopeOptions) => projectService.createAssetLoadScope(owner, options),
    [projectService],
  );

  const getAssetLoadState = useCallback(
    (guid: string): AssetLoadState => projectService.registry
      ? projectService.assetLoadingService.getLoadState(guid)
      : "unloaded",
    [projectService],
  );

  // These write the asset's file at once, so someone else's lock refuses them.
  const writeSceneNavmeshChunk = useCallback(
    async (path: string, bytes: Uint8Array, payload: Record<string, unknown>) => {
      assertWritableUnderLock(sourceControlRef.current, path);
      return projectService.writeSceneNavmeshChunk(path, bytes, payload);
    },
    [projectService, sourceControlRef],
  );

  const writeSceneAudioReverbChunk = useCallback(
    async (path: string, bytes: Uint8Array, payload: Record<string, unknown>) => {
      assertWritableUnderLock(sourceControlRef.current, path);
      return projectService.writeSceneAudioReverbChunk(path, bytes, payload);
    },
    [projectService, sourceControlRef],
  );

  const writeAudioClipChunk = useCallback(
    async (
      path: string,
      chunkId: string,
      bytes: Uint8Array,
      mime: string,
      payload: Record<string, unknown>,
    ) => {
      assertWritableUnderLock(sourceControlRef.current, path);
      return projectService.writeAudioClipChunk(path, chunkId, bytes, mime, payload);
    },
    [projectService, sourceControlRef],
  );

  const removeAudioClipChunk = useCallback(
    async (path: string, chunkId: string, payload: Record<string, unknown>) => {
      assertWritableUnderLock(sourceControlRef.current, path);
      return projectService.removeAudioClipChunk(path, chunkId, payload);
    },
    [projectService, sourceControlRef],
  );

  const loadAssetDocument = useCallback(
    async (
      kind: AssetDocumentKind,
      path: string,
    ): Promise<unknown | null> => {
      const openDoc = documentService
        .getState()
        .openDocuments.get(documentId({ kind, path }));
      if (openDoc?.content) return openDoc.content;
      try {
        return await projectService.loadDocument(kind, path, {
          scope: documentService.getAssetLoadScope(documentService.getState().activeDocumentId ?? ""),
        });
      } catch (error) {
        console.error(`[editor] failed to load ${kind} ${path}`, error);
        return null;
      }
    },
    [documentService, projectService],
  );

  const loadGraphDocument = useCallback(
    async (path: string): Promise<SerializedGraph | null> => {
      const openDoc = documentService
        .getState()
        .openDocuments.get(documentId({ kind: "graph", path }));
      if (openDoc?.content) return openDoc.content as SerializedGraph;
      try {
        return (await projectService.loadDocument(
          "graph",
          path,
        )) as SerializedGraph;
      } catch (error) {
        console.error(`[place] failed to load class ${path}`, error);
        return null;
      }
    },
    [documentService, projectService],
  );

  const actions = useMemo(
    (): Pick<
      DocumentActions,
      | "setShowPluginContent"
      | "applyPluginOverrides"
      | "createProjectPlugin"
      | "deleteProjectPlugin"
      | "exportPlugin"
      | "importPlugin"
      | "readProjectDerivedText"
      | "writeProjectDerivedText"
      | "retryFailedTextureEncoding"
      | "reclaimUnusedProjectStorage"
      | "prepareAreaEmission"
      | "reconvertHdrEnvironment"
      | "retryTextureEncoding"
      | "textureAlignmentStale"
      | "textureUsageBlockedReason"
      | "onSessionDiagnostic"
      | "exportProject"
      | "exportGameArtifact"
      | "zipExportedGame"
      | "createAssetLoadScope"
      | "getAssetLoadState"
      | "writeAudioClipChunk"
      | "removeAudioClipChunk"
      | "writeSceneNavmeshChunk"
      | "writeSceneAudioReverbChunk"
      | "loadAssetDocument"
      | "loadGraphDocument"
    > => ({
      setShowPluginContent,
      applyPluginOverrides,
      createProjectPlugin,
      deleteProjectPlugin,
      exportPlugin,
      importPlugin,
      readProjectDerivedText,
      writeProjectDerivedText,
      retryFailedTextureEncoding,
      reclaimUnusedProjectStorage,
      prepareAreaEmission,
      reconvertHdrEnvironment,
      retryTextureEncoding,
      textureAlignmentStale,
      textureUsageBlockedReason,
      onSessionDiagnostic,
      exportProject,
      exportGameArtifact,
      zipExportedGame,
      createAssetLoadScope,
      getAssetLoadState,
      writeAudioClipChunk,
      removeAudioClipChunk,
      writeSceneNavmeshChunk,
      writeSceneAudioReverbChunk,
      loadAssetDocument,
      loadGraphDocument,
    }),
    [
      setShowPluginContent,
      applyPluginOverrides,
      createProjectPlugin,
      deleteProjectPlugin,
      exportPlugin,
      importPlugin,
      readProjectDerivedText,
      writeProjectDerivedText,
      retryFailedTextureEncoding,
      reclaimUnusedProjectStorage,
      prepareAreaEmission,
      reconvertHdrEnvironment,
      retryTextureEncoding,
      textureAlignmentStale,
      textureUsageBlockedReason,
      onSessionDiagnostic,
      exportProject,
      exportGameArtifact,
      zipExportedGame,
      createAssetLoadScope,
      getAssetLoadState,
      writeAudioClipChunk,
      removeAudioClipChunk,
      writeSceneNavmeshChunk,
      writeSceneAudioReverbChunk,
      loadAssetDocument,
      loadGraphDocument,
    ],
  );

  return { actions };
}
