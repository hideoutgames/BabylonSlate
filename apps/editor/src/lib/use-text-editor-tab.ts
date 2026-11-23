import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useEditorReadOnly } from "@haptic/editor-kit";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  getTextEditorSession,
  removeTextEditorSession,
  textEditorSessionId,
  upsertTextEditorSession,
  type TextEditorMode,
  type TextEditorSession,
} from "../services/text-editor-sessions";

export interface TextEditorTabOptions {
  /** The property within its document: `node:<id>:formula`, `component:<id>:text`; no `#`. */
  fieldKey: string;
  /** The field label, e.g. "Formula". */
  title: string;
  mode: TextEditorMode;
  /** The field's committed value. */
  value: string;
  /** Commits text from the tab; the field's own `onChange`. */
  onChange: (value: string) => void;
  disabled?: boolean;
  names?: readonly string[];
  error?: string | null;
}

/** A Text Editor tab's document id for a session. */
export function textEditorDocumentId(sessionId: string): string {
  return `text-editor:${sessionId}`;
}

// Removals wait one task, so a StrictMode effect replay or a field that
// remounts at once keeps its tab; a re-registering field cancels them.
const pendingRemovals = new Map<string, ReturnType<typeof setTimeout>>();

const NO_NAMES: readonly string[] = [];

/**
 * Binds an Inspector field to a Text Editor tab and returns the field's
 * `onOpenInTab`: it opens (or activates) a tab that edits the field's value
 * full size. The tab lives as long as the field: it closes when the field
 * unmounts. Inspector fields only: it reads the owning document from the
 * surrounding `DocumentWorkspaceProvider`.
 */
export function useTextEditorTab({
  fieldKey,
  title,
  mode,
  value,
  onChange,
  disabled = false,
  names = NO_NAMES,
  error = null,
}: TextEditorTabOptions): () => void {
  const sourceDocumentId = useDocumentWorkspace().documentId;
  const sourceDocument = useOpenDocument(sourceDocumentId);
  const { openTransientDocument, closeDocument } = useDocumentActions();
  const readOnly = useEditorReadOnly() || disabled;
  const id = textEditorSessionId(sourceDocumentId, fieldKey);

  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const commit = useCallback((next: string) => onChangeRef.current(next), []);

  const sessionFor = useCallback((sessionId: string, source: string): TextEditorSession => ({
    id: sessionId,
    sourceDocumentId: source,
    title,
    mode,
    value,
    readOnly,
    names,
    error,
    commit,
  }), [commit, error, mode, names, readOnly, title, value]);

  // Keep an open tab's session current while the field is mounted.
  useEffect(() => {
    const pending = pendingRemovals.get(id);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingRemovals.delete(id);
    }
    if (getTextEditorSession(id)) upsertTextEditorSession(sessionFor(id, sourceDocumentId));
  }, [id, sessionFor, sourceDocumentId]);

  // The field leaving (selection change, deletion, its document closing) closes its tab.
  const closeRef = useRef(closeDocument);
  useLayoutEffect(() => {
    closeRef.current = closeDocument;
  });
  useEffect(() => {
    return () => {
      const pending = pendingRemovals.get(id);
      if (pending !== undefined) clearTimeout(pending);
      pendingRemovals.set(id, setTimeout(() => {
        pendingRemovals.delete(id);
        if (!getTextEditorSession(id)) return;
        removeTextEditorSession(id);
        closeRef.current(textEditorDocumentId(id));
      }, 0));
    };
  }, [id]);

  const label = sourceDocument?.ref.label;
  return useCallback(() => {
    upsertTextEditorSession(sessionFor(id, sourceDocumentId));
    openTransientDocument({ kind: "text-editor", path: id, label: label ? `${title}: ${label}` : title });
  }, [id, label, openTransientDocument, sessionFor, sourceDocumentId, title]);
}
