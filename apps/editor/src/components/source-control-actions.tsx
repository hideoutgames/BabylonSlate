import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SOURCE_CONTROL_ID } from "@haptic/core";
import { useActiveDocumentId, useDocumentActions, useIntegratedSync, useRegistryState } from "../context/document-context";
import { projectDiffLookup } from "../lib/project-diff-lookup";
import { hasVersionHistory } from "../lib/source-control-changes";
import { SourceControlDiffService, type DiffRef, type DiffState, type DiffTarget } from "../services/source-control-diff";

/** The Pull flow (unsaved documents, confirmation, conflicts) loads when a pull is first asked for. */
const SourceControlPullFlow = lazy(() => import("./source-control-pull-flow"));
/** The Revert flow loads when a revert is first asked for. */
const SourceControlRevertFlow = lazy(() => import("./source-control-revert-flow"));
/** The Switch Branch flow and the New Branch dialog load when first asked for. */
const SourceControlBranchFlow = lazy(() => import("./source-control-branch-flow"));
const NewBranchDialog = lazy(() => import("./source-control-new-branch-dialog"));

/** An asset, or Project Settings, to put back as a version holds it (Revert Asset; History's Revert To This Version). */
export interface RevertRequest {
  path: string;
  name: string;
  /** The version to write into the working copy; never the working copy itself. */
  ref: DiffRef;
}

/** The asset whose diff to show, with the versions to compare (HEAD and the working copy by default). */
export type DiffRequest = Omit<DiffTarget, "base" | "compare"> & Partial<Pick<DiffTarget, "base" | "compare">>;

/** A flow that rewrites working files; one runs at a time. */
type RewriteFlow =
  | { kind: "pull" }
  | { kind: "revert"; request: RevertRequest }
  | { kind: "switch"; branch: string };

export interface SourceControlActions {
  /** Saves or discards unsaved documents, confirms, then pulls (with Pull Conflicts when needed). Ignored while a Pull, Revert or Switch Branch flow is open. */
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
  /** Shows an asset's diff in the Source Control tab's Actors and Diff windows; History then follows that asset. */
  openDiff: (request: DiffRequest) => void;
  /**
   * Saves or discards the asset's unsaved edits (every unsaved document for
   * Project Settings), confirms, then writes `ref`'s version of it into the
   * working copy, and for Project Settings reloads the project; only a
   * `.hasset` or `project.json` (`hasVersionHistory`), and not while another
   * rewrite flow is open.
   */
  requestRevert: (request: RevertRequest) => void;
  /** Saves or discards unsaved documents, confirms, then checks out `branch` and reloads the files it changed; not while another rewrite flow is open. */
  requestSwitchBranch: (branch: string) => void;
  /** Asks for a name, then starts that branch at HEAD and checks it out. */
  requestNewBranch: () => void;
  /** Brings the Source Control tab forward with History, on `path`'s history when it is an asset or Project Settings. */
  openHistory: (path?: string) => void;
  /** The asset (or Project Settings) whose history History shows (**This Asset**): the last one History opened on or a diff showed; never another file. */
  readonly historyPath: string | null;
}

const SourceControlActionsContext = createContext<SourceControlActions | null>(null);
const SourceControlDiffContext = createContext<SourceControlDiffService | null>(null);

/**
 * Integrated mode's actions, shared by the status bar, the phone's More
 * Tools and the Changes window, so each runs the same Pull flow; and the
 * Source Control tab's open diff. Pull, Revert and Switch Branch share one
 * slot: while one of them is open (its hold included), the others and a
 * second request of its own are ignored.
 */
