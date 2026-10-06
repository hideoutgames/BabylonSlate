/** Authoring operations are supplied only by the editor's utility host. */
export type EditorDataResult<T> =
  | { success: true; value: T; error: "" }
  | { success: false; value: null; error: string };

export interface EditorDataApi {
  listSheets(definitionGuid?: string): Promise<EditorDataResult<string[]>>;
  /** Ordered stable row IDs belonging to this sheet. */
  readSheet(sheet: string, definitionGuid?: string): Promise<EditorDataResult<string[]>>;
  readRow(sheet: string, rowId: string, definitionGuid?: string): Promise<EditorDataResult<Record<string, unknown>>>;
  /** Creates a persisted, empty sheet under the project content root. */
  createSheet(name: string, definitionGuid: string, folder?: string): Promise<EditorDataResult<string>>;
  /** Copies definition defaults once and appends an owned row as one sheet edit. */
  addRow(sheet: string, definitionGuid: string, name: string, values?: Record<string, unknown>): Promise<EditorDataResult<string>>;
  /**
   * Merges supplied scalar and nested fields; supplied arrays/maps replace the
   * collection. Accepts runtime Maps; persistence uses portable entry arrays.
   * Other row values are preserved and edits belong to the sheet's Undo history.
   */
  updateRow(sheet: string, rowId: string, definitionGuid: string, values: Record<string, unknown>): Promise<EditorDataResult<string>>;
  removeRow(sheet: string, rowId: string, definitionGuid: string): Promise<EditorDataResult<string>>;
  /** Requires every current row ID exactly once; never inserts or drops rows. */
  reorderRows(sheet: string, definitionGuid: string, rowIds: string[]): Promise<EditorDataResult<string>>;
}

/** A denied capability even when a graph bypasses palette filtering. */
export function createUnavailableEditorDataApi(): EditorDataApi {
  const unavailable = async (): Promise<EditorDataResult<never>> => ({
    success: false,
    value: null,
    error: "Data authoring is only available to Editor Utility Objects in the editor.",
  });
  return {
    listSheets: unavailable,
    readSheet: unavailable,
    readRow: unavailable,
    createSheet: unavailable,
    addRow: unavailable,
    updateRow: unavailable,
    removeRow: unavailable,
    reorderRows: unavailable,
  };
}
