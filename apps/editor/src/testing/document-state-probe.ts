import {
  useActiveDocumentState,
  useAppRoute,
  useCompileState,
  useEditorShellState,
  useOpenDocumentTabs,
  useProjectState,
  useRegistryState,
  useSaveState,
  useSourceControl,
  useTabOrder,
  useThumbnailVersions,
} from "../context/document-context";

/**
 * Every state hook of the real `DocumentProvider` in one object, for tests
 * that observe the provider itself. Each field keeps the identity its hook
 * gives it (`openDocuments` is `useOpenDocumentTabs()`, `dirtyDocuments` the
 * save slice's list); the component re-renders when any of them changes.
 * Production components call the one hook they need instead.
 */
export function useDocumentStateProbe() {
  return {
    route: useAppRoute(),
    ...useProjectState(),
    ...useRegistryState(),
    ...useActiveDocumentState(),
    ...useSaveState(),
    ...useCompileState(),
    ...useEditorShellState(),
    ...useSourceControl(),
    openDocuments: useOpenDocumentTabs(),
    tabOrder: useTabOrder(),
    thumbnailVersions: useThumbnailVersions(),
  };
}

export type DocumentStateProbe = ReturnType<typeof useDocumentStateProbe>;