export function SourceControlActionsProvider({ children }: { children: ReactNode }) {
  const sync = useIntegratedSync();
  const { setActiveDocument, activateDockPanel } = useDocumentActions();
  // One rewrite flow at a time: a request while one is mounted (Pull Conflicts' non-modal Compare leaves the status bar reachable) is ignored.
  const [rewrite, setRewrite] = useState<{ key: number; flow: RewriteFlow | null }>({ key: 0, flow: null });
  const [commitRequest, setCommitRequest] = useState(0);
  const [newBranchRequest, setNewBranchRequest] = useState(0);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  // A Project Settings diff names assets, classes, plugins and extensions as the editor knows them when it loads.
  const { assetRegistry, pluginDescriptors, extensionService } = useRegistryState();
  const names = useRef({ assetRegistry, pluginDescriptors, extensionService });
  names.current = { assetRegistry, pluginDescriptors, extensionService };
  const diff = useMemo(() => new SourceControlDiffService(sync, (service) =>
    import("../services/source-control-diff-loader").then((module) => module.createDiffLoader(service, () => {
      const current = names.current;
      return projectDiffLookup({ ...current, extensions: current.extensionService?.getSnapshot().entries ?? [] });
    }))), [sync]);
  useEffect(() => diff.attach(), [diff]);
  const showWindow = useCallback((panel: string) => {
    setActiveDocument(SOURCE_CONTROL_ID);
    // A layout that closed the window opens it again; on a phone it is the window shown.
    requestAnimationFrame(() => activateDockPanel(panel));
  }, [activateDockPanel, setActiveDocument]);
  // Changes is the tab's first window.
  const openSourceControl = useCallback(() => showWindow("changes"), [showWindow]);
  const openDiff = useCallback((request: DiffRequest) => {
    diff.open(request);
    if (hasVersionHistory(request.path)) setHistoryPath(request.path);
    showWindow("diff");
  }, [diff, showWindow]);
  const openHistory = useCallback((path?: string) => {
    if (path && hasVersionHistory(path)) setHistoryPath(path);
    showWindow("history");
  }, [showWindow]);
  const startRewrite = useCallback((flow: RewriteFlow) => setRewrite((current) => (current.flow ? current : { key: current.key + 1, flow })), []);
  const endRewrite = useCallback(() => setRewrite((current) => ({ key: current.key, flow: null })), []);
  const requestPull = useCallback(() => startRewrite({ kind: "pull" }), [startRewrite]);
  const requestRevert = useCallback((request: RevertRequest) => {
    // An asset, or Project Settings (whose flow reloads the project); never a folder marker or another file.
    if (hasVersionHistory(request.path)) startRewrite({ kind: "revert", request });
  }, [startRewrite]);
  const requestSwitchBranch = useCallback((branch: string) => startRewrite({ kind: "switch", branch }), [startRewrite]);
  const flow = rewrite.flow;
  const value = useMemo<SourceControlActions>(() => ({
    requestPull,
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
    requestSwitchBranch,
    requestNewBranch: () => setNewBranchRequest((request) => request + 1),
    openHistory,
    historyPath,
  }), [commitRequest, historyPath, openDiff, openHistory, openSourceControl, requestPull, requestRevert, requestSwitchBranch, sync]);
  return (
    <SourceControlActionsContext.Provider value={value}>
      <SourceControlDiffContext.Provider value={diff}>
        {children}
        {flow?.kind === "pull" ? (
          <Suspense fallback={null}>
            <SourceControlPullFlow key={rewrite.key} onDone={endRewrite} onCompare={openDiff} />
          </Suspense>
        ) : null}
        {flow?.kind === "revert" ? (
          <Suspense fallback={null}>
            <SourceControlRevertFlow key={rewrite.key} request={flow.request} onDone={endRewrite} />
          </Suspense>
        ) : null}
        {flow?.kind === "switch" ? (
          <Suspense fallback={null}>
            <SourceControlBranchFlow key={rewrite.key} branch={flow.branch} onDone={endRewrite} />
          </Suspense>
        ) : null}
        {newBranchRequest > 0 ? (
          <Suspense fallback={null}>
            <NewBranchDialog key={newBranchRequest} onDone={() => setNewBranchRequest(0)} />
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

/** The shared actions, or null outside `SourceControlActionsProvider` (a Content Browser mounted on its own). */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalSourceControlActions(): SourceControlActions | null {
  return useContext(SourceControlActionsContext);
}

/** **Open History**: on the asset in the active tab, else on the asset History last showed. */
// eslint-disable-next-line react-refresh/only-export-components
export function useOpenHistory(): () => void {
  const { openHistory } = useSourceControlActions();
  const { getOpenDocuments } = useDocumentActions();
  const activeId = useActiveDocumentId();
  return useCallback(() => {
    openHistory(getOpenDocuments().find((doc) => doc.id === activeId)?.ref.path);
  }, [activeId, getOpenDocuments, openHistory]);
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
