import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorSessionState } from "../lib/editor-session-state";
import type { DocumentIdentityListener } from "../services/document-service";

const EditorSessionStateContext = createContext<EditorSessionState | null>(null);

/**
 * Owns the project session's editor view state. Mounted at the top of
 * EditorRoute, which every project entry mounts afresh from Homepage, so the
 * store lives exactly as long as one open project. The context value is
 * created once and never changes identity; writes never re-render.
 */
export function EditorSessionStateProvider({
  children,
  subscribeDocumentIdentity,
}: {
  children: ReactNode;
  /** Document opens and renames the store follows (DocumentService events). */
  subscribeDocumentIdentity?: (listener: DocumentIdentityListener) => () => void;
}) {
  const [store] = useState(() => new EditorSessionState());
  useEffect(
    () =>
      subscribeDocumentIdentity?.((event) => {
        if (event.type === "repathed") store.rekeyDocument(event.oldId, event.newId);
        else store.documentOpened(event.id);
      }),
    [store, subscribeDocumentIdentity],
  );
  return (
    <EditorSessionStateContext.Provider value={store}>
      {children}
    </EditorSessionStateContext.Provider>
  );
}

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
/**
 * The project session store. Without a provider (isolated component tests)
 * each calling component gets its own store for its lifetime.
 */
export function useEditorSessionState(): EditorSessionState {
  const shared = useContext(EditorSessionStateContext);
  const ownRef = useRef<EditorSessionState | null>(null);
  if (shared) return shared;
  ownRef.current ??= new EditorSessionState();
  return ownRef.current;
}
/* eslint-enable react-refresh/only-export-components */
