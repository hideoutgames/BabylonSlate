import type { DockviewApi } from "dockview";
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
import type { SerializedGraph, SerializedScene } from "@babylonslate/shared";
import type { DocumentRef, ProjectDocument } from "@babylonslate/shared";
import { documentId } from "@babylonslate/shared";
import { createStorage } from "@babylonslate/storage";
import {
  DocumentService,
  type OpenDocument,
} from "../services/document-service";
import { ProjectService } from "../services/project-service";

interface DocumentContextValue {
  projectDocument: ProjectDocument | null;
  projectName: string | null;
  openDocuments: OpenDocument[];
  tabOrder: string[];
  activeDocumentId: string | null;
  openProject: () => Promise<void>;
  saveProject: () => Promise<void>;
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
  const projectService = useMemo(
    () => new ProjectService(createStorage()),
    [],
  );
  const documentServiceRef = useRef(new DocumentService());
  const dockviewApisRef = useRef(new Map<string, DockviewApi>());

  const [projectDocument, setProjectDocument] = useState<ProjectDocument | null>(
    null,
  );
  const [registryVersion, setRegistryVersion] = useState(0);

  const bump = useCallback(() => setRegistryVersion((v) => v + 1), []);

  const documentService = documentServiceRef.current;

  useEffect(() => {
    documentService.ensureContentBrowserTab();
    bump();
  }, [bump, documentService]);

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

  const openProject = useCallback(async () => {
    const { document, layouts } = await projectService.openProject();
    dockviewApisRef.current.clear();
    await documentService.initializeFromProject(
      projectService,
      document,
      layouts,
    );
    setProjectDocument(document);
    bump();
  }, [bump, documentService, projectService]);

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
        available.push({ kind: "scene", path, label: path.split("/").pop() ?? path });
      }
    }
    for (const path of projectDocument.graphs) {
      const id = documentId({ kind: "graph", path });
      if (!openIds.has(id)) {
        available.push({ kind: "graph", path, label: path.split("/").pop() ?? path });
      }
    }
    return available;
  }, [documentService, projectDocument]);

  const value = useMemo<DocumentContextValue>(
    () => ({
      projectDocument,
      projectName: projectDocument?.metadata.name ?? null,
      openDocuments: documentService.getOpenDocumentsOrdered(),
      tabOrder: [...documentService.getState().tabOrder],
      activeDocumentId: documentService.getState().activeDocumentId,
      openProject,
      saveProject,
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
      projectDocument,
      documentService,
      openProject,
      saveProject,
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
