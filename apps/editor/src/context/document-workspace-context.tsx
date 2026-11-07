import { createContext, useContext, useMemo, type ReactNode } from "react";

interface DocumentWorkspaceContextValue {
  documentId: string;
}

const DocumentWorkspaceContext =
  createContext<DocumentWorkspaceContextValue | null>(null);

export function DocumentWorkspaceProvider({
  documentId,
  children,
}: {
  documentId: string;
  children: ReactNode;
}) {
  // Stable per document, so a workspace re-render (tab switch, save, Play) leaves every panel's consumers alone.
  const value = useMemo(() => ({ documentId }), [documentId]);
  return (
    <DocumentWorkspaceContext.Provider value={value}>
      {children}
    </DocumentWorkspaceContext.Provider>
  );
}

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export function useOptionalDocumentWorkspace(): DocumentWorkspaceContextValue | null {
  return useContext(DocumentWorkspaceContext);
}

export function useDocumentWorkspace(): DocumentWorkspaceContextValue {
  const context = useOptionalDocumentWorkspace();
  if (!context) {
    throw new Error(
      "useDocumentWorkspace must be used within DocumentWorkspaceProvider",
    );
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
