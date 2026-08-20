import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
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

export type ProjectSearchStatus = "idle" | "pending" | "ready";

interface ProjectSearchContextValue {
  query: (needle: string) => SearchEntry[];
  searchStatus: ProjectSearchStatus;
  beginSearchRebuild: () => void;
  cancelSearchRebuild: () => void;
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
    assetRegistry,
    openDocument,
    setActiveDocument,
    openDocuments,
  } = useDocuments();
  const { setFocusDiagnostic } = useValidation();
  const [pendingTarget, setPendingTarget] = useState<SearchOpenTarget | null>(
    null,
  );
  const [searchStatus, setSearchStatus] = useState<ProjectSearchStatus>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const searchIndexRef = useRef(searchIndex);
  const assetRegistryRef = useRef(assetRegistry);
  const openDocumentsRef = useRef(openDocuments);
  searchIndexRef.current = searchIndex;
  assetRegistryRef.current = assetRegistry;
  openDocumentsRef.current = openDocuments;

  const cancelSearchRebuild = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    generationRef.current += 1;
    setSearchStatus("idle");
  }, []);

  const beginSearchRebuild = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;
    const index = searchIndexRef.current;
    const registry = assetRegistryRef.current;
    if (!index || !registry) {
      setSearchStatus("idle");
      return;
    }
    setSearchStatus("pending");
    const overlays = openDocumentsRef.current
      .filter((doc) => doc.content && doc.ref.path)
      .map((doc) => ({
        path: doc.ref.path,
        payload: doc.content as Record<string, unknown>,
      }));
    void index
      .rebuild(registry, {
        signal: controller.signal,
        openDocuments: overlays,
      })
      .then(() => {
        if (generation !== generationRef.current) return;
        setSearchStatus("ready");
      })
      .catch(() => {
        if (generation !== generationRef.current) return;
        if (controller.signal.aborted) return;
        setSearchStatus("idle");
      });
  }, []);

  const query = useCallback(
    (needle: string) => {
      if (searchStatus !== "ready") return [];
      return searchIndex?.query(needle) ?? [];
    },
    [searchIndex, searchStatus],
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

      if (dest.kind !== "content-browser") {
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
      searchStatus,
      beginSearchRebuild,
      cancelSearchRebuild,
      pendingTarget,
      clearPendingTarget,
      openSearchResult,
    }),
    [
      beginSearchRebuild,
      cancelSearchRebuild,
      clearPendingTarget,
      openSearchResult,
      pendingTarget,
      query,
      searchStatus,
    ],
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
