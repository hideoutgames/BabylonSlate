import { createContext, useContext, type ReactNode } from "react";

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
  return (
    <DocumentWorkspaceContext.Provider value={{ documentId }}>
      {children}
    </DocumentWorkspaceContext.Provider>
  );
}

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export function useDocumentWorkspace(): DocumentWorkspaceContextValue {
  const context = useContext(DocumentWorkspaceContext);
  if (!context) {
    throw new Error(
      "useDocumentWorkspace must be used within DocumentWorkspaceProvider",
    );
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
