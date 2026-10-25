import type { ProjectDocument, ProjectStorage, SerializedGraph, SerializedScene } from "@haptic/core";
import { getTile, normalizeTilemapPayload, readJournalLines } from "@haptic/assets";
import { resolveJournalLines } from "@haptic/edit";
import { editorQuiet } from "../lib/editor-quiet";
import { advanceTestIdleClock } from "../lib/document-working-set";
import { lastEnginePluginLoad } from "../lib/engine-plugins";
import { lastNavBakeSaveResult } from "../lib/nav-bake-save";
import type { JournalBuffer } from "../lib/journal-buffer";
import {
  clearDocumentDirtyTrace,
  documentDirtyTrace,
  saveAllProgress,
  saveAllTrace,
} from "../lib/dirty-trace";
import { renderProfile, resetRenderProfile, type RenderProfile } from "../lib/render-profile";
import { shownCompressionState, unfinishedTextureEncodePaths } from "../lib/texture-encode-state";
import type { DocumentService } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import type { DocumentContextValue } from "./document-context-types";

/** What the end-to-end test hooks read from `DocumentProvider`. */
export interface EditorTestHookDeps {
  projectService: ProjectService;
  documentService: DocumentService;
  sourceControl: SourceControlService;
  journalBuffer: JournalBuffer;
  ensureDerived: () => Promise<ProjectStorage>;
  bump: () => void;
  cancelDebouncedSave: () => void;
  projectDocument: () => ProjectDocument | null;
  isProjectDirty: () => boolean;
  runForegroundRescan: () => Promise<void>;
  applyGraphChange: DocumentContextValue["applyGraphChange"];
  applySceneChange: DocumentContextValue["applySceneChange"];
  updateProjectSettings: DocumentContextValue["updateProjectSettings"];
}

/**
 * Test Mode only: installs `globalThis.__hapticTest`, the hooks end-to-end
 * tests drive the editor through, and `__hapticSourceControl`. Returns the
 * uninstall.
 */
