import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { SOURCE_CONTROL_ID } from "@haptic/core";
import { useDocumentActions, useIntegratedSync } from "../context/document-context";

/** The Pull flow (unsaved documents, confirmation, conflicts) loads when a pull is first asked for. */
const SourceControlPullFlow = lazy(() => import("./source-control-pull-flow"));

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
}

const SourceControlActionsContext = createContext<SourceControlActions | null>(null);

/**
 * Integrated mode's actions, shared by the status bar, the phone's More
 * Tools and the Changes window, so each runs the same Pull flow.
 */
export function SourceControlActionsProvider({ children }: { children: ReactNode }) {
  const sync = useIntegratedSync();
  const { setActiveDocument, activateDockPanel } = useDocumentActions();
  const [pullRequest, setPullRequest] = useState(0);
  const [commitRequest, setCommitRequest] = useState(0);
  const openSourceControl = useCallback(() => {
    setActiveDocument(SOURCE_CONTROL_ID);
    // Changes is the tab's first window; a layout that closed it opens it again.
    requestAnimationFrame(() => activateDockPanel("changes"));
  }, [activateDockPanel, setActiveDocument]);
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
  }), [commitRequest, openSourceControl, sync]);
  return (
    <SourceControlActionsContext.Provider value={value}>
      {children}
      {pullRequest > 0 ? (
        <Suspense fallback={null}>
          <SourceControlPullFlow key={pullRequest} onDone={() => setPullRequest(0)} />
        </Suspense>
      ) : null}
    </SourceControlActionsContext.Provider>
  );
}

// The provider and its hook belong together.
// eslint-disable-next-line react-refresh/only-export-components
export function useSourceControlActions(): SourceControlActions {
  const actions = useContext(SourceControlActionsContext);
  if (!actions) throw new Error("useSourceControlActions must be used within SourceControlActionsProvider");
  return actions;
}
