import type {
  AssetDocumentKind,
  DocumentKind,
  DocumentRef,
  PanelPlacement,
  ProjectLayouts,
  SerializedGraph,
  SerializedScene,
} from "@babylonslate/core";
import {
  ASSET_DOCUMENT_KINDS,
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
  documentId,
  documentKindLabel,
  isAssetDocumentKind,
  isContentBrowserId,
  isSceneWorkspaceKind,
  labelFromPath,
  migrateRestoredDocumentId,
  parseDocumentId,
} from "@babylonslate/core";
import type { ProjectDocument } from "@babylonslate/core";
import { recordDocumentDirty } from "../lib/dirty-trace";
import { documentContentIdentity } from "../lib/document-content-identity";
import { editorTabContentForKind } from "../lib/scene-layer-document";
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
  /** Canonical working document used by another editor, without its own tab. */
  background?: boolean;
}

export interface DocumentRegistryState {
  openDocuments: Map<string, OpenDocument>;
  tabOrder: string[];
  activeDocumentId: string | null;
  panelPlacements: Record<string, Record<string, PanelPlacement>>;
  showPluginContent: boolean;
}

export interface DocumentLoadOptions {
  signal?: AbortSignal;
  /** Retain a shared working document without adding visible navigation. */
  background?: boolean;
  /** Host paints blocking progress before storage access starts. */
  beforeLoad?: (ref: DocumentRef) => Promise<void>;
  /** Runs after a successful read, before replacing any open document. */
  beforeCommit?: (ref: DocumentRef) => void;
}

/** Identity changes that editor session state keyed by document id follows. */
export type DocumentIdentityEvent =
  | { type: "opened"; id: string }
  | { type: "repathed"; oldId: string; newId: string };

export type DocumentIdentityListener = (event: DocumentIdentityEvent) => void;

/**
 * One revision per document kind. A kind's revision advances whenever what a
 * reader of that kind's open documents sees changes: a document of the kind
 * opens, closes, moves, is reordered among the tabs, or has its content,
 * layout or dirty state changed (edits, Undo / Redo, reloads, patches,
 * saves). Every advance takes the next value of one service-wide sequence, so
 * revisions never repeat and {@link documentKindsRevision} combines kinds.
 */
export type DocumentRevisions = Readonly<Record<DocumentKind, number>>;

const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "content-browser",
  ...ASSET_DOCUMENT_KINDS,
];

function initialDocumentRevisions(): DocumentRevisions {
  return Object.fromEntries(
    DOCUMENT_KINDS.map((kind) => [kind, 0]),
  ) as Record<DocumentKind, number>;
}

/**
 * The latest revision among `kinds`. It changes exactly when a document of one
 * of them changes, so a memo keyed on it ignores edits to every other kind.
 */
