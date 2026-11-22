import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { commitOnFocusLeave, MarkupAutocompleteTextarea, useEditorReadOnly, useTextDraft } from "@haptic/editor-kit";
import { Textarea } from "@haptic/ui/components/textarea";
import { cn } from "@haptic/ui/lib/utils";
import { useDocumentActions } from "../context/document-context";
import {
  getTextEditorSession,
  subscribeTextEditorSessions,
  type TextEditorSession,
} from "../services/text-editor-sessions";
import { LazyCodeBodyEditor } from "./lazy-code-editors";

/**
 * A Text Editor tab's page: one Inspector field's value edited full size.
 * Like the field, it keeps a draft and commits it through the session when
 * focus leaves the editor, when the tab stops being active, and when it closes.
 */
export function TextEditorWorkspace({ documentId, sessionId, active }: {
  documentId: string;
  sessionId: string;
  active: boolean;
}) {
  const getSnapshot = useCallback(() => getTextEditorSession(sessionId), [sessionId]);
  const session = useSyncExternalStore(subscribeTextEditorSessions, getSnapshot);
  const { closeDocument } = useDocumentActions();
  // The session goes away with its field; a tab without one closes itself.
  useEffect(() => {
    if (!session) closeDocument(documentId);
  }, [closeDocument, documentId, session]);
  return session ? <TextEditorPage session={session} active={active} /> : null;
}

function TextEditorPage({ session, active }: { session: TextEditorSession; active: boolean }) {
  const inheritedReadOnly = useEditorReadOnly();
  const readOnly = session.readOnly || inheritedReadOnly;
  // The last session seen: closing the tab removes it before this page unmounts and commits.
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  });
  const onCommit = useCallback((value: string) => {
    if (!sessionRef.current.readOnly) sessionRef.current.commit(value);
  }, []);
  const { draft, setDraft, commit } = useTextDraft(session.value, onCommit);
  const hostRef = useRef<HTMLDivElement>(null);

  // A hidden tab may not fire blur, so leaving the tab commits.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) commit();
    wasActive.current = active;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const editor = hostRef.current?.querySelector<HTMLElement>("textarea, [contenteditable='true']");
      editor?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, commit]);

  const code = session.mode === "javascript" || session.mode === "glsl";
  const testId = "text-editor-workspace-editor";
  return (
    <div
      ref={hostRef}
      className={cn("flex min-h-0 flex-1 flex-col gap-2 bg-background", !code && "p-3")}
      data-testid="text-editor-workspace"
      data-mode={session.mode}
      onBlur={commitOnFocusLeave(commit)}
    >
      {code ? (
        <LazyCodeBodyEditor
          language={session.mode === "glsl" ? "glsl" : "javascript"}
          value={draft}
          onChange={setDraft}
          names={session.names}
          readOnly={readOnly}
          ariaLabel={session.title}
          autoFocus={active}
        />
      ) : session.mode === "markup" ? (
        <MarkupAutocompleteTextarea
          value={draft}
          onChange={setDraft}
          readOnly={readOnly}
          aria-label={session.title}
          className="min-h-0 flex-1 resize-none font-mono text-sm field-sizing-fixed"
          data-testid={testId}
        />
      ) : (
        <Textarea
          value={draft}
          readOnly={readOnly}
          aria-label={session.title}
          spellCheck={session.mode === "formula" ? false : undefined}
          autoCapitalize={session.mode === "formula" ? "off" : undefined}
          className={cn("min-h-0 flex-1 resize-none field-sizing-fixed", session.mode === "formula" && "font-mono text-sm")}
          onChange={(event) => setDraft(event.target.value)}
          data-testid={testId}
        />
      )}
      {session.error ? (
        <p role="alert" className={cn("text-sm text-destructive", code && "px-3 pb-2")} data-testid="text-editor-workspace-error">
          {session.error}
        </p>
      ) : null}
    </div>
  );
}
