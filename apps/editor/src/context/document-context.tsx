import type { DockviewApi } from "dockview-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SerializedGraph, SerializedScene } from "@babylonslate/core";
import type {
  DocumentRef,
  ProjectDocument,
  ProjectFolderHandle,
} from "@babylonslate/core";
import { documentId } from "@babylonslate/core";
import {
  hasJournal,
  truncateJournal,
  writeJournalStub,
  type MigrationPending,
  type ProjectTemplate,
} from "@babylonslate/assets";
import { diffGraphCommands, EditSession } from "@babylonslate/edit";
import {
  createAppSettingsStore,
  createDerivedStorage,
  createStorage,
  createTemplateStorage,
  defaultEngineSettings,
  getHostPlatform,
} from "@babylonslate/vfs";
import type { ProjectStorage } from "@babylonslate/core";
import {
  DocumentService,
  type OpenDocument,
} from "../services/document-service";
import { EditService } from "../services/edit-service";
import { ProjectService } from "../services/project-service";
import { loadTemplateCards } from "../services/template-service";
import { EditServiceProvider } from "./edit-context";

export type AppRoute = "home" | "editor";

interface DocumentContextValue {
  route: AppRoute;
  projectDocument: ProjectDocument | null;
  projectName: string | null;
  openDocuments: OpenDocument[];
  tabOrder: string[];
  activeDocumentId: string | null;
  listedProjects: ProjectFolderHandle[];
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  dirtyDocuments: OpenDocument[];
  migrationPending: MigrationPending[];
  templates: ProjectTemplate[];
  refreshTemplates: () => Promise<void>;
  openProject: () => Promise<void>;
  createEmptyProject: () => Promise<void>;
  createFromTemplate: (templateId: string, name: string) => Promise<void>;
  openListedProject: (handle: ProjectFolderHandle) => Promise<void>;
  reconnectProject: () => Promise<void>;
  saveProject: () => Promise<void>;
  saveAll: () => Promise<void>;
  approveMigrationsAndSave: () => Promise<void>;
  closeProject: () => Promise<{ blocked: boolean; dirty: OpenDocument[] }>;
  forceCloseProject: () => Promise<void>;
  refreshProjectList: () => Promise<void>;
  exportProject: () => Promise<Uint8Array>;
  dismissRecovery: () => Promise<void>;
  keepRecovery: () => void;
  openDocument: (ref: DocumentRef) => Promise<void>;
  closeDocument: (id: string) => void;
  setActiveDocument: (id: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  reorderClosableTabs: (fromIndex: number, toIndex: number) => void;
  updateScene: (id: string, scene: SerializedScene) => void;
  updateGraph: (id: string, graph: SerializedGraph) => void;
  /** Apply a graph edit through the command layer (marks dirty + undoable). */
  applyGraphChange: (id: string, next: SerializedGraph) => void;
  undoActiveDocument: () => void;
  redoActiveDocument: () => void;
  canUndoActiveDocument: boolean;
  canRedoActiveDocument: boolean;
  registerDockviewApi: (id: string, api: DockviewApi) => void;
  captureActiveLayout: () => void;
  getAvailableDocuments: () => Array<{
    kind: "scene" | "graph";
    path: string;
    label: string;
  }>;
}

const DocumentContext = createContext<DocumentContextValue | null>(null);

export function DocumentProvider({ children }: { children: ReactNode }) {
  const projectStorage = useMemo(() => createStorage(), []);
  const projectService = useMemo(
    () => new ProjectService(projectStorage),
    [projectStorage],
  );
  const settingsStore = useMemo(() => createAppSettingsStore(), []);
  const derivedStorageRef = useRef<ProjectStorage | null>(null);
  const documentServiceRef = useRef(new DocumentService());
  const editSessionRef = useRef(new EditSession());
  const dockviewApisRef = useRef(new Map<string, DockviewApi>());

  const [route, setRoute] = useState<AppRoute>("home");
  const [projectDocument, setProjectDocument] = useState<ProjectDocument | null>(
    null,
  );
  const [listedProjects, setListedProjects] = useState<ProjectFolderHandle[]>(
    [],
  );
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [migrationPending, setMigrationPending] = useState<MigrationPending[]>(
    [],
  );
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [registryVersion, setRegistryVersion] = useState(0);

  const bump = useCallback(() => setRegistryVersion((v) => v + 1), []);
  const documentService = documentServiceRef.current;

  const ensureDerived = useCallback(async () => {
    if (!derivedStorageRef.current) {
      derivedStorageRef.current = await createDerivedStorage();
    }
    return derivedStorageRef.current;
  }, []);

  const recordRecent = useCallback(
    async (handle: ProjectFolderHandle | null) => {
      if (!handle) return;
      const settings = await settingsStore.load();
      const next = defaultEngineSettings();
      Object.assign(next, settings);
      next.recents = [
        {
          id: handle.id,
          name: handle.name,
          tier: handle.tier,
          lastOpenedAt: new Date().toISOString(),
          bookmark: handle.tier === "external" ? handle.id : null,
        },
        ...settings.recents.filter((r) => r.id !== handle.id),
      ].slice(0, 20);
      await settingsStore.save(next);
    },
    [settingsStore],
  );

  const refreshProjectList = useCallback(async () => {
    const fromStorage = await projectService.listProjects();
    const settings = await settingsStore.load();
    // Merge recents that may not appear in listProjects yet (external bookmarks).
    const byId = new Map(fromStorage.map((p) => [p.id, p]));
    for (const recent of settings.recents) {
      if (!byId.has(recent.id)) {
        byId.set(recent.id, {
          id: recent.id,
          name: recent.name,
          tier: recent.tier,
        });
      }
    }
    setListedProjects([...byId.values()]);
    setNeedsReconnect(await projectService.needsReconnect());
  }, [projectService, settingsStore]);

  const refreshTemplates = useCallback(async () => {
    setTemplates(
      await loadTemplateCards({
        platform: getHostPlatform(),
        loadSettings: () => settingsStore.load(),
        openTemplatesFolder: createTemplateStorage,
      }),
    );
  }, [settingsStore]);

  useEffect(() => {
    documentService.ensureContentBrowserTab();
    void refreshProjectList();
    void refreshTemplates();
    bump();
  }, [bump, documentService, refreshProjectList, refreshTemplates]);

  const captureLayoutForId = useCallback(
    (id: string) => {
      const api = dockviewApisRef.current.get(id);
      if (api) {
        documentService.setLayout(id, projectService.captureLayout(api));
      }
    },
    [documentService, projectService],
  );

  const captureAllLayouts = useCallback(() => {
    const { tabOrder } = documentService.getState();
    for (const id of tabOrder) {
      captureLayoutForId(id);
    }
  }, [captureLayoutForId, documentService]);

  const enterEditor = useCallback(
    async (
      document: ProjectDocument,
      layouts: Awaited<
        ReturnType<ProjectService["loadCurrentProject"]>
      >["layouts"],
      pending: MigrationPending[] = [],
    ) => {
      dockviewApisRef.current.clear();
      await documentService.initializeFromProject(
        projectService,
        document,
        layouts,
      );
      setProjectDocument(document);
      setMigrationPending(pending);
      setRoute("editor");
      const guid = projectService.guid;
      if (guid) {
        const derived = await ensureDerived();
        setRecoveryAvailable(await hasJournal(derived, guid));
      }
      await recordRecent(projectService.storagePort.getCurrentFolder());
      await refreshProjectList();
      bump();
    },
    [
      bump,
      documentService,
      ensureDerived,
      projectService,
      recordRecent,
      refreshProjectList,
    ],
  );

  const openProject = useCallback(async () => {
    const { document, layouts, migrationPending: pending } =
      await projectService.openProject();
    await enterEditor(document, layouts, pending);
  }, [enterEditor, projectService]);

  const createEmptyProject = useCallback(async () => {
    const { document, layouts, migrationPending: pending } =
      await projectService.createEmptyProject();
    await enterEditor(document, layouts, pending);
  }, [enterEditor, projectService]);

  const createFromTemplate = useCallback(
    async (templateId: string, name: string) => {
      const template = templates.find((t) => t.id === templateId);
      if (!template) {
        throw new Error(`Unknown template: ${templateId}`);
      }
      const { document, layouts, migrationPending: pending } =
        await projectService.createFromTemplate({
          templateFiles: template.files,
          name,
        });
      await enterEditor(document, layouts, pending);
    },
    [enterEditor, projectService, templates],
  );

  const openListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      const { document, layouts, migrationPending: pending } =
        await projectService.openListedProject(handle);
      await enterEditor(document, layouts, pending);
    },
    [enterEditor, projectService],
  );

  const reconnectProject = useCallback(async () => {
    const { document, layouts, migrationPending: pending } =
      await projectService.reconnect();
    await enterEditor(document, layouts, pending);
  }, [enterEditor, projectService]);

  const saveProject = useCallback(async () => {
    if (!projectDocument) return;
    if (projectService.pendingMigrations.length > 0) {
      setMigrationPending(projectService.pendingMigrations);
      // Caller must use approveMigrationsAndSave — never silently rewrite.
      return;
    }
    captureAllLayouts();
    const dirtyDocs = documentService.getDirtyDocuments();
    for (const doc of dirtyDocs) {
      if (doc.ref.kind === "scene" || doc.ref.kind === "graph") {
        await projectService.saveDocument(
          doc.ref.kind,
          doc.ref.path,
          doc.content as SerializedScene | SerializedGraph,
        );
      }
    }
    const layouts = documentService.buildLayouts();
    await projectService.saveProject(projectDocument, layouts);
    documentService.markAllClean();
    setMigrationPending([]);
    bump();
  }, [bump, captureAllLayouts, documentService, projectDocument, projectService]);

  const approveMigrationsAndSave = useCallback(async () => {
    if (!projectDocument) return;
    projectService.approveMigrateOnSave();
    captureAllLayouts();
    const dirtyDocs = documentService.getDirtyDocuments();
    for (const doc of dirtyDocs) {
      if (doc.ref.kind === "scene" || doc.ref.kind === "graph") {
        await projectService.saveDocument(
          doc.ref.kind,
          doc.ref.path,
          doc.content as SerializedScene | SerializedGraph,
        );
      }
    }
    const layouts = documentService.buildLayouts();
    await projectService.saveProject(projectDocument, layouts);
    documentService.markAllClean();
    setMigrationPending([]);
    bump();
  }, [bump, captureAllLayouts, documentService, projectDocument, projectService]);

  const saveAll = saveProject;

  const forceCloseProject = useCallback(async () => {
    const guid = projectService.guid;
    if (guid) {
      const derived = await ensureDerived();
      await truncateJournal(derived, guid);
    }
    await projectService.closeProject();
    dockviewApisRef.current.clear();
    editSessionRef.current.clear();
    documentService.ensureContentBrowserTab();
    setProjectDocument(null);
    setRecoveryAvailable(false);
    setMigrationPending([]);
    setRoute("home");
    await refreshProjectList();
    bump();
  }, [
    bump,
    documentService,
    ensureDerived,
    projectService,
    refreshProjectList,
  ]);

  const closeProject = useCallback(async () => {
    const dirty = documentService.getDirtyDocuments();
    if (dirty.length > 0) {
      return { blocked: true, dirty };
    }
    await forceCloseProject();
    return { blocked: false, dirty: [] };
  }, [documentService, forceCloseProject]);

  const exportProject = useCallback(async () => {
    return projectService.exportZip();
  }, [projectService]);

  const dismissRecovery = useCallback(async () => {
    const guid = projectService.guid;
    if (guid) {
      const derived = await ensureDerived();
      await truncateJournal(derived, guid);
    }
    setRecoveryAvailable(false);
  }, [ensureDerived, projectService]);

  const keepRecovery = useCallback(() => {
    const guid = projectService.guid;
    if (guid) {
      void ensureDerived().then((derived) =>
        writeJournalStub(derived, guid, ["pending-p2-replay"]),
      );
    }
    setRecoveryAvailable(false);
  }, [ensureDerived, projectService]);

  const openDocument = useCallback(
    async (ref: DocumentRef) => {
      const { activeDocumentId } = documentService.getState();
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      const layouts = documentService.buildLayouts();
      const layout = layouts.documents[documentId(ref)] ?? null;
      await documentService.openDocument(projectService, ref, layout, true);
      bump();
    },
    [bump, captureLayoutForId, documentService, projectService],
  );

  const closeDocument = useCallback(
    (id: string) => {
      dockviewApisRef.current.delete(id);
      documentService.closeDocument(id);
      editSessionRef.current.dropDocument(id);
      bump();
    },
    [bump, documentService],
  );

  const setActiveDocument = useCallback(
    (id: string) => {
      const { activeDocumentId } = documentService.getState();
      if (id === activeDocumentId) return;
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      documentService.setActiveDocument(id);
      bump();
    },
    [bump, captureLayoutForId, documentService],
  );

  const reorderClosableTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      documentService.reorderClosableTabs(fromIndex, toIndex);
      bump();
    },
    [bump, documentService],
  );

  const reorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      documentService.reorderTabs(fromIndex, toIndex);
      bump();
    },
    [bump, documentService],
  );

  const updateScene = useCallback(
    (id: string, scene: SerializedScene) => {
      documentService.updateScene(id, scene);
      bump();
    },
    [bump, documentService],
  );

  const updateGraph = useCallback(
    (id: string, graph: SerializedGraph) => {
      documentService.updateGraph(id, graph);
      bump();
    },
    [bump, documentService],
  );

  const applyGraphChange = useCallback(
    (id: string, next: SerializedGraph) => {
      const doc = documentService.getState().openDocuments.get(id);
      if (!doc || doc.ref.kind !== "graph" || !doc.content) return;
      const previous = doc.content as SerializedGraph;
      const commands = diffGraphCommands(previous, next);
      if (commands.length === 0) {
        documentService.updateGraph(id, next);
        bump();
        return;
      }
      void settingsStore.load().then((settings) => {
        editSessionRef.current.configure({
          maxEntries: settings.undoHistoryLength,
        });
      });
      let current = previous;
      for (const command of commands) {
        current = editSessionRef.current.apply(id, current, command).doc;
      }
      documentService.updateGraph(id, current);
      bump();
    },
    [bump, documentService, settingsStore],
  );

  const undoActiveDocument = useCallback(() => {
    const { activeDocumentId, openDocuments } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = openDocuments.get(activeDocumentId);
    if (!doc || doc.ref.kind !== "graph" || !doc.content) return;
    const stack =
      editSessionRef.current.getStack<SerializedGraph>(activeDocumentId);
    const result = stack.undo(doc.content as SerializedGraph);
    if (!result) return;
    documentService.updateGraph(activeDocumentId, result.doc);
    bump();
  }, [bump, documentService]);

  const redoActiveDocument = useCallback(() => {
    const { activeDocumentId, openDocuments } = documentService.getState();
    if (!activeDocumentId) return;
    const doc = openDocuments.get(activeDocumentId);
    if (!doc || doc.ref.kind !== "graph" || !doc.content) return;
    const stack =
      editSessionRef.current.getStack<SerializedGraph>(activeDocumentId);
    const result = stack.redo(doc.content as SerializedGraph);
    if (!result) return;
    documentService.updateGraph(activeDocumentId, result.doc);
    bump();
  }, [bump, documentService]);

  const registerDockviewApi = useCallback((id: string, api: DockviewApi) => {
    dockviewApisRef.current.set(id, api);
  }, []);

  const captureActiveLayout = useCallback(() => {
    const { activeDocumentId } = documentService.getState();
    if (activeDocumentId) {
      captureLayoutForId(activeDocumentId);
    }
  }, [captureLayoutForId, documentService]);

  const getAvailableDocuments = useCallback(() => {
    if (!projectDocument) return [];
    const { tabOrder } = documentService.getState();
    const openIds = new Set(tabOrder);
    const available: Array<{
      kind: "scene" | "graph";
      path: string;
      label: string;
    }> = [];

    for (const path of projectDocument.scenes) {
      const id = documentId({ kind: "scene", path });
      if (!openIds.has(id)) {
        available.push({
          kind: "scene",
          path,
          label: path.split("/").pop() ?? path,
        });
      }
    }
    for (const path of projectDocument.graphs) {
      const id = documentId({ kind: "graph", path });
      if (!openIds.has(id)) {
        available.push({
          kind: "graph",
          path,
          label: path.split("/").pop() ?? path,
        });
      }
    }
    return available;
  }, [documentService, projectDocument]);

  const value = useMemo<DocumentContextValue>(
    () => {
      // registryVersion is a bump counter for imperative document-service
      // mutations that are not themselves React state.
      void registryVersion;
      return {
      route,
      projectDocument,
      projectName: projectDocument?.metadata.name ?? null,
      openDocuments: documentService.getOpenDocumentsOrdered(),
      tabOrder: [...documentService.getState().tabOrder],
      activeDocumentId: documentService.getState().activeDocumentId,
      listedProjects,
      needsReconnect,
      recoveryAvailable,
      dirtyDocuments: documentService.getDirtyDocuments(),
      migrationPending,
      templates,
      refreshTemplates,
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      reconnectProject,
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      closeProject,
      forceCloseProject,
      refreshProjectList,
      exportProject,
      dismissRecovery,
      keepRecovery,
      openDocument,
      closeDocument,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
      updateScene,
      updateGraph,
      applyGraphChange,
      undoActiveDocument,
      redoActiveDocument,
      canUndoActiveDocument: (() => {
        const activeId = documentService.getState().activeDocumentId;
        return activeId
          ? editSessionRef.current.getStack(activeId).canUndo
          : false;
      })(),
      canRedoActiveDocument: (() => {
        const activeId = documentService.getState().activeDocumentId;
        return activeId
          ? editSessionRef.current.getStack(activeId).canRedo
          : false;
      })(),
      registerDockviewApi,
      captureActiveLayout,
      getAvailableDocuments,
    };
    },
    [
      registryVersion,
      route,
      projectDocument,
      documentService,
      listedProjects,
      needsReconnect,
      recoveryAvailable,
      migrationPending,
      templates,
      refreshTemplates,
      openProject,
      createEmptyProject,
      createFromTemplate,
      openListedProject,
      reconnectProject,
      saveProject,
      saveAll,
      approveMigrationsAndSave,
      closeProject,
      forceCloseProject,
      refreshProjectList,
      exportProject,
      dismissRecovery,
      keepRecovery,
      openDocument,
      closeDocument,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
      updateScene,
      updateGraph,
      applyGraphChange,
      undoActiveDocument,
      redoActiveDocument,
      registerDockviewApi,
      captureActiveLayout,
      getAvailableDocuments,
    ],
  );

  return (
    <EditServiceProvider editService={editServiceRef.current}>
      <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>
    </EditServiceProvider>
  );
}

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export function useDocuments(): DocumentContextValue {
  const context = useContext(DocumentContext);
  if (!context) {
    throw new Error("useDocuments must be used within DocumentProvider");
  }
  return context;
}

/** @deprecated Use useDocuments instead */
export function useProject(): DocumentContextValue {
  return useDocuments();
}

/** @deprecated Use DocumentProvider instead */
export const ProjectProvider = DocumentProvider;
/* eslint-enable react-refresh/only-export-components */
