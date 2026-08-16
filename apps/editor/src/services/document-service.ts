import type {
  AssetDocumentKind,
  DocumentRef,
  PanelPlacement,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/core";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
  documentId,
  documentKindLabel,
  isAssetDocumentKind,
  isContentBrowserId,
  labelFromPath,
  parseDocumentId,
} from "@babylonslate/core";
import type { ProjectDocument } from "@babylonslate/core";
import type { ProjectService } from "./project-service";

export type DocumentContent =
  | SerializedScene
  | SerializedGraph
  | Record<string, unknown>;

export interface OpenDocument {
  id: string;
  ref: DocumentRef;
  content: DocumentContent | null;
  layout: Record<string, unknown> | null;
  dirty: boolean;
}

export interface DocumentRegistryState {
  openDocuments: Map<string, OpenDocument>;
  tabOrder: string[];
  activeDocumentId: string | null;
  panelPlacements: Record<string, Record<string, PanelPlacement>>;
  showPluginContent: boolean;
}

export class DocumentService {
  private state: DocumentRegistryState = {
    openDocuments: new Map(),
    tabOrder: [],
    activeDocumentId: null,
    panelPlacements: {},
    showPluginContent: false,
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
      panelPlacements: structuredClone(layouts.panelPlacements ?? {}),
      showPluginContent: layouts.showPluginContent === true,
    };

    this.ensureContentBrowserTab();

    const savedOrder = layouts.tabOrder.filter(
      (id) => !isContentBrowserId(id) && id.includes(":"),
    );
    const lastSceneId = [...savedOrder]
      .reverse()
      .find((id) => parseDocumentId(id)?.kind === "scene");

    for (const id of savedOrder) {
      const parsed = parseDocumentId(id);
      if (!parsed || !isAssetDocumentKind(parsed.kind)) continue;
      if (parsed.kind === "scene" && id !== lastSceneId) continue;
      await this.openDocument(
        projectService,
        { kind: parsed.kind, path: parsed.path, label: labelFromPath(parsed.path) },
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
      if (ref.kind === "scene") {
        this.closeOtherSceneDocuments(id);
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
    if (ref.kind === "scene") {
      this.closeOtherSceneDocuments(id);
    }
    if (setActive) {
      this.state.activeDocumentId = id;
    }
    return id;
  }

  private closeOtherSceneDocuments(keepId: string): void {
    const toClose: string[] = [];
    for (const [docId, doc] of this.state.openDocuments) {
      if (doc.ref.kind === "scene" && docId !== keepId) {
        toClose.push(docId);
      }
    }
    for (const docId of toClose) {
      this.closeDocument(docId);
    }
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

  /**
   * Retarget an open Scene/Graph tab after a registry move/rename.
   * Guids stay stable; only path-based document ids and layout keys change.
   */
  repathDocument(
    kind: AssetDocumentKind,
    oldPath: string,
    newPath: string,
  ): void {
    if (oldPath === newPath) return;
    const oldId = documentId({ kind, path: oldPath });
    const doc = this.state.openDocuments.get(oldId);
    if (!doc) return;
    const newId = documentId({ kind, path: newPath });
    this.state.openDocuments.delete(oldId);
    const next: OpenDocument = {
      ...doc,
      id: newId,
      ref: {
        ...doc.ref,
        path: newPath,
        label: labelFromPath(newPath),
      },
    };
    this.state.openDocuments.set(newId, next);
    this.state.tabOrder = this.state.tabOrder.map((id) =>
      id === oldId ? newId : id,
    );
    if (this.state.activeDocumentId === oldId) {
      this.state.activeDocumentId = newId;
    }
    const placements = this.state.panelPlacements[oldId];
    if (placements) {
      this.state.panelPlacements[newId] = placements;
      delete this.state.panelPlacements[oldId];
    }
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

  updateAssetDocument(id: string, content: Record<string, unknown>): void {
    const doc = this.state.openDocuments.get(id);
    if (
      !doc ||
      doc.ref.kind === "content-browser" ||
      doc.ref.kind === "scene" ||
      doc.ref.kind === "graph"
    ) {
      return;
    }
    doc.content = content;
    doc.dirty = true;
    if (typeof content.name === "string" && content.name.trim() !== "") {
      doc.ref = {
        ...doc.ref,
        label: `${content.name} ${documentKindLabel(doc.ref.kind)}`,
      };
    }
  }

  setLayout(id: string, layout: Record<string, unknown> | null): void {
    const doc = this.state.openDocuments.get(id);
    if (doc) {
      doc.layout = layout;
    }
  }

  setPanelPlacement(
    documentId: string,
    panelId: string,
    placement: PanelPlacement,
  ): void {
    const current = this.state.panelPlacements[documentId] ?? {};
    this.state.panelPlacements[documentId] = {
      ...current,
      [panelId]: placement,
    };
  }

  getPanelPlacements(
    documentId: string,
  ): Record<string, PanelPlacement> {
    return this.state.panelPlacements[documentId] ?? {};
  }

  replacePanelPlacements(
    documentId: string,
    placements: Record<string, PanelPlacement>,
  ): void {
    this.state.panelPlacements[documentId] = { ...placements };
  }

  markAllClean(): void {
    for (const doc of this.state.openDocuments.values()) {
      if (doc.ref.kind !== "content-browser") {
        doc.dirty = false;
      }
    }
  }

  replaceLoadedContent(id: string, content: DocumentContent): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || doc.ref.kind === "content-browser") return;
    doc.content = content;
    doc.dirty = false;
  }

  buildLayouts(): ProjectLayouts {
    const documents: Record<string, Record<string, unknown>> = {};
    for (const [id, doc] of this.state.openDocuments) {
      if (doc.layout) {
        documents[id] = doc.layout;
      }
    }
    const panelPlacements = Object.fromEntries(
      Object.entries(this.state.panelPlacements).filter(
        ([, placements]) => Object.keys(placements).length > 0,
      ),
    );
    return {
      documents,
      tabOrder: [...this.state.tabOrder],
      activeDocumentId: this.state.activeDocumentId,
      showPluginContent: this.state.showPluginContent,
      ...(Object.keys(panelPlacements).length > 0 ? { panelPlacements } : {}),
    };
  }

  setShowPluginContent(show: boolean): void {
    this.state.showPluginContent = show;
  }

  getDirtyDocuments(): OpenDocument[] {
    return [...this.state.openDocuments.values()].filter(
      (doc) => doc.dirty && doc.ref.kind !== "content-browser",
    );
  }
}
