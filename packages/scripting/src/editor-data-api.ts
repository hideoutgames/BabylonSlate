/** Authoring operations are supplied only by the editor's utility host. */
export type EditorDataResult<T> =
  | { success: true; value: T; error: "" }
  | { success: false; value: null; error: string };

export interface EditorDataApi {
  listObjects(structureGuid?: string): Promise<EditorDataResult<string[]>>;
  listSheets(structureGuid?: string): Promise<EditorDataResult<string[]>>;
  readObject(reference: string, structureGuid?: string): Promise<EditorDataResult<Record<string, unknown>>>;
  readSheet(reference: string, structureGuid?: string): Promise<EditorDataResult<string[]>>;
  /** Creates a persisted standalone asset under the project content root. */
  createObject(name: string, structureGuid: string, values?: Record<string, unknown>, folder?: string): Promise<EditorDataResult<string>>;
  /**
   * Merges supplied scalar Structure fields; supplied arrays/maps replace the
   * collection. Accepts runtime Maps; persistence uses portable entry arrays.
   * Other live values are preserved and edits are undoable.
   */
  updateObject(reference: string, structureGuid: string, values: Record<string, unknown>): Promise<EditorDataResult<string>>;
  createSheet(name: string, structureGuid: string, objectGuids?: string[], folder?: string): Promise<EditorDataResult<string>>;
  /** Replaces ordered membership without copying or deleting any Data Object. */
  setSheetObjects(reference: string, structureGuid: string, objectGuids: string[]): Promise<EditorDataResult<string>>;
}

/** A real denied capability, including when a graph bypasses palette filtering. */
export function createUnavailableEditorDataApi(): EditorDataApi {
  const unavailable = async (): Promise<EditorDataResult<never>> => ({
    success: false,
    value: null,
    error: "Data authoring is only available to Editor Utility Objects in the editor.",
  });
  return {
    listObjects: unavailable,
    listSheets: unavailable,
    readObject: unavailable,
    readSheet: unavailable,
    createObject: unavailable,
    updateObject: unavailable,
    createSheet: unavailable,
    setSheetObjects: unavailable,
  };
}