export function installEditorTestHooks(deps: EditorTestHookDeps): () => void {
  const {
    projectService,
    documentService,
    sourceControl,
    journalBuffer,
    ensureDerived,
    bump,
    cancelDebouncedSave,
    projectDocument,
    isProjectDirty,
    runForegroundRescan,
    applyGraphChange,
    applySceneChange,
    updateProjectSettings,
  } = deps;
  const host = globalThis as {
    __hapticTest?: {
      ensureMainGraphOpen: () => Promise<boolean>;
      nudgeActiveGraphNode: () => Promise<boolean>;
      cancelDebouncedSave: () => void;
      /** A game covers the editor, so its background work waits (`editor-quiet`). */
      editorQuiet: () => boolean;
      assetLoading: () => { sources: ReturnType<import("@haptic/assets").AssetLoadingService["snapshot"]>; storage: import("@haptic/core").StorageReadMetrics | null; chunks: ReturnType<import("@haptic/assets").AccountedPayloadLoader["snapshot"]> | null; requestedPayloadBytes: number };
      trimAssetSources: () => void;
      activeGraphNodePosition: () => { x: number; y: number } | null;
      hasRecoveryJournal: () => Promise<boolean>;
      /** Move the first scene actor by a fixed delta through the command layer. */
      nudgeActiveSceneActor: () => Promise<boolean>;
      activeSceneActorPosition: () => [number, number, number] | null;
      injectTestGamepad: (pad: {
        index?: number;
        axes?: number[];
        buttons?: number[];
      } | null) => void;
      injectTestTouchAxis: (axes: Record<string, number> | null) => void;
      setMainGraphContent: (graph: SerializedGraph) => Promise<boolean>;
      setMainGraphComponents: (
        components: SerializedGraph["components"],
      ) => Promise<boolean>;
      setActiveSceneContent: (scene: SerializedScene) => Promise<boolean>;
      activeSceneContent: () => SerializedScene | null;
      advanceIdleClock: (ms: number) => void;
      guidForPath: (path: string) => string | null;
      readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
      lastNavBake: () => {
        ok: boolean;
        path: string | null;
        byteLength: number;
        error: string | null;
      } | null;
      projectStartupSceneGuid: () => string;
      pluginGuids: () => string[];
      enginePluginLoad: () => {
        entries: number;
        errors: string[];
      };
      seedMissingPluginOverride: (guid: string) => Promise<{
        guid: string;
        type: string;
        path: string;
        placeholder: boolean;
      } | null>;
      activeTilemapTile: (gx: number, gy: number) => number | null;
      touchAssetOnDisk: (path: string) => Promise<void>;
      runForegroundRescan: () => Promise<void>;
      documentDirtyTrace: () => { kind: string; id: string; via?: string }[];
      clearDocumentDirtyTrace: () => void;
      saveAllProgress: typeof saveAllProgress;
      saveAllTrace: () => {
        ok: boolean;
        reason: string;
        dirtyBefore: number;
        dirtyAfter: number;
        error?: string;
      } | null;
      dirtyDocuments: () => { kind: string; id: string }[];
      /** Per-region React commits since the last reset (editor-edit profiling builds). */
      renderProfile: () => RenderProfile;
      resetRenderProfile: () => void;
      /** Texture alignment passes run and queued, and the Textures they requeued. */
      textureAlignment: () => { runs: number; pending: number; requeued: string[] };
      /** Texture paths whose KTX2 encode is still pending or running. */
      pendingTextureEncodes: () => string[];
      textureEncodeState: (path: string) => {
        compressionState: string | null;
        encodeError: string | null;
        hasPixels: boolean;
        /** Committed encode (`payload.ktx2ChunkId`) for reading its KTX2 header. */
        ktx2ChunkId: string | null;
      } | null;
    };
    __hapticSourceControl?: SourceControlService;
  };
  host.__hapticSourceControl = sourceControl;
  host.__hapticTest = {
    assetLoading: () => ({ sources: projectService.assetLoadingService.snapshot(), storage: projectService.storagePort.getReadMetrics?.() ?? null, chunks: projectService.registry?.payloadLoader.snapshot() ?? null, requestedPayloadBytes: projectService.registry?.accountedPayloadBytes ?? 0 }),
    trimAssetSources: () => projectService.assetLoadingService.trim({ force: true }),
    editorQuiet,
    cancelDebouncedSave,
    activeGraphNodePosition: () => {
      const doc = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "graph" && entry.content,
      );
      const graph = doc?.content as SerializedGraph | undefined;
      return graph?.nodes[0]?.position
        ? { ...graph.nodes[0].position }
        : null;
    },
    hasRecoveryJournal: async () => {
      const guid = projectService.guid;
      if (!guid) return false;
      const derived = await ensureDerived();
      return journalBuffer.afterFlush(guid, async () =>
        resolveJournalLines(await readJournalLines(derived, guid)).length > 0,
      );
    },
    /** Open main graph without activating it (avoids GraphEditor stomping edits). */
    ensureMainGraphOpen: async () => {
      const candidates = [
        "assets/Mannequin.class.hasset",
        "assets/main.class.hasset",
      ];
      const existing = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "graph",
      );
      if (existing?.content != null) return true;
      const registry = projectService.registry;
      const path =
        existing?.ref.path ?? candidates.find((candidate) =>
          registry?.list().some((asset) => asset.path === candidate),
        ) ?? candidates[0]!;
      const id = `graph:${path}`;
      if (documentService.getState().openDocuments.get(id)?.content == null) {
        await documentService.openDocument(
          projectService,
          { kind: "graph", path, label: path.split("/").pop() ?? path },
          null,
          false,
        );
        bump();
      }
      return documentService.getState().openDocuments.get(id)?.content != null;
    },
    nudgeActiveGraphNode: async () => {
      const openDocuments = documentService.getState().openDocuments;
      const id = [...openDocuments.values()].find((d) => d.ref.kind === "graph")
        ?.id;
      if (!id) return false;
      const doc = openDocuments.get(id);
      if (!doc?.content) return false;
      const graph = structuredClone(doc.content as SerializedGraph);
      if (!graph.nodes[0]) return false;
      graph.nodes[0] = {
        ...graph.nodes[0],
        position: {
          x: graph.nodes[0].position.x + 42,
          y: graph.nodes[0].position.y + 17,
        },
      };
      return applyGraphChange(id, graph);
    },
    activeSceneActorPosition: () => {
      const doc = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "scene" && entry.content,
      );
      const scene = doc?.content as SerializedScene | undefined;
      const position = scene?.actors[0]?.transform.position;
      return position ? [...position] : null;
    },
    nudgeActiveSceneActor: async () => {
      const openDocuments = documentService.getState().openDocuments;
      const id = [...openDocuments.values()].find((d) => d.ref.kind === "scene")
        ?.id;
      if (!id) return false;
      const doc = openDocuments.get(id);
      if (!doc?.content) return false;
      const scene = structuredClone(doc.content as SerializedScene);
      const actor = scene.actors[0];
      if (!actor) return false;
      const [x, y, z] = actor.transform.position;
      scene.actors[0] = {
        ...actor,
        transform: {
          ...actor.transform,
          position: [x + 1.5, y, z],
        },
      };
      return applySceneChange(id, scene);
    },
    injectTestGamepad: (pad) => {
      const globalHost = globalThis as {
        __hapticTestGamepad?: {
          index: number;
          axes: number[];
          buttons: number[];
        };
      };
      if (!pad) {
        delete globalHost.__hapticTestGamepad;
        return;
      }
      globalHost.__hapticTestGamepad = {
        index: pad.index ?? 0,
        axes: pad.axes ?? [0, 0, 0, 0],
        buttons: pad.buttons ?? [0, 0, 0, 0],
      };
    },
    injectTestTouchAxis: (axes) => {
      const globalHost = globalThis as {
        __hapticTestTouchAxes?: Record<string, number>;
      };
      if (!axes) {
        delete globalHost.__hapticTestTouchAxes;
        return;
      }
      globalHost.__hapticTestTouchAxes = { ...axes };
    },
    /** Replace the main graph so Preview compiles a known script. */
    setMainGraphContent: async (graph: SerializedGraph) => {
      const candidates = [
        "assets/Mannequin.class.hasset",
        "assets/main.class.hasset",
      ];
      const openGraph = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "graph",
      );
      const path =
        openGraph?.ref.path ??
        candidates.find((candidate) =>
          projectService.registry
            ?.list()
            .some((asset) => asset.path === candidate),
        ) ??
        candidates[0]!;
      const id = `graph:${path}`;
      if (!documentService.getState().openDocuments.has(id)) {
        await documentService.openDocument(
          projectService,
          { kind: "graph", path, label: path.split("/").pop() ?? path },
          null,
          false,
        );
      }
      documentService.updateGraph(id, graph);
      bump();
      return true;
    },
    setMainGraphComponents: async (components) => {
      const openGraph = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "graph" && entry.content,
      );
      if (!openGraph?.content) return false;
      const graph = structuredClone(openGraph.content as SerializedGraph);
      graph.components = structuredClone(components);
      return applyGraphChange(openGraph.id, graph);
    },
    activeSceneContent: () => {
      const scene = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "scene",
      )?.content;
      return scene ? structuredClone(scene as SerializedScene) : null;
    },
    setActiveSceneContent: async (scene) => {
      const openScene = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "scene",
      );
      if (!openScene) return false;
      return applySceneChange(openScene.id, structuredClone(scene));
    },
    advanceIdleClock: (ms: number) => {
      advanceTestIdleClock(ms);
    },
    guidForPath: (path: string) => projectService.guidForPath(path),
    readAssetChunk: (path: string, chunkId: string) =>
      projectService.readAssetChunk(path, chunkId),
    lastNavBake: () => lastNavBakeSaveResult(),
    textureAlignment: () => projectService.textureAlignmentState,
    pendingTextureEncodes: () =>
      unfinishedTextureEncodePaths(projectService.registry?.list() ?? [], projectService.textureEncodingGuids),
    textureEncodeState: (path: string) => {
      const asset = projectService.registry
        ?.list()
        .find((entry) => entry.path === path);
      if (!asset) return null;
      const state = shownCompressionState(
        asset.header.payload.compressionState,
        projectService.textureEncodingGuids.has(asset.header.guid),
      );
      const encodeError = asset.header.payload.encodeError;
      const ktx2ChunkId = asset.header.payload.ktx2ChunkId;
      return {
        compressionState: state,
        encodeError: typeof encodeError === "string" ? encodeError : null,
        hasPixels: asset.header.chunks.some(
          (chunk) => chunk.kind === "pixels" || chunk.id === "pixels",
        ),
        ktx2ChunkId: typeof ktx2ChunkId === "string" ? ktx2ChunkId : null,
      };
    },
    projectStartupSceneGuid: () =>
      projectDocument()?.settings.startupSceneGuid?.trim() ?? "",
    pluginGuids: () =>
      projectService.plugins.map((plugin) => plugin.pluginGuid),
    enginePluginLoad: () => ({ ...lastEnginePluginLoad }),
    seedMissingPluginOverride: async (guid: string) => {
      const current =
        projectDocument()?.settings.pluginOverrides ?? {};
      const next = { ...current, [guid]: { enabled: true } };
      updateProjectSettings({ pluginOverrides: next });
      await projectService.applyPluginOverrides(next);
      bump();
      const asset = projectService.registry?.getByGuid(guid);
      if (!asset) return null;
      return {
        guid: asset.header.guid,
        type: asset.header.type,
        path: asset.path,
        placeholder: asset.placeholder === true,
      };
    },
    activeTilemapTile: (gx: number, gy: number) => {
      const doc = [...documentService.getState().openDocuments.values()].find(
        (entry) => entry.ref.kind === "tilemap" && entry.content,
      );
      if (!doc?.content) return null;
      const map = normalizeTilemapPayload(doc.content);
      const layerId = map.layers[0]?.id;
      if (!layerId) return null;
      return getTile(map, layerId, gx, gy);
    },
    touchAssetOnDisk: async (path: string) => {
      const storage = projectService.storagePort;
      if (!(await storage.exists(path))) return;
      const bytes = await storage.readBinary(path);
      await storage.writeBinary(path, bytes);
    },
    runForegroundRescan: () => runForegroundRescan(),
    documentDirtyTrace,
    clearDocumentDirtyTrace,
    saveAllProgress,
    saveAllTrace,
    renderProfile,
    resetRenderProfile,
    dirtyDocuments: () => [
      ...documentService.getDirtyDocuments().map((doc) => ({
        kind: doc.ref.kind,
        id: doc.id,
      })),
      ...(isProjectDirty() ? [{ kind: "project", id: "project" }] : []),
    ],
  };
  return () => {
    delete host.__hapticTest;
    delete host.__hapticSourceControl;
    delete (globalThis as { __hapticTestGamepad?: unknown })
      .__hapticTestGamepad;
    delete (globalThis as { __hapticTestTouchAxes?: unknown })
      .__hapticTestTouchAxes;
  };
}
