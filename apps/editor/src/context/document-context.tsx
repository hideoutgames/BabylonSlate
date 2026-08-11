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
} from "@babylonslate/assets";
import { createStorage, MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  DocumentService,
  type OpenDocument,
} from "../services/document-service";
import { ProjectService } from "../services/project-service";

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
  openProject: () => Promise<void>;
  createEmptyProject: () => Promise<void>;
  openListedProject: (handle: ProjectFolderHandle) => Promise<void>;
  reconnectProject: () => Promise<void>;
  saveProject: () => Promise<void>;
  saveAll: () => Promise<void>;
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
  const derivedStorage = useMemo(() => new MemoryStorageAdapter("documents"), []);
  const documentServiceRef = useRef(new DocumentService());
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
  const [registryVersion, setRegistryVersion] = useState(0);

  const bump = useCallback(() => setRegistryVersion((v) => v + 1), []);
  const documentService = documentServiceRef.current;

  const refreshProjectList = useCallback(async () => {
    setListedProjects(await projectService.listProjects());
    setNeedsReconnect(await projectService.needsReconnect());
  }, [projectService]);

  useEffect(() => {
    documentService.ensureContentBrowserTab();
    void refreshProjectList();
    bump();
  }, [bump, documentService, refreshProjectList]);

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
    async (document: ProjectDocument, layouts: Awaited<
      ReturnType<ProjectService["loadCurrentProject"]>
    >["layouts"]) => {
      dockviewApisRef.current.clear();
      await documentService.initializeFromProject(
        projectService,
        document,
        layouts,
      );
      setProjectDocument(document);
      setRoute("editor");
      const guid = projectService.guid;
      if (guid) {
        await derivedStorage.openDocumentsProject("derived");
        setRecoveryAvailable(await hasJournal(derivedStorage, guid));
      }
      await refreshProjectList();
      bump();
    },
    [
      bump,
      derivedStorage,
      documentService,
      projectService,
      refreshProjectList,
    ],
  );

  const openProject = useCallback(async () => {
    const { document, layouts } = await projectService.openProject();
    await enterEditor(document, layouts);
  }, [enterEditor, projectService]);

  const createEmptyProject = useCallback(async () => {
    const { document, layouts } = await projectService.createEmptyProject();
    await enterEditor(document, layouts);
  }, [enterEditor, projectService]);

  const openListedProject = useCallback(
    async (handle: ProjectFolderHandle) => {
      const { document, layouts } =
        await projectService.openListedProject(handle);
      await enterEditor(document, layouts);
    },
    [enterEditor, projectService],
  );

  const reconnectProject = useCallback(async () => {
    const { document, layouts } = await projectService.reconnect();
    await enterEditor(document, layouts);
  }, [enterEditor, projectService]);

  const saveProject = useCallback(async () => {
    if (!projectDocument) return;
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
    bump();
  }, [bump, captureAllLayouts, documentService, projectDocument, projectService]);

  const saveAll = saveProject;

  const forceCloseProject = useCallback(async () => {
    const guid = projectService.guid;
    if (guid) {
      await derivedStorage.openDocumentsProject("derived");
      await truncateJournal(derivedStorage, guid);
    }
    await projectService.closeProject();
    dockviewApisRef.current.clear();
    documentService.ensureContentBrowserTab();
    setProjectDocument(null);
    setRecoveryAvailable(false);
    setRoute("home");
    await refreshProjectList();
    bump();
  }, [
    bump,
    derivedStorage,
    documentService,
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
      await derivedStorage.openDocumentsProject("derived");
      await truncateJournal(derivedStorage, guid);
    }
    setRecoveryAvailable(false);
  }, [derivedStorage, projectService]);

  const keepRecovery = useCallback(() => {
    const guid = projectService.guid;
    if (guid) {
      void derivedStorage.openDocumentsProject("derived").then(() =>
        writeJournalStub(derivedStorage, guid, ["pending-p2-replay"]),
      );
    }
    setRecoveryAvailable(false);
  }, [derivedStorage, projectService]);

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
    () => ({
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
      openProject,
      createEmptyProject,
      openListedProject,
      reconnectProject,
      saveProject,
      saveAll,
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
      registerDockviewApi,
      captureActiveLayout,
      getAvailableDocuments,
    }),
    [
      registryVersion,
      route,
      projectDocument,
      documentService,
      listedProjects,
      needsReconnect,
      recoveryAvailable,
      openProject,
      createEmptyProject,
      openListedProject,
      reconnectProject,
      saveProject,
      saveAll,
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
      registerDockviewApi,
      captureActiveLayout,
      getAvailableDocuments,
    ],
  );

  return (
    <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>
  );
}

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
