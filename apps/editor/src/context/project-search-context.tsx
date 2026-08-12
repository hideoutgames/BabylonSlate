import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SearchEntry, SearchOpenTarget } from "@babylonslate/assets";
import {
  CONTENT_BROWSER_ID,
  documentId,
  labelFromPath,
} from "@babylonslate/core";
import { useDocuments } from "./document-context";
import { useValidation } from "./validation-context";
import {
  documentOpenForTarget,
  graphFocusNodeId,
  revealAssetFromTarget,
  sceneFocusActorId,
} from "../lib/search-navigation";

interface ProjectSearchContextValue {
  query: (needle: string) => SearchEntry[];
  pendingTarget: SearchOpenTarget | null;
  clearPendingTarget: () => void;
  openSearchResult: (entry: SearchEntry) => Promise<void>;
}

const ProjectSearchContext = createContext<ProjectSearchContextValue | null>(
  null,
);

export function ProjectSearchProvider({ children }: { children: ReactNode }) {
  const {
    searchIndex,
    openDocument,
    setActiveDocument,
    openDocuments,
  } = useDocuments();
  const { setFocusDiagnostic } = useValidation();
  const [pendingTarget, setPendingTarget] = useState<SearchOpenTarget | null>(
    null,
  );

  const query = useCallback(
    (needle: string) => searchIndex?.query(needle) ?? [],
    [searchIndex],
  );

  const clearPendingTarget = useCallback(() => {
    setPendingTarget(null);
  }, []);

  const openSearchResult = useCallback(
    async (entry: SearchEntry) => {
      const dest = documentOpenForTarget(entry.target);
      const actorId = sceneFocusActorId(entry.target);
      const reveal = revealAssetFromTarget(entry.target);
      if (actorId || reveal) {
        setPendingTarget(entry.target);
      }

      if (dest.kind === "scene" || dest.kind === "graph") {
        const id = documentId({ kind: dest.kind, path: dest.path });
        const alreadyOpen = openDocuments.some((doc) => doc.id === id);
        if (alreadyOpen) {
          setActiveDocument(id);
        } else {
          await openDocument({
            kind: dest.kind,
            path: dest.path,
            label: labelFromPath(dest.path),
          });
        }
        const nodeId = graphFocusNodeId(entry.target);
        if (nodeId) {
          setFocusDiagnostic({
            severity: "info",
            code: "search",
            message: "Search result",
            assetGuid: dest.path,
            graphId: id,
            nodeId,
          });
        }
        return;
      }

      setActiveDocument(CONTENT_BROWSER_ID);
    },
    [openDocument, openDocuments, setActiveDocument, setFocusDiagnostic],
  );

  const value = useMemo<ProjectSearchContextValue>(
    () => ({
      query,
      pendingTarget,
      clearPendingTarget,
      openSearchResult,
    }),
    [clearPendingTarget, openSearchResult, pendingTarget, query],
  );

  return (
    <ProjectSearchContext.Provider value={value}>
      {children}
    </ProjectSearchContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useProjectSearch(): ProjectSearchContextValue {
  const context = useContext(ProjectSearchContext);
  if (!context) {
    throw new Error("useProjectSearch requires ProjectSearchProvider");
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
