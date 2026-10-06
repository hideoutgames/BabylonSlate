/** Authoring operations are supplied only by the editor's utility host. */
export type EditorDataResult<T> =
  | { success: true; value: T; error: "" }
  | { success: false; value: null; error: string };

/** Paths are exact, case-sensitive names relative to the tree. Empty is the virtual root. */
export interface EditorDataApi {
  /** Filters by the tree default or any entry's effective Definition. */
  listTrees(definitionGuid?: string): Promise<EditorDataResult<string[]>>;
  /** All entry paths in preorder, including unsaved document edits. */
  readTree(tree: string): Promise<EditorDataResult<string[]>>;
  readEntry(tree: string, entryPath: string, definitionGuid?: string): Promise<EditorDataResult<Record<string, unknown>>>;
  getChildren(tree: string, parentPath?: string): Promise<EditorDataResult<string[]>>;
  getDescendants(tree: string, parentPath?: string): Promise<EditorDataResult<string[]>>;
  /** Top-level entries have parent "". The virtual root is not an entry. */
  getParent(tree: string, entryPath: string): Promise<EditorDataResult<string>>;
  /** Creates a persisted empty tree under the project content root. */
  createTree(name: string, defaultDefinitionGuid?: string | null, folder?: string): Promise<EditorDataResult<string>>;
  /** Undefined Definition inherits; null creates an untyped group; GUID overrides. Defaults are copied once. */
  addEntry(tree: string, parentPath: string, name: string, definitionGuid?: string | null, values?: Record<string, unknown>): Promise<EditorDataResult<string>>;
  /** Scalar nested fields merge; supplied arrays/maps replace. The tree owns Undo/Save history. */
  updateEntry(tree: string, entryPath: string, definitionGuid: string, values: Record<string, unknown>): Promise<EditorDataResult<string>>;
  /** Removes the entire subtree in one undoable edit. */
  removeEntry(tree: string, entryPath: string): Promise<EditorDataResult<string>>;
  /** Preserves internal IDs and owned values. Index is zero-based among the destination's other children; omitted appends. */
  moveEntry(tree: string, entryPath: string, newParentPath: string, index?: number): Promise<EditorDataResult<string>>;
  /** Requires every immediate child path exactly once. Descendants retain their order. */
  reorderChildren(tree: string, parentPath: string, entryPaths: string[]): Promise<EditorDataResult<string>>;
}

/** A denied capability even when a graph bypasses palette filtering. */
export function createUnavailableEditorDataApi(): EditorDataApi {
  const unavailable = async (): Promise<EditorDataResult<never>> => ({
    success: false, value: null,
    error: "Data authoring is only available to Editor Utility Objects in the editor.",
  });
  return {
    listTrees: unavailable, readTree: unavailable, readEntry: unavailable,
    getChildren: unavailable, getDescendants: unavailable, getParent: unavailable,
    createTree: unavailable, addEntry: unavailable, updateEntry: unavailable,
    removeEntry: unavailable, moveEntry: unavailable, reorderChildren: unavailable,
  };
}
