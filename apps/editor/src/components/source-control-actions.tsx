import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { SOURCE_CONTROL_ID } from "@haptic/core";
import { useDocumentActions, useIntegratedSync } from "../context/document-context";
import { SourceControlDiffService, type DiffRef, type DiffState, type DiffTarget } from "../services/source-control-diff";

/** The Pull flow (unsaved documents, confirmation, conflicts) loads when a pull is first asked for. */
const SourceControlPullFlow = lazy(() => import("./source-control-pull-flow"));
/** The Revert flow loads when a revert is first asked for. */
const SourceControlRevertFlow = lazy(() => import("./source-control-revert-flow"));

/** An asset to put back as a version holds it (Revert Asset; History's Revert To This Version). */
export interface RevertRequest {
  path: string;
  name: string;
  /** The version to write into the working copy; never the working copy itself. */
  ref: DiffRef;
}

/** The asset whose diff to show, with the versions to compare (HEAD and the working copy by default). */
export type DiffRequest = Omit<DiffTarget, "base" | "compare"> & Partial<Pick<DiffTarget, "base" | "compare">>;

export interface SourceControlActions {
  /** Saves or discards unsaved documents, confirms, then pulls (with Pull Conflicts when needed). */
  requestPull: () => void;
  /** Settles once the push (or its refusal) is in the snapshot. */
  push: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Brings the pinned Source Control tab forward with Changes. */
  openSourceControl: () => void;
  /** Opens Changes and focuses its Commit Message. */
  requestCommit: () => void;
  /** Advances on each Commit… request; the Changes window focuses its message when it changes. */
  readonly commitRequest: number;
  /** Shows an asset's diff in the Source Control tab's Actors and Diff windows. */
  openDiff: (request: DiffRequest) => void;
  /** Saves or discards the asset's unsaved edits, confirms, then writes `ref`'s version of it into the working copy. */
  requestRevert: (request: RevertRequest) => void;
}

const SourceControlActionsContext = createContext<SourceControlActions | null>(null);
const SourceControlDiffContext = createContext<SourceControlDiffService | null>(null);

/**
 * Integrated mode's actions, shared by the status bar, the phone's More
 * Tools and the Changes window, so each runs the same Pull flow; and the
 * Source Control tab's open diff.
 */
export function SourceControlActionsProvider({ children }: { children: ReactNode }) {
  const sync = useIntegratedSync();
  const { setActiveDocument, activateDockPanel } = useDocumentActions();
  const [pullRequest, setPullRequest] = useState(0);
  const [commitRequest, setCommitRequest] = useState(0);
  const [revert, setRevert] = useState<{ key: number; request: RevertRequest } | null>(null);
  const diff = useMemo(() => new SourceControlDiffService(sync), [sync]);
  useEffect(() => () => diff.dispose(), [diff]);
  const openSourceControl = useCallback(() => {
    setActiveDocument(SOURCE_CONTROL_ID);
    // Changes is the tab's first window; a layout that closed it opens it again.
    requestAnimationFrame(() => activateDockPanel("changes"));
  }, [activateDockPanel, setActiveDocument]);
  const openDiff = useCallback((request: DiffRequest) => {
    diff.open(request);
    setActiveDocument(SOURCE_CONTROL_ID);
    // A layout that closed Diff opens it again; on a phone it is the window shown.
    requestAnimationFrame(() => activateDockPanel("diff"));
  }, [activateDockPanel, diff, setActiveDocument]);
  const requestRevert = useCallback((request: RevertRequest) => setRevert((current) => ({ key: (current?.key ?? 0) + 1, request })), []);
  const value = useMemo<SourceControlActions>(() => ({
    requestPull: () => setPullRequest((request) => request + 1),
    push: () => sync.push(),
    refresh: () => sync.refresh(),
    openSourceControl,
    requestCommit: () => {
      openSourceControl();
      setCommitRequest((request) => request + 1);
    },
    commitRequest,
    openDiff,
    requestRevert,
  }), [commitRequest, openDiff, openSourceControl, requestRevert, sync]);
  return (
    <SourceControlActionsContext.Provider value={value}>
      <SourceControlDiffContext.Provider value={diff}>
        {children}
        {pullRequest > 0 ? (
          <Suspense fallback={null}>
            <SourceControlPullFlow key={pullRequest} onDone={() => setPullRequest(0)} onCompare={openDiff} />
          </Suspense>
        ) : null}
        {revert ? (
          <Suspense fallback={null}>
            <SourceControlRevertFlow key={revert.key} request={revert.request} onDone={() => setRevert(null)} />
          </Suspense>
        ) : null}
      </SourceControlDiffContext.Provider>
    </SourceControlActionsContext.Provider>
  );
}

// The provider and its hooks belong together.
// eslint-disable-next-line react-refresh/only-export-components
export function useSourceControlActions(): SourceControlActions {
  const actions = useContext(SourceControlActionsContext);
  if (!actions) throw new Error("useSourceControlActions must be used within SourceControlActionsProvider");
  return actions;
}

/** The Source Control tab's open diff service (stable). */
// eslint-disable-next-line react-refresh/only-export-components
export function useSourceControlDiff(): SourceControlDiffService {
  const diff = useContext(SourceControlDiffContext);
  if (!diff) throw new Error("useSourceControlDiff must be used within SourceControlActionsProvider");
  return diff;
}

/** The open diff's state; re-renders when it changes. */
// eslint-disable-next-line react-refresh/only-export-components
export function useSourceControlDiffState(): DiffState {
  const diff = useSourceControlDiff();
  return useSyncExternalStore(diff.subscribe, diff.getSnapshot);
}
