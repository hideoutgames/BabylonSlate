import type { DocumentKind, DocumentRef } from "@babylonslate/core";
import {
  documentKindsRevision,
  type DocumentService,
  type OpenDocument,
} from "../services/document-service";

/**
 * What a reader of one open document sees. Entries are mutated in place, so
 * this key (replaced only when one of these fields changes) is the change
 * signal the narrow hooks compare.
 */
interface DocumentKey {
  readonly document: OpenDocument;
  readonly content: OpenDocument["content"];
  readonly ref: DocumentRef;
  readonly layout: OpenDocument["layout"];
  readonly dirty: boolean;
  readonly background: boolean;
}

/**
 * Edits replace `ref` with an equal copy (the label is rebuilt from the
 * content name), so a ref counts as changed only when one of its values does.
 */
export function sameDocumentRef(a: DocumentRef, b: DocumentRef): boolean {
  return a === b || (a.kind === b.kind && a.path === b.path && a.label === b.label);
}

/** Everything but the content: what a tab strip or tab list shows. */
function sameTab(key: DocumentKey, doc: OpenDocument): boolean {
  return (
    key.document === doc &&
    sameDocumentRef(key.ref, doc.ref) &&
    key.layout === doc.layout &&
    key.dirty === doc.dirty &&
    key.background === (doc.background === true)
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Snapshots of `DocumentService` state for `useSyncExternalStore`. Each
 * snapshot keeps its identity until what it describes changes, so a hook
 * re-renders its component only for the state it reads. `DocumentProvider`
 * calls `publish()` after each of its commits (every service mutation is
 * followed by one), so subscribers update in the same frame as the
 * `useDocuments()` facade and never see a newer or older state than it.
 */
export class DocumentSubscriptions {
  private readonly listeners = new Set<() => void>();
  private readonly keys = new WeakMap<OpenDocument, DocumentKey>();
  private tabOrder: readonly string[] = [];
  private tabs: { list: OpenDocument[]; keys: DocumentKey[] } = { list: [], keys: [] };
  private readonly service: DocumentService;

  constructor(service: DocumentService) {
    this.service = service;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Lets each subscriber compare its snapshot; unchanged ones skip rendering. */
  publish(): void {
    for (const listener of [...this.listeners]) listener();
  }

  readonly activeDocumentId = (): string | null =>
    this.service.getState().activeDocumentId;

  /** The tab ids in order; the same array while no tab opens, closes or moves. */
  readonly tabOrderSnapshot = (): readonly string[] => {
    const next = this.service.getState().tabOrder;
    if (!sameIds(this.tabOrder, next)) this.tabOrder = [...next];
    return this.tabOrder;
  };

  /**
   * Open documents in tab order. The same array until one opens, closes,
   * moves, or changes its label, layout, dirty state or background flag;
   * content edits keep it.
   */
  readonly tabsSnapshot = (): OpenDocument[] => {
    const next = this.service.getOpenDocumentsOrdered();
    const previous = this.tabs;
    const unchanged =
      next.length === previous.list.length &&
      next.every((doc, index) => sameTab(previous.keys[index], doc));
    if (!unchanged) this.tabs = { list: next, keys: next.map((doc) => this.keyFor(doc)) };
    return this.tabs.list;
  };

  /** Replaced when the document's content, label, layout or dirty state changes. */
  documentKey(id: string): DocumentKey | undefined {
    const doc = this.service.getDocument(id);
    return doc ? this.keyFor(doc) : undefined;
  }

  dirty(id: string): boolean {
    return this.service.getDocument(id)?.dirty === true;
  }

  kindsRevision(kinds: Iterable<DocumentKind>): number {
    return documentKindsRevision(this.service.getRevisions(), kinds);
  }

  private keyFor(doc: OpenDocument): DocumentKey {
    const previous = this.keys.get(doc);
    if (previous && previous.content === doc.content && sameTab(previous, doc)) return previous;
    const key: DocumentKey = {
      document: doc,
      content: doc.content,
      ref: doc.ref,
      layout: doc.layout,
      dirty: doc.dirty,
      background: doc.background === true,
    };
    this.keys.set(doc, key);
    return key;
  }
}
