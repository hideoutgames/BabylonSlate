import type {
  DocumentRef,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/shared";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
  documentId,
  isContentBrowserId,
  labelFromPath,
} from "@babylonslate/shared";
import type { ProjectDocument } from "@babylonslate/shared";
import type { ProjectService } from "./project-service";

export interface OpenDocument {
  id: string;
  ref: DocumentRef;
  content: SerializedScene | SerializedGraph | null;
  layout: Record<string, unknown> | null;
  dirty: boolean;
}

export interface DocumentRegistryState {
  openDocuments: Map<string, OpenDocument>;
  tabOrder: string[];
  activeDocumentId: string | null;
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

  getClosableDocumentsOrdered(): OpenDocument[] {
    return this.getOpenDocumentsOrdered().filter(
      (doc) => doc.ref.kind !== "content-browser",
    );
  }

  getDocument(id: string): OpenDocument | undefined {
    return this.state.openDocuments.get(id);
  }

  getActiveDocument(): OpenDocument | undefined {
    if (!this.state.activeDocumentId) return undefined;
    return this.state.openDocuments.get(this.state.activeDocumentId);
  }

  ensureContentBrowserTab(): void {
    if (this.state.openDocuments.has(CONTENT_BROWSER_ID)) {
      this.pinContentBrowserFirst();
      return;
    }

    const entry: OpenDocument = {
      id: CONTENT_BROWSER_ID,
      ref: CONTENT_BROWSER_REF,
      content: null,
      layout: null,
      dirty: false,
    };

    this.state.openDocuments.set(CONTENT_BROWSER_ID, entry);
    this.state.tabOrder.unshift(CONTENT_BROWSER_ID);
    if (!this.state.activeDocumentId) {
      this.state.activeDocumentId = CONTENT_BROWSER_ID;
    }
  }

  private pinContentBrowserFirst(): void {
    this.state.tabOrder = [
      CONTENT_BROWSER_ID,
      ...this.state.tabOrder.filter((id) => id !== CONTENT_BROWSER_ID),
    ];
  }

  async initializeFromProject(
    projectService: ProjectService,
    _document: ProjectDocument,
    layouts: ProjectLayouts,
  ): Promise<void> {
    this.state = {
      openDocuments: new Map(),
      tabOrder: [],
      activeDocumentId: null,
    };

    this.ensureContentBrowserTab();

    const savedOrder = layouts.tabOrder.filter(
      (id) => !isContentBrowserId(id) && id.includes(":"),
    );

    for (const id of savedOrder) {
      const colonIndex = id.indexOf(":");
      const kind = id.slice(0, colonIndex);
      const path = id.slice(colonIndex + 1);
      if (kind !== "scene" && kind !== "graph") continue;
      await this.openDocument(
        projectService,
        { kind, path, label: labelFromPath(path) },
        layouts.documents[id] ?? null,
        false,
      );
    }

    this.pinContentBrowserFirst();

    // Always land on the Content Browser when opening a project so users
    // don't get dropped into an empty black viewport tab.
    this.state.activeDocumentId = CONTENT_BROWSER_ID;
  }

  async openDocument(
    projectService: ProjectService,
    ref: DocumentRef,
    layout: Record<string, unknown> | null = null,
    setActive = true,
  ): Promise<string> {
    if (ref.kind === "content-browser") {
      this.ensureContentBrowserTab();
      if (setActive) {
        this.state.activeDocumentId = CONTENT_BROWSER_ID;
      }
      return CONTENT_BROWSER_ID;
    }

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
    this.pinContentBrowserFirst();
    if (setActive) {
      this.state.activeDocumentId = id;
    }
    return id;
  }

  closeDocument(id: string): void {
    if (isContentBrowserId(id)) {
      return;
    }

    this.state.openDocuments.delete(id);
    this.state.tabOrder = this.state.tabOrder.filter((tabId) => tabId !== id);
    if (this.state.activeDocumentId === id) {
      this.state.activeDocumentId = this.state.tabOrder[0] ?? CONTENT_BROWSER_ID;
    }
    this.pinContentBrowserFirst();
  }

  setActiveDocument(id: string): void {
    if (this.state.openDocuments.has(id)) {
      this.state.activeDocumentId = id;
    }
  }

  reorderClosableTabs(fromClosableIndex: number, toClosableIndex: number): void {
    const fromIndex = fromClosableIndex + 1;
    const toIndex = toClosableIndex + 1;
    this.reorderTabs(fromIndex, toIndex);
  }

  reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex < 1 || toIndex < 1) {
      return;
    }

    if (
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
    this.pinContentBrowserFirst();
  }

  updateScene(id: string, scene: SerializedScene): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || doc.ref.kind !== "scene") return;
    doc.content = scene;
    doc.dirty = true;
    doc.ref = { ...doc.ref, label: `${scene.name} Scene` };
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
      if (doc.ref.kind !== "content-browser") {
        doc.dirty = false;
      }
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
      activeDocumentId: this.state.activeDocumentId,
    };
  }

  getDirtyDocuments(): OpenDocument[] {
    return [...this.state.openDocuments.values()].filter(
      (doc) => doc.dirty && doc.ref.kind !== "content-browser",
    );
  }
}