export function documentKindsRevision(
  revisions: DocumentRevisions,
  kinds: Iterable<DocumentKind>,
): number {
  let latest = 0;
  for (const kind of kinds) latest = Math.max(latest, revisions[kind] ?? 0);
  return latest;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameLayout(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

type TabsSnapshot = { order: readonly string[]; foreground: readonly string[]; active: string | null };

export class DocumentService {
  private readonly identityListeners = new Set<DocumentIdentityListener>();
  private revisionSequence = 0;
  private revisions: DocumentRevisions = initialDocumentRevisions();
  private tabsRevision = 0;
  /** Weak keys follow tab renames without retaining closed project content. */
  private readonly savedContent = new WeakMap<OpenDocument, string>();

  private updateDirty(doc: OpenDocument): void {
    doc.dirty = documentContentIdentity(doc.content) !== this.savedContent.get(doc);
    if (doc.dirty) recordDocumentDirty(doc.ref.kind, doc.id);
  }

  /** `opened` fires when a new tab entry is created; `repathed` on every path change. */
  onIdentityChange(listener: DocumentIdentityListener): () => void {
    this.identityListeners.add(listener);
    return () => {
      this.identityListeners.delete(listener);
    };
  }

  private emitIdentity(event: DocumentIdentityEvent): void {
    for (const listener of [...this.identityListeners]) listener(event);
  }

  /**
   * Per-kind revisions (see {@link DocumentRevisions}). The object is replaced
   * whenever a kind advances and kept otherwise, so callers may key on it.
   */
  getRevisions(): DocumentRevisions {
    return this.revisions;
  }

  /**
   * Advances when the open set, the tab order or the active tab changes.
   * Drawn from the same sequence as the per-kind revisions.
   */
  getTabsRevision(): number {
    return this.tabsRevision;
  }

  private advanceKinds(kinds: Iterable<DocumentKind>): void {
    const unique = new Set(kinds);
    if (unique.size === 0) return;
    const next = ++this.revisionSequence;
    const revisions: Record<string, number> = { ...this.revisions };
    for (const kind of unique) revisions[kind] = next;
    this.revisions = revisions as DocumentRevisions;
  }

  /** The tabs before a mutation, for `advanceTabsIfChanged` after it. */
  private tabsSnapshot(): TabsSnapshot {
    return {
      order: [...this.state.tabOrder],
      foreground: this.state.tabOrder.filter((id) => !this.state.openDocuments.get(id)?.background),
      active: this.state.activeDocumentId,
    };
  }

  private advanceTabsIfChanged(before: TabsSnapshot): void {
    if (
      before.active === this.state.activeDocumentId &&
      sameIds(before.order, this.state.tabOrder) &&
      sameIds(before.foreground, this.state.tabOrder.filter((id) => !this.state.openDocuments.get(id)?.background))
    ) {
      return;
    }
    this.tabsRevision = ++this.revisionSequence;
  }

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

  getScrollableDocumentsOrdered(): OpenDocument[] {
    return this.getOpenDocumentsOrdered().filter(
      (doc) =>
        !doc.background && doc.ref.kind !== "content-browser" && doc.ref.kind !== "scene",
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
    const tabs = this.tabsSnapshot();
    if (this.state.openDocuments.has(CONTENT_BROWSER_ID)) {
      this.pinStickyTabs();
      this.advanceTabsIfChanged(tabs);
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
    this.pinStickyTabs();
    if (!this.state.activeDocumentId) {
      this.state.activeDocumentId = CONTENT_BROWSER_ID;
    }
    this.advanceKinds(["content-browser"]);
    this.advanceTabsIfChanged(tabs);
  }

  private pinStickyTabs(): void {
    const sceneId = [...this.state.openDocuments.values()].find(
      (doc) => doc.ref.kind === "scene",
    )?.id;
    const rest = this.state.tabOrder.filter(
      (id) => id !== CONTENT_BROWSER_ID && id !== sceneId,
    );
    this.state.tabOrder = [
      CONTENT_BROWSER_ID,
      ...(sceneId ? [sceneId] : []),
      ...rest,
    ];
  }

  private isPinnedChromeTabId(id: string): boolean {
    if (isContentBrowserId(id)) return true;
    return this.state.openDocuments.get(id)?.ref.kind === "scene";
  }

  async initializeFromProject(
    projectService: ProjectService,
    _document: ProjectDocument,
    layouts: ProjectLayouts,
    sceneLoadOptions?: DocumentLoadOptions,
  ): Promise<void> {
    sceneLoadOptions?.signal?.throwIfAborted();
    const closedKinds = [...this.state.openDocuments.values()].map(
      (doc) => doc.ref.kind,
    );
    const tabs = this.tabsSnapshot();
    this.state = {
      openDocuments: new Map(),
      tabOrder: [],
      activeDocumentId: null,
      panelPlacements: structuredClone(layouts.panelPlacements ?? {}),
      showPluginContent: layouts.showPluginContent === true,
    };
    // Every previous tab closed; each restored one advances its kind on open.
    this.advanceKinds(closedKinds);
    this.advanceTabsIfChanged(tabs);

    this.ensureContentBrowserTab();

    const savedOrder = layouts.tabOrder.filter(
      (id) => !isContentBrowserId(id) && id.includes(":"),
    );
    const typeForPath = (path: string) =>
      projectService.registry?.list().find((asset) => asset.path === path)
        ?.header.type ?? null;
    const lastSceneId = [...savedOrder]
      .reverse()
      .find((id) => parseDocumentId(id)?.kind === "scene");

    for (const id of savedOrder) {
      const restoredId = migrateRestoredDocumentId(id, typeForPath);
      const parsed = parseDocumentId(restoredId);
      if (!parsed || !isAssetDocumentKind(parsed.kind)) continue;
      if (parsed.kind === "scene" && restoredId !== lastSceneId) continue;
      // Legacy layouts have only paths. A deleted or renamed tab must not make
      // the whole project inaccessible; saved GUIDs repair newer layouts.
      if (projectService.documentExists && !(await projectService.documentExists(parsed.path))) continue;
      try {
        await this.openDocument(
          projectService,
          { kind: parsed.kind, path: parsed.path, label: labelFromPath(parsed.path) },
          layouts.documents[restoredId] ?? layouts.documents[id] ?? null,
          false,
          isSceneWorkspaceKind(parsed.kind) ? sceneLoadOptions : { signal: sceneLoadOptions?.signal },
        );
      } catch (error) {
        if (parsed.kind !== "trace") throw error;
      }
    }

    sceneLoadOptions?.signal?.throwIfAborted();
    const restored = this.tabsSnapshot();
    this.pinStickyTabs();

    // Always land on the Content Browser when opening a project so users
    // don't get dropped into an empty black viewport tab.
    this.state.activeDocumentId = CONTENT_BROWSER_ID;
    this.advanceTabsIfChanged(restored);
  }

  async openDocument(
    projectService: ProjectService,
    ref: DocumentRef,
    layout: Record<string, unknown> | null = null,
    setActive = true,
    options?: DocumentLoadOptions,
  ): Promise<string> {
    options?.signal?.throwIfAborted();
    if (options?.background && (ref.kind === "content-browser" || isSceneWorkspaceKind(ref.kind))) {
      throw new Error("Scene workspaces and Content Browser cannot be background documents.");
    }
    if (ref.kind === "content-browser") {
      const tabs = this.tabsSnapshot();
      this.ensureContentBrowserTab();
      if (setActive) {
        this.state.activeDocumentId = CONTENT_BROWSER_ID;
      }
      this.advanceTabsIfChanged(tabs);
      return CONTENT_BROWSER_ID;
    }

    const id = documentId(ref);
    const owner = this.state;
    const existing = this.state.openDocuments.get(id);
    if (existing) {
      options?.beforeCommit?.(ref);
      options?.signal?.throwIfAborted();
      const tabs = this.tabsSnapshot();
      if (!options?.background) this.promoteDocument(existing);
      if (setActive && !options?.background) {
        this.state.activeDocumentId = id;
      }
      if (ref.kind === "scene") {
        this.closeOtherSceneDocuments(id);
      }
      this.pinStickyTabs();
      this.advanceTabsIfChanged(tabs);
      return id;
    }

    if (options?.beforeLoad) await options.beforeLoad(ref);
    options?.signal?.throwIfAborted();
    const loaded = await projectService.loadDocument(ref.kind, ref.path);
    options?.signal?.throwIfAborted();
    if (this.state !== owner) {
      throw new DOMException("The document's project was closed", "AbortError");
    }
    const content = editorTabContentForKind(
      ref.kind,
      loaded,
    ) as DocumentContent;
    const fullRef = createDocumentRef(ref.kind, ref.path, content);

    const entry: OpenDocument = {
      id,
      ref: fullRef,
      content,
      layout,
      dirty: false,
      ...(options?.background ? { background: true } : {}),
    };

    options?.beforeCommit?.(ref);
    options?.signal?.throwIfAborted();
    if (this.state !== owner) {
      throw new DOMException("The document's project was closed", "AbortError");
    }
    // Another opener may have committed and been edited while this read was
    // pending. Keep that tab's identity, layout, content, and dirty revision.
    const tabs = this.tabsSnapshot();
    const alreadyOpened = this.state.openDocuments.has(id);
    if (!alreadyOpened) {
      this.state.openDocuments.set(id, entry);
      this.savedContent.set(entry, documentContentIdentity(content));
      this.state.tabOrder.push(id);
      this.advanceKinds([fullRef.kind]);
    } else if (!options?.background) {
      // A foreground read can race with a sheet loading this same record.
      // Promote the canonical object, retaining any edits made during I/O.
      this.promoteDocument(this.state.openDocuments.get(id)!);
    }
    if (ref.kind === "scene") {
      this.closeOtherSceneDocuments(id);
    }
    this.pinStickyTabs();
    if (setActive && !options?.background) {
      this.state.activeDocumentId = id;
    }
    this.advanceTabsIfChanged(tabs);
    if (!alreadyOpened) this.emitIdentity({ type: "opened", id });
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

    const tabs = this.tabsSnapshot();
    const closed = this.state.openDocuments.get(id);
    this.state.openDocuments.delete(id);
    this.state.tabOrder = this.state.tabOrder.filter((tabId) => tabId !== id);
    delete this.state.panelPlacements[id];
    if (this.state.activeDocumentId === id) {
      this.state.activeDocumentId = this.state.tabOrder.find((tabId) => !this.state.openDocuments.get(tabId)?.background) ?? CONTENT_BROWSER_ID;
    }
    this.pinStickyTabs();
    if (closed) this.advanceKinds([closed.ref.kind]);
    this.advanceTabsIfChanged(tabs);
  }

  /**
   * Close every open asset tab whose file path is in `paths`.
   * Content Browser stays open. Returns the closed document ids.
   */
  closeDocumentsForPaths(paths: Iterable<string>): string[] {
    const pathSet = paths instanceof Set ? paths : new Set(paths);
    const ids: string[] = [];
    for (const doc of this.state.openDocuments.values()) {
      if (doc.ref.kind === "content-browser") continue;
      if (pathSet.has(doc.ref.path)) ids.push(doc.id);
    }
    for (const id of ids) this.closeDocument(id);
    return ids;
  }

  /**
   * Retarget an open tab after a registry move/rename. Guids stay stable; only
   * path-based document ids and layout keys change. `repathed` is emitted even
   * when the document is not open, so session state kept for closed tabs
   * follows the asset too. Returns the ids, or null when the path is unchanged.
   */
  repathDocument(
    kind: AssetDocumentKind,
    oldPath: string,
    newPath: string,
  ): { oldId: string; newId: string } | null {
    if (oldPath === newPath) return null;
    const oldId = documentId({ kind, path: oldPath });
    const newId = documentId({ kind, path: newPath });
    this.retargetOpenDocument(kind, oldId, newId, newPath);
    this.emitIdentity({ type: "repathed", oldId, newId });
    return { oldId, newId };
  }

  private retargetOpenDocument(
    kind: AssetDocumentKind,
    oldId: string,
    newId: string,
    newPath: string,
  ): void {
    const doc = this.state.openDocuments.get(oldId);
    if (!doc) return;
    const tabs = this.tabsSnapshot();
    this.state.openDocuments.delete(oldId);
    const next: OpenDocument = {
      ...doc,
      id: newId,
      ref: createDocumentRef(kind, newPath, doc.content ?? undefined),
    };
    this.state.openDocuments.set(newId, next);
    const savedIdentity = this.savedContent.get(doc);
    if (savedIdentity !== undefined) this.savedContent.set(next, savedIdentity);
    this.state.tabOrder = this.state.tabOrder.map((id) =>
      id === oldId ? newId : id,
    );
    this.pinStickyTabs();
    if (this.state.activeDocumentId === oldId) {
      this.state.activeDocumentId = newId;
    }
    const placements = this.state.panelPlacements[oldId];
    if (placements) {
      this.state.panelPlacements[newId] = placements;
      delete this.state.panelPlacements[oldId];
    }
    this.advanceKinds([kind]);
    this.advanceTabsIfChanged(tabs);
  }

  setActiveDocument(id: string): void {
    const doc = this.state.openDocuments.get(id);
    if (doc) {
      const tabs = this.tabsSnapshot();
      this.promoteDocument(doc);
      this.state.activeDocumentId = id;
      this.advanceTabsIfChanged(tabs);
    }
  }

  private promoteDocument(doc: OpenDocument): void {
    if (!doc.background) return;
    delete doc.background;
    this.advanceKinds([doc.ref.kind]);
  }

  reorderClosableTabs(fromClosableIndex: number, toClosableIndex: number): void {
    const scrollable = this.getScrollableDocumentsOrdered();
    const fromDoc = scrollable[fromClosableIndex];
    const toDoc = scrollable[toClosableIndex];
    if (!fromDoc || !toDoc) return;
    this.reorderTabs(
      this.state.tabOrder.indexOf(fromDoc.id),
      this.state.tabOrder.indexOf(toDoc.id),
    );
  }

  reorderTabs(fromIndex: number, toIndex: number): void {
    const fromId = this.state.tabOrder[fromIndex];
    const toId = this.state.tabOrder[toIndex];
    if (
      fromId === undefined ||
      toId === undefined ||
      fromIndex === toIndex ||
      this.isPinnedChromeTabId(fromId) ||
      this.isPinnedChromeTabId(toId) ||
      this.state.openDocuments.get(fromId)?.background ||
      this.state.openDocuments.get(toId)?.background
    ) {
      return;
    }

    const tabs = this.tabsSnapshot();
    const next = [...this.state.tabOrder];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    this.state.tabOrder = next;
    this.pinStickyTabs();
    // Readers of the moved document's kind see its documents in a new order.
    const movedKind = this.state.openDocuments.get(moved)?.ref.kind;
    if (movedKind) this.advanceKinds([movedKind]);
    this.advanceTabsIfChanged(tabs);
  }

  updateScene(id: string, scene: SerializedScene): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || !isSceneWorkspaceKind(doc.ref.kind)) return;
    doc.content = scene;
    this.advanceKinds([doc.ref.kind]);
    this.updateDirty(doc);
    doc.ref = {
      ...doc.ref,
      label: `${scene.name} ${documentKindLabel(doc.ref.kind)}`,
    };
  }

  updateGraph(id: string, graph: SerializedGraph): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || doc.ref.kind !== "graph") return;
    doc.content = graph;
    this.advanceKinds([doc.ref.kind]);
    this.updateDirty(doc);
  }

  updateAssetDocument(id: string, content: Record<string, unknown>): void {
    const doc = this.state.openDocuments.get(id);
    if (
      !doc ||
      doc.ref.kind === "content-browser" ||
      isSceneWorkspaceKind(doc.ref.kind) ||
      doc.ref.kind === "graph"
    ) {
      return;
    }
    doc.content = content;
    this.advanceKinds([doc.ref.kind]);
    this.updateDirty(doc);
    if (typeof content.name === "string" && content.name.trim() !== "") {
      doc.ref = {
        ...doc.ref,
        label: `${content.name} ${documentKindLabel(doc.ref.kind)}`,
      };
    }
  }

  setLayout(id: string, layout: Record<string, unknown> | null): void {
    const doc = this.state.openDocuments.get(id);
    // Tab switches and saves capture every docked layout again; an unchanged
    // capture changes nothing a reader sees.
    if (!doc || sameLayout(doc.layout, layout)) return;
    doc.layout = layout;
    this.advanceKinds([doc.ref.kind]);
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

  /** Clear only revisions whose content was actually written by this save. */
  markAllClean(saved: readonly OpenDocument[]): void {
    const changed: DocumentKind[] = [];
    for (const snapshot of saved) {
      const doc = this.state.openDocuments.get(snapshot.id);
      if (doc && doc.ref.kind !== "content-browser" && doc.ref.path === snapshot.ref.path) {
        const savedIdentity = documentContentIdentity(snapshot.content);
        this.savedContent.set(doc, savedIdentity);
        const dirty = documentContentIdentity(doc.content) !== savedIdentity;
        if (doc.dirty !== dirty) changed.push(doc.ref.kind);
        doc.dirty = dirty;
      }
    }
    this.advanceKinds(changed);
  }

  replaceLoadedContent(id: string, content: DocumentContent): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || doc.ref.kind === "content-browser") return;
    doc.content = content;
    this.savedContent.set(doc, documentContentIdentity(content));
    doc.dirty = false;
    this.advanceKinds([doc.ref.kind]);
  }

  /** Update in-memory content without changing the dirty flag. */
  patchLoadedContent(id: string, content: DocumentContent): void {
    const doc = this.state.openDocuments.get(id);
    if (!doc || doc.ref.kind === "content-browser") return;
    doc.content = content;
    if (!doc.dirty) this.savedContent.set(doc, documentContentIdentity(content));
    this.advanceKinds([doc.ref.kind]);
  }

  buildLayouts(): ProjectLayouts {
    const documents: Record<string, Record<string, unknown>> = {};
    for (const [id, doc] of this.state.openDocuments) {
      if (doc.layout && !doc.background) {
        documents[id] = doc.layout;
      }
    }
    const panelPlacements = Object.fromEntries(
      Object.entries(this.state.panelPlacements).filter(
        ([id, placements]) => !this.state.openDocuments.get(id)?.background && Object.keys(placements).length > 0,
      ),
    );
    return {
      documents,
      tabOrder: this.state.tabOrder.filter((id) => !this.state.openDocuments.get(id)?.background),
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
