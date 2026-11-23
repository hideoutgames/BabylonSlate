/**
 * Text Editor tab sessions: one per Inspector field opened in its own tab
 * (`text-editor:<session id>`). The field that opened a session keeps it
 * current and removes it when it unmounts; the tab reads it by id.
 * A module-level store for `useSyncExternalStore`, without React.
 */

export type TextEditorMode = "text" | "markup" | "formula" | "javascript" | "glsl";

export interface TextEditorSession {
  /** Stable: `${sourceDocumentId}#${fieldKey}`. */
  id: string;
  sourceDocumentId: string;
  /** The field label, e.g. "Formula". */
  title: string;
  mode: TextEditorMode;
  /** The field's committed value. */
  value: string;
  readOnly: boolean;
  /** Completion names for the code modes. */
  names: readonly string[];
  /** A live error shown under the editor (a Math Expression's parse error). */
  error: string | null;
  /** Calls the owning field's latest `onChange`. */
  commit: (value: string) => void;
}

type Listener = () => void;

let sessions: ReadonlyMap<string, TextEditorSession> = new Map();
let snapshot: readonly TextEditorSession[] = [];
const listeners = new Set<Listener>();

function publish(next: Map<string, TextEditorSession>): void {
  sessions = next;
  snapshot = [...next.values()];
  for (const listener of [...listeners]) listener();
}

/** The session id for a field of a document; `fieldKey` holds no `#`. */
export function textEditorSessionId(sourceDocumentId: string, fieldKey: string): string {
  return `${sourceDocumentId}#${fieldKey}`;
}

/** The document a session id's field belongs to. */
export function textEditorSourceDocumentId(sessionId: string): string {
  const hash = sessionId.lastIndexOf("#");
  return hash < 0 ? sessionId : sessionId.slice(0, hash);
}

export function subscribeTextEditorSessions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every session, as one array replaced on each change (a stable `useSyncExternalStore` snapshot). */
export function listTextEditorSessions(): readonly TextEditorSession[] {
  return snapshot;
}

export function getTextEditorSession(id: string): TextEditorSession | undefined {
  return sessions.get(id);
}

/** Adds or replaces a session; an unchanged one publishes nothing. */
export function upsertTextEditorSession(session: TextEditorSession): void {
  const current = sessions.get(session.id);
  if (current && sameSession(current, session)) return;
  const next = new Map(sessions);
  next.set(session.id, Object.freeze({ ...session, names: Object.freeze([...session.names]) }));
  publish(next);
}

export function removeTextEditorSession(id: string): void {
  if (!sessions.has(id)) return;
  const next = new Map(sessions);
  next.delete(id);
  publish(next);
}

export function clearTextEditorSessions(): void {
  if (sessions.size === 0) return;
  publish(new Map());
}

function sameSession(a: TextEditorSession, b: TextEditorSession): boolean {
  return a.sourceDocumentId === b.sourceDocumentId &&
    a.title === b.title &&
    a.mode === b.mode &&
    a.value === b.value &&
    a.readOnly === b.readOnly &&
    a.error === b.error &&
    a.commit === b.commit &&
    a.names.length === b.names.length &&
    a.names.every((name, index) => name === b.names[index]);
}
