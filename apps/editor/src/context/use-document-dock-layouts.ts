import { useCallback, useRef, useState, type RefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { createAppSettingsStore } from "@haptic/vfs";
import { captureAdaptiveDockviewLayout, isPhoneDockLayout } from "../shell/phone-dock-layout";
import { parseSceneDocumentLayout, SCENE_MODES, type SceneMode } from "../shell/scene-document-layout";
import { applyFocusLayout, focusKeepPanelIds } from "../shell/layout-ops";
import {
  capturePanelPlacement,
  isDockWindowOpen as isDockWindowOpenOnApi,
  listDockPanels,
  toggleDockWindow as toggleDockWindowOnApi,
  type DockWindowApi,
} from "../shell/dock-window-ops";
import { isFunctionGraphPanelId } from "../shell/function-graph-panels";
import {
  isDockviewDocumentKind,
  listDockWindows,
  type DockWindowOptions,
} from "../shell/window-catalog";
import {
  applyPreFocusToAnimLayout,
  parseAnimDocumentLayout,
  serializeAnimDocumentLayout,
  type AnimEditorMode,
} from "../shell/anim-document-layout";
import {
  dockviewApiKey,
  dockviewApiKeyPairs,
  dockviewApiKeysForDocument,
  dockviewSurfaceForAnimMode,
  type DockviewSurface,
  type PreFocusSnapshot,
} from "../shell/dockview-surface";
import {
  classDocumentShowsPrefab,
  classParentLookup,
  registryClassParentLookup,
} from "../lib/class-asset-lookup";
import { moveKeyedEntry } from "../lib/move-keyed-entry";
import type { DocumentService, OpenDocument } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import { useRefState } from "./use-ref-state";

function asDockWindowApi(api: DockviewApi): DockWindowApi {
  return api as unknown as DockWindowApi;
}

function dockOptionsForIndexed(
  kind: string,
  indexed:
    | { header: { type: string; parentClass?: string | null } }
    | undefined,
  parentOf: (id: string) => string | null | undefined,
  sourceControlEnabled = false,
  animEditorMode?: AnimEditorMode,
  sceneMode?: SceneMode,
): DockWindowOptions {
  return {
    actorPrefab:
      kind !== "graph" ||
      !indexed ||
      classDocumentShowsPrefab(indexed.header.parentClass, (id) => parentOf(id) ?? null),
    sourceControl: sourceControlEnabled,
    sceneMode: kind === "scene" ? (sceneMode ?? "design") : undefined,
    animEditorMode:
      kind === "anim-graph" ? (animEditorMode ?? "stateMachine") : undefined,
  };
}

export function animEditorModeForDocument(
  id: string,
  modes: Record<string, AnimEditorMode>,
  doc: OpenDocument | undefined,
): AnimEditorMode {
  if (modes[id]) return modes[id];
  if (doc?.ref.kind === "anim-graph") {
    return parseAnimDocumentLayout(doc.layout).animEditorMode;
  }
  return "stateMachine";
}

function findWindowDefinition(
  kind: string,
  panelId: string,
  dockOptions: DockWindowOptions = {},
) {
  if (!isDockviewDocumentKind(kind)) return undefined;
  return listDockWindows(kind, dockOptions).find((entry) => entry.id === panelId);
}

function restorePreFocusSnapshot(
  id: string,
  snapshot: PreFocusSnapshot,
  apis: Map<string, DockviewApi>,
): void {
  const api =
    apis.get(dockviewApiKey(id, snapshot.surface)) ?? apis.get(id);
  api?.fromJSON(snapshot.layout as never);
}

export interface DocumentDockLayoutDeps {
  documentService: DocumentService;
  projectService: ProjectService;
  sourceControlRef: RefObject<SourceControlService>;
  settingsStore: ReturnType<typeof createAppSettingsStore>;
  /** Re-derives the document context value. */
  bump: () => void;
}

/**
 * Each open document's DockView layouts: the live APIs per surface, Focus
 * snapshots, Anim modes, remembered panel placements and the Windows menu.
 * Every callback keeps its identity for the provider's lifetime.
 */
export function useDocumentDockLayouts({
  documentService,
  projectService,
  sourceControlRef,
  settingsStore,
  bump,
}: DocumentDockLayoutDeps) {
  const dockviewApisRef = useRef(new Map<string, DockviewApi>());
  const dockSubscriptionsRef = useRef(new Map<string, Array<{ dispose: () => void }>>());
  const preFocusLayoutsRef = useRef(new Map<string, PreFocusSnapshot>());
  const sceneFocusedLayoutsRef = useRef(new Map<string, Record<string, unknown>>());
  // Callbacks read Anim modes when they run, from the ref its setter writes.
  const animEditorModesRef = useRef<Record<string, AnimEditorMode>>({});
  const [animEditorModes, setAnimEditorModes] = useRefState(animEditorModesRef);
  const [focusedLayoutIds, setFocusedLayoutIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [dockWindowTick, setDockWindowTick] = useState(0);

  const bumpDockWindows = useCallback(() => {
    setDockWindowTick((v) => v + 1);
  }, []);

  const disposeDockSubscriptions = useCallback((id?: string) => {
    const keys = id
      ? [id, ...dockviewApiKeysForDocument(id)].filter(
          (key, index, all) => all.indexOf(key) === index,
        )
      : [...dockSubscriptionsRef.current.keys()];
    for (const key of keys) {
      for (const sub of dockSubscriptionsRef.current.get(key) ?? []) {
        sub.dispose();
      }
      dockSubscriptionsRef.current.delete(key);
    }
    if (!id) dockSubscriptionsRef.current.clear();
  }, []);

  const captureLayoutForId = useCallback(
    (id: string) => {
      const doc = documentService.getDocument(id);
      if (doc?.ref.kind === "scene") {
        const layout = parseSceneDocumentLayout(doc.layout);
        for (const mode of SCENE_MODES) {
          const key = dockviewApiKey(id, mode);
          const api = dockviewApisRef.current.get(key);
          const beforeFocus = preFocusLayoutsRef.current.get(key);
          if (api) {
            const live = captureAdaptiveDockviewLayout(api);
            layout[mode] = beforeFocus?.layout ?? live;
            if (beforeFocus) sceneFocusedLayoutsRef.current.set(key, api.toJSON() as unknown as Record<string, unknown>);
          } else if (beforeFocus) layout[mode] = beforeFocus.layout;
        }
        documentService.setLayout(id, layout);
        return;
      }
      if (doc?.ref.kind === "anim-graph") {
        const parsed = parseAnimDocumentLayout(doc.layout);
        const mode = animEditorModeForDocument(id, animEditorModesRef.current, doc);
        const stateApi = dockviewApisRef.current.get(
          dockviewApiKey(id, "stateMachine"),
        );
        const objectApi = dockviewApisRef.current.get(
          dockviewApiKey(id, "animationObject"),
        );
        const live = {
          animEditorMode: mode,
          stateMachine: stateApi
            ? captureAdaptiveDockviewLayout(stateApi)
            : parsed.stateMachine,
          animationObject: objectApi
            ? captureAdaptiveDockviewLayout(objectApi)
            : parsed.animationObject,
        };
        const animPreFocus = preFocusLayoutsRef.current.get(id);
        documentService.setLayout(
          id,
          serializeAnimDocumentLayout(
            animPreFocus
              ? applyPreFocusToAnimLayout(live, animPreFocus)
              : live,
          ),
        );
        return;
      }
      const preFocus = preFocusLayoutsRef.current.get(id);
      if (preFocus) {
        documentService.setLayout(id, preFocus.layout);
        return;
      }
      const api = dockviewApisRef.current.get(id);
      if (api) {
        documentService.setLayout(id, captureAdaptiveDockviewLayout(api));
      }
    },
    [documentService],
  );

  const captureAllLayouts = useCallback(() => {
    const { tabOrder } = documentService.getState();
    for (const id of tabOrder) {
      captureLayoutForId(id);
    }
  }, [captureLayoutForId, documentService]);

  /** Opening or closing a project forgets every document's dock state. */
  const resetDockLayouts = useCallback(() => {
    dockviewApisRef.current.clear();
    disposeDockSubscriptions();
    preFocusLayoutsRef.current.clear();
    sceneFocusedLayoutsRef.current.clear();
    setFocusedLayoutIds(new Set());
  }, [disposeDockSubscriptions]);

  /** A repathed document's Focus state and Anim mode follow it to `newId`. */
  const moveDockLayouts = useCallback((oldId: string, newId: string) => {
    // Live dock handles belong to the workspace unmounting under the old
    // id. Release them as closeDocument does, so its teardown cannot write
    // placements back under the old id; the remount registers new ones.
    for (const key of dockviewApiKeysForDocument(oldId)) {
      dockviewApisRef.current.delete(key);
    }
    disposeDockSubscriptions(oldId);
    const pairs = dockviewApiKeyPairs(oldId, newId);
    for (const [from, to] of pairs) {
      moveKeyedEntry(preFocusLayoutsRef.current, from, to);
      moveKeyedEntry(sceneFocusedLayoutsRef.current, from, to);
    }
    setFocusedLayoutIds((current) => {
      if (!pairs.some(([from, to]) => current.has(from) || current.has(to))) {
        return current;
      }
      const next = new Set(current);
      for (const [from, to] of pairs) {
        next.delete(to);
        if (current.has(from)) {
          next.delete(from);
          next.add(to);
        }
      }
      return next;
    });
    setAnimEditorModes((current) => {
      if (!(oldId in current) && !(newId in current)) return current;
      const next = { ...current };
      const mode = next[oldId];
      delete next[oldId];
      delete next[newId];
      if (mode) next[newId] = mode;
      return next;
    });
  }, [disposeDockSubscriptions, setAnimEditorModes]);

  /** A closed document leaves no dock state behind. */
  const forgetDockLayouts = useCallback((id: string) => {
    for (const key of dockviewApiKeysForDocument(id)) {
      dockviewApisRef.current.delete(key);
      preFocusLayoutsRef.current.delete(key);
      sceneFocusedLayoutsRef.current.delete(key);
    }
    disposeDockSubscriptions(id);
    preFocusLayoutsRef.current.delete(id);
    setAnimEditorModes((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setFocusedLayoutIds((current) => {
      const next = new Set(current);
      for (const key of dockviewApiKeysForDocument(id)) next.delete(key);
      return next;
    });
  }, [disposeDockSubscriptions, setAnimEditorModes]);

  const registerDockviewApi = useCallback((
    id: string,
    api: DockviewApi,
    surface: DockviewSurface = "default",
  ) => {
    const key = dockviewApiKey(id, surface);
    dockviewApisRef.current.set(key, api);
    const sceneFocusedLayout = sceneFocusedLayoutsRef.current.get(key);
    if (preFocusLayoutsRef.current.has(key) && sceneFocusedLayout) {
      api.fromJSON(sceneFocusedLayout as never);
    }
    for (const sub of dockSubscriptionsRef.current.get(key) ?? []) {
      sub.dispose();
    }
    dockSubscriptionsRef.current.delete(key);
    // Drags and resizes fire layout changes continuously: the Class parent
    // lookup is rebuilt only when the registry changes.
    let parentLookup: { generation: number; parentOf: ReturnType<typeof classParentLookup> } | null = null;
    const rememberPlacements = () => {
      if (preFocusLayoutsRef.current.has(key) || preFocusLayoutsRef.current.has(id) || isPhoneDockLayout(api)) return;
      const dock = asDockWindowApi(api);
      const doc = documentService.getDocument(id);
      const kind = doc?.ref.kind;
      const indexed = doc ? projectService.registry?.getByPath(doc.ref.path) : undefined;
      const generation = projectService.registryGeneration;
      if (parentLookup?.generation !== generation) {
        parentLookup = { generation, parentOf: classParentLookup(projectService.registry?.list() ?? []) };
      }
      const parentOf = parentLookup.parentOf;
      const animSurfaceMode: AnimEditorMode | undefined =
        surface === "animationObject"
          ? "animationObject"
          : surface === "stateMachine"
            ? "stateMachine"
            : undefined;
      const dockOptions = dockOptionsForIndexed(
        kind ?? "",
        indexed,
        parentOf,
        sourceControlRef.current.enabled,
        animSurfaceMode,
        surface === "design" || surface === "landscape" || surface === "foliage" ? surface : undefined,
      );
      for (const panel of listDockPanels(dock)) {
        // Function graph tabs persist in the DockView snapshot, not as
        // remembered catalog placements.
        if (isFunctionGraphPanelId(panel.id)) continue;
        const def = isDockviewDocumentKind(kind)
          ? findWindowDefinition(kind, panel.id, dockOptions)
          : undefined;
        const placement = capturePanelPlacement(dock, panel.id, def);
        if (placement) {
          documentService.setPanelPlacement(id, kind === "scene" ? `${surface}:${panel.id}` : panel.id, placement);
        }
      }
    };
    dockSubscriptionsRef.current.set(key, [
      api.onDidAddPanel(() => bumpDockWindows()),
      api.onDidRemovePanel(() => bumpDockWindows()),
      api.onDidLayoutChange(rememberPlacements),
    ]);
    rememberPlacements();
    bumpDockWindows();
  }, [bumpDockWindows, documentService, projectService, sourceControlRef]);

  const unregisterDockviewApi = useCallback(
    (id: string, surface: DockviewSurface = "default") => {
      const key = dockviewApiKey(id, surface);
      dockviewApisRef.current.delete(key);
      for (const sub of dockSubscriptionsRef.current.get(key) ?? []) {
        sub.dispose();
      }
      dockSubscriptionsRef.current.delete(key);
    },
    [],
  );

  const activeDockApi = useCallback((): DockviewApi | undefined => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return undefined;
    const doc = documentService.getDocument(activeDocumentId);
    if (!doc) return undefined;
    if (doc.ref.kind === "scene") {
      return dockviewApisRef.current.get(dockviewApiKey(activeDocumentId, parseSceneDocumentLayout(doc.layout).sceneMode));
    }
    if (doc.ref.kind === "anim-graph") {
      const mode = animEditorModeForDocument(
        activeDocumentId,
        animEditorModesRef.current,
        doc,
      );
      return (
        dockviewApisRef.current.get(
          dockviewApiKey(activeDocumentId, dockviewSurfaceForAnimMode(mode)),
        ) ?? dockviewApisRef.current.get(activeDocumentId)
      );
    }
    return dockviewApisRef.current.get(activeDocumentId);
  }, [documentService]);

  const setAnimEditorMode = useCallback(
    (id: string, mode: AnimEditorMode) => {
      captureLayoutForId(id);
      const doc = documentService.getDocument(id);
      const currentMode = animEditorModeForDocument(id, animEditorModesRef.current, doc);
      if (currentMode !== mode) {
        const snapshot = preFocusLayoutsRef.current.get(id);
        if (snapshot) {
          restorePreFocusSnapshot(id, snapshot, dockviewApisRef.current);
          preFocusLayoutsRef.current.delete(id);
          setFocusedLayoutIds((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      }
      setAnimEditorModes((current) =>
        current[id] === mode ? current : { ...current, [id]: mode },
      );
      if (doc?.ref.kind === "anim-graph") {
        const parsed = parseAnimDocumentLayout(doc.layout);
        if (parsed.animEditorMode !== mode) {
          documentService.setLayout(
            id,
            serializeAnimDocumentLayout({ ...parsed, animEditorMode: mode }),
          );
        }
      }
      bumpDockWindows();
    },
    [bumpDockWindows, captureLayoutForId, documentService, setAnimEditorModes],
  );

  const setSceneMode = useCallback((id: string, mode: SceneMode) => {
    if (documentService.getDocument(id)?.ref.kind !== "scene") return;
    captureLayoutForId(id);
    const layout = parseSceneDocumentLayout(documentService.getDocument(id)?.layout);
    documentService.setLayout(id, { ...layout, sceneMode: mode });
    bump();
    bumpDockWindows();
  }, [bump, bumpDockWindows, captureLayoutForId, documentService]);

  const activateDockPanel = useCallback((panelId: string) => {
    activeDockApi()?.getPanel(panelId)?.api.setActive();
  }, [activeDockApi]);

  const toggleDockWindow = useCallback((panelId: string) => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = documentService.getDocument(activeDocumentId);
    if (!doc || !isDockviewDocumentKind(doc.ref.kind)) {
      return;
    }
    const api = activeDockApi();
    if (!api) return;
    const indexed = projectService.registry?.getByPath(doc.ref.path);
    const parentOf = registryClassParentLookup(projectService.registry);
    const dockOptions = dockOptionsForIndexed(
      doc.ref.kind,
      indexed,
      parentOf,
      sourceControlRef.current.enabled,
      doc.ref.kind === "anim-graph"
        ? animEditorModeForDocument(activeDocumentId, animEditorModesRef.current, doc)
        : undefined,
      doc.ref.kind === "scene" ? parseSceneDocumentLayout(doc.layout).sceneMode : undefined,
    );
    const def = findWindowDefinition(doc.ref.kind, panelId, dockOptions);
    if (!def) return;
    const placementKey = doc.ref.kind === "scene" ? `${dockOptions.sceneMode}:${panelId}` : panelId;
    const placements = documentService.getPanelPlacements(activeDocumentId);
    const remembered = placements[placementKey] ?? (dockOptions.sceneMode === "design" ? placements[panelId] : null) ?? null;
    const result = toggleDockWindowOnApi(
      asDockWindowApi(api),
      def,
      remembered,
    );
    if (result.placement && !isPhoneDockLayout(api)) {
      documentService.setPanelPlacement(
        activeDocumentId,
        placementKey,
        result.placement,
      );
    }
    bumpDockWindows();
  }, [activeDockApi, bumpDockWindows, documentService, projectService, sourceControlRef]);

  const isDockWindowOpen = useCallback((panelId: string) => {
    const api = activeDockApi();
    return api ? isDockWindowOpenOnApi(asDockWindowApi(api), panelId) : false;
  }, [activeDockApi]);

  const getOpenDockWindowCount = useCallback(() => {
    const api = activeDockApi();
    return api ? listDockPanels(asDockWindowApi(api)).length : 0;
  }, [activeDockApi]);

  const toggleLayoutFocus = useCallback(async () => {
    const { activeDocumentId } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = documentService
      .getOpenDocumentsOrdered()
      .find((entry) => entry.id === activeDocumentId);
    if (!doc || !isDockviewDocumentKind(doc.ref.kind)) {
      return;
    }
    const api = activeDockApi();
    if (!api) return;

    const sceneMode = doc.ref.kind === "scene" ? parseSceneDocumentLayout(doc.layout).sceneMode : undefined;
    const focusKey = sceneMode ? dockviewApiKey(activeDocumentId, sceneMode) : activeDocumentId;
    if (preFocusLayoutsRef.current.has(focusKey)) {
      const snapshot = preFocusLayoutsRef.current.get(focusKey);
      preFocusLayoutsRef.current.delete(focusKey);
      sceneFocusedLayoutsRef.current.delete(focusKey);
      if (snapshot) {
        restorePreFocusSnapshot(
          activeDocumentId,
          snapshot,
          dockviewApisRef.current,
        );
      }
      setFocusedLayoutIds((current) => {
        const next = new Set(current);
        next.delete(focusKey);
        return next;
      });
      return;
    }

    const settings = await settingsStore.load();
    if (preFocusLayoutsRef.current.has(focusKey) || activeDockApi() !== api) {
      return;
    }
    const dock = api;
    const indexed = projectService.registry?.getByPath(doc.ref.path);
    const parentOf = registryClassParentLookup(projectService.registry);
    const animMode =
      doc.ref.kind === "anim-graph"
        ? animEditorModeForDocument(activeDocumentId, animEditorModesRef.current, doc)
        : undefined;
    const dockOptions = dockOptionsForIndexed(
      doc.ref.kind,
      indexed,
      parentOf,
      sourceControlRef.current.enabled,
      animMode,
      sceneMode,
    );

    preFocusLayoutsRef.current.set(focusKey, {
      layout: dock.toJSON() as unknown as Record<string, unknown>,
      surface: sceneMode ?? (animMode ? dockviewSurfaceForAnimMode(animMode) : "default"),
    });
    applyFocusLayout(
      doc.ref.kind,
      dock,
      focusKeepPanelIds(settings, doc.ref.kind, dockOptions),
      dockOptions,
    );
    setFocusedLayoutIds((current) => {
      const next = new Set(current);
      next.add(focusKey);
      return next;
    });
  }, [activeDockApi, documentService, projectService, settingsStore, sourceControlRef]);

  return {
    animEditorModes,
    setAnimEditorModes,
    focusedLayoutIds,
    dockWindowTick,
    disposeDockSubscriptions,
    captureLayoutForId,
    captureAllLayouts,
    resetDockLayouts,
    moveDockLayouts,
    forgetDockLayouts,
    registerDockviewApi,
    unregisterDockviewApi,
    setAnimEditorMode,
    setSceneMode,
    activateDockPanel,
    toggleDockWindow,
    isDockWindowOpen,
    getOpenDockWindowCount,
    toggleLayoutFocus,
  };
}
