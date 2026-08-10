import type {
  DocumentKind,
  DocumentRef,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/shared";
import {
  documentId,
  labelFromPath,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
} from "@babylonslate/shared";
import type { ProjectDocument } from "@babylonslate/shared";
import type { ProjectService } from "./project-service";

export interface OpenDocument {
  id: string;
  ref: DocumentRef;
  content: SerializedScene | SerializedGraph;
  layout: Record<string, unknown> | null;
  dirty: boolean;
}

export interface DocumentRegistryState {
  openDocuments: Map<string, OpenDocument>;
  tabOrder: string[];
  activeDocumentId: string | null;
}

export function createDocumentRef(
  kind: DocumentKind,
  path: string,
  content?: SerializedScene | SerializedGraph,
): DocumentRef {
  const baseLabel =
    kind === "scene" && content && "name" in content
      ? content.name
      : labelFromPath(path);
  const label = kind === "scene" ? `${baseLabel} Scene` : `${baseLabel} Graph`;
  return { kind, path, label };
}

export class DocumentService {
  private state: DocumentRegistryState = {
    openDocuments: new Map(),
    tabOrder: [],
    activeDocumentId: null,
  };

  getState(): DocumentRegistryState {
    return this.state;
  }

  getOpenDocumentsOrdered(): OpenDocument[] {
    return this.state.tabOrder
      .map((id) => this.state.openDocuments.get(id))
      .filter((doc): doc is OpenDocument => doc !== undefined);
  }

  getDocument(id: string): OpenDocument | undefined {
    return this.state.openDocuments.get(id);
  }

  getActiveDocument(): OpenDocument | undefined {
    if (!this.state.activeDocumentId) return undefined;
    return this.state.openDocuments.get(this.state.activeDocumentId);
  }

  async initializeFromProject(
    projectService: ProjectService,
    document: ProjectDocument,
    layouts: ProjectLayouts,
  ): Promise<void> {
    this.state = {
      openDocuments: new Map(),
      tabOrder: [],
      activeDocumentId: null,
    };

    const savedOrder =
      layouts.tabOrder.length > 0
        ? layouts.tabOrder
        : [
            documentId({ kind: "scene", path: document.scenes[0] ?? MAIN_SCENE_FILE }),
            documentId({ kind: "graph", path: document.graphs[0] ?? MAIN_GRAPH_FILE }),
          ];

    for (const id of savedOrder) {
      const [kind, ...pathParts] = id.split(":");
      if (kind !== "scene" && kind !== "graph") continue;
      const path = pathParts.join(":");
      await this.openDocument(
        projectService,
        { kind, path, label: labelFromPath(path) },
        layouts.documents[id] ?? null,
        false,
      );
    }

    if (this.state.tabOrder.length === 0) {
      const scenePath = document.scenes[0] ?? MAIN_SCENE_FILE;
      const graphPath = document.graphs[0] ?? MAIN_GRAPH_FILE;
      await this.openDocument(
        projectService,
        { kind: "scene", path: scenePath, label: labelFromPath(scenePath) },
        layouts.documents[documentId({ kind: "scene", path: scenePath })] ?? null,
        false,
      );
      await this.openDocument(
        projectService,
        { kind: "graph", path: graphPath, label: labelFromPath(graphPath) },
        layouts.documents[documentId({ kind: "graph", path: graphPath })] ?? null,
        false,
      );
    }

    const sceneTab = this.state.tabOrder.find((id) => id.startsWith("scene:"));
    this.state.activeDocumentId =
      sceneTab ?? this.state.tabOrder[0] ?? null;
  }

  async openDocument(
    projectService: ProjectService,
    ref: DocumentRef,
    layout: Record<string, unknown> | null = null,
    setActive = true,
  ): Promise<string> {
    const id = documentId(ref);
    const existing = this.state.openDocuments.get(id);
    if (existing) {
      if (setActive) {
        this.state.activeDocumentId = id;
      }
      return id;
    }

    const content = await projectService.loadDocument(ref.kind, ref.path);
    const fullRef = createDocumentRef(ref.kind, ref.path, content);

    const entry: OpenDocument = {
      id,
      ref: fullRef,
      content,
      layout,
      dirty: false,
    };

    this.state.openDocuments.set(id, entry);
    this.state.tabOrder.push(id);
    if (setActive) {
      this.state.activeDocumentId = id;
    }
    return id;
  }

  closeDocument(id: string): void {
    this.state.openDocuments.delete(id);
    this.state.tabOrder = this.state.tabOrder.filter((tabId) => tabId !== id);
    if (this.state.activeDocumentId === id) {
      this.state.activeDocumentId = this.state.tabOrder[0] ?? null;
    }
  }

  setActiveDocument(id: string): void {
    if (this.state.openDocuments.has(id)) {
      this.state.activeDocumentId = id;
    }
  }

  reorderTabs(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= this.state.tabOrder.length ||
      toIndex >= this.state.tabOrder.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    const next = [...this.state.tabOrder];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    this.state.tabOrder = next;
  }

  updateScene(id: string, scene: SerializedScene): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || doc.ref.kind !== "scene") return;
    doc.content = scene;
    doc.dirty = true;
    doc.ref = { ...doc.ref, label: scene.name };
  }

  updateGraph(id: string, graph: SerializedGraph): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || doc.ref.kind !== "graph") return;
    doc.content = graph;
    doc.dirty = true;
  }

  setLayout(id: string, layout: Record<string, unknown> | null): void {
    const doc = this.state.openDocuments.get(id);
    if (doc) {
      doc.layout = layout;
    }
  }

  markAllClean(): void {
    for (const doc of this.state.openDocuments.values()) {
      doc.dirty = false;
    }
  }

  buildLayouts(): ProjectLayouts {
    const documents: Record<string, Record<string, unknown>> = {};
    for (const [id, doc] of this.state.openDocuments) {
      if (doc.layout) {
        documents[id] = doc.layout;
      }
    }
    return {
      documents,
      tabOrder: [...this.state.tabOrder],
    };
  }

  getDirtyDocuments(): OpenDocument[] {
    return [...this.state.openDocuments.values()].filter((doc) => doc.dirty);
  }
}
