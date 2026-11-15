import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@haptic/ui/components/dropdown-menu";
import { Progress } from "@haptic/ui/components/progress";
import { useIntegratedSyncState, useSaveState } from "../context/document-context";
import { useValidation } from "../context/validation-context";
import { getBuildLabel } from "../lib/build-identity";
import { changesLabel, commitsLabel, transferLabel } from "../lib/source-control-labels";
import type { SyncSnapshot } from "../services/source-control-sync";
import { usePhoneLayout } from "../shell/use-platform-layout";
import { useSourceControlActions } from "./source-control-actions";

function saveStateLabel(unsaved: number, projectDirty: boolean, unrecovered: boolean): string {
  if (unsaved > 0)
    return `${unsaved} Unsaved ${unsaved === 1 ? "Document" : "Documents"}`;
  if (projectDirty) return "Unsaved Project Changes";
  return unrecovered ? "Unrecovered Edits" : "All Changes Saved";
}

/** The save state, or null when everything is saved (Integrated mode then shows a small Saved). */
function saveProblemLabel(
  autoSave: ReturnType<typeof useSaveState>["autoSaveStatus"],
  unsaved: number,
  projectDirty: boolean,
  unrecovered: boolean,
): string | null {
  if (autoSave?.state === "saving") return "Auto-Saving…";
  if (autoSave?.state === "error") return "Auto-Save Failed — Use Save All";
  if (unsaved > 0 || projectDirty || unrecovered) return saveStateLabel(unsaved, projectDirty, unrecovered);
  return null;
}

/** Integrated mode leads the status bar: the branch menu, the change count, and Pull and Push (or the running transfer). */
function SourceControlStatus({ snapshot }: { snapshot: SyncSnapshot }) {
  const actions = useSourceControlActions();
  const count = snapshot.rows.length;
  const transfer = snapshot.operation && snapshot.operation.kind !== "fetch" && snapshot.operation.kind !== "commit"
    ? transferLabel(snapshot)
    : null;
  const busy = snapshot.operation !== null && snapshot.operation.kind !== "fetch";
  return (
    <div className="editor-status-source-control" data-testid="status-source-control">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="editor-status-button"
              aria-label={`Source Control Menu: Branch ${snapshot.branch}`}
              data-testid="status-source-control-menu"
            />
          }
        >
          <GitBranchIcon data-icon="inline-start" />
          {snapshot.branch}
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-52">
          <DropdownMenuGroup>
            <DropdownMenuItem data-testid="status-source-control-commit" disabled={busy} onClick={actions.requestCommit}>
              <GitCommitHorizontalIcon />
              Commit…
              <DropdownMenuShortcut>{changesLabel(count)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="status-source-control-pull" disabled={busy} onClick={actions.requestPull}>
              <ArrowDownToLineIcon />
              Pull
              <DropdownMenuShortcut>{commitsLabel(snapshot.behind)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="status-source-control-push" disabled={busy || snapshot.ahead === 0} onClick={() => void actions.push()}>
              <ArrowUpFromLineIcon />
              Push
              <DropdownMenuShortcut>{commitsLabel(snapshot.ahead)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="status-source-control-refresh" disabled={snapshot.operation !== null} onClick={() => void actions.refresh()}>
              <RefreshCwIcon />
              Refresh
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem data-testid="status-source-control-open" onClick={actions.openSourceControl}>
              <PanelRightOpenIcon />
              Open Source Control
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="editor-status-separator" aria-hidden="true" />
      <Button variant="ghost" size="xs" className="editor-status-button" data-testid="status-source-control-changes" onClick={actions.openSourceControl}>
        {count > 0 ? <span className="editor-status-dot" aria-hidden="true" /> : null}
        {changesLabel(count)}
      </Button>
      {transfer ? (
        <span role="status" className="editor-status-transfer" data-testid="status-source-control-transfer">
          <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          {transfer}
          <Progress value={null} aria-label={transfer} className="editor-status-progress" />
        </span>
      ) : (
        <>
          {snapshot.behind > 0 ? (
            <Button variant="ghost" size="xs" className="editor-status-button" data-testid="status-source-control-pull-button" disabled={busy} onClick={actions.requestPull}>
              <ArrowDownToLineIcon data-icon="inline-start" />
              Pull {snapshot.behind}
            </Button>
          ) : null}
          {snapshot.ahead > 0 ? (
            <Button variant="ghost" size="xs" className="editor-status-button" data-testid="status-source-control-push-button" disabled={busy} onClick={() => void actions.push()}>
              <ArrowUpFromLineIcon data-icon="inline-start" />
              Push {snapshot.ahead}
            </Button>
          ) : null}
        </>
      )}
      {snapshot.problem && !transfer ? (
        // What failed (a refused push names the lock holders in Changes), wherever it was started.
        <Button variant="ghost" size="xs" className="editor-status-button" title={snapshot.problem.message} data-testid="status-source-control-problem" onClick={actions.openSourceControl}>
          <CircleAlertIcon data-icon="inline-start" className="text-destructive" />
          {snapshot.problem.title}
        </Button>
      ) : null}
    </div>
  );
}

export function EditorStatusBar() {
  const { dirtyDocuments, projectDirty, autoSaveStatus, recoveryAvailable } = useSaveState();
  const { errorCount } = useValidation();
  const sync = useIntegratedSyncState();
  const phone = usePhoneLayout();
  if (phone) return null;
  // Edits waiting for Recover or Discard are not saved either.
  const dirty = dirtyDocuments.length > 0 || projectDirty || recoveryAvailable;
  const errors = errorCount > 0 ? (
    <span className="editor-status-errors">
      <CircleAlertIcon aria-hidden="true" />
      {errorCount} {errorCount === 1 ? "Error" : "Errors"}
    </span>
  ) : null;
  if (sync.active) {
    const problem = saveProblemLabel(autoSaveStatus, dirtyDocuments.length, projectDirty, recoveryAvailable);
    return (
      <footer className="editor-statusbar" data-testid="editor-status-bar" data-source-control="integrated">
        <SourceControlStatus snapshot={sync} />
        <p className="editor-status-summary">
          {errors}
          {problem ? (
            <span role="status" title={autoSaveStatus?.message}>{problem}</span>
          ) : (
            <span role="status" className="editor-status-saved" title={autoSaveStatus?.state === "saved" ? "All Changes Auto-Saved" : "All Changes Saved"}>
              <CheckIcon aria-hidden="true" />
              Saved
            </span>
          )}
          <span className="editor-status-version">{getBuildLabel()}</span>
        </p>
      </footer>
    );
  }
  return (
    <footer className="editor-statusbar" data-testid="editor-status-bar">
      <p className="editor-status-summary">
        <span role="status" title={autoSaveStatus?.message}>
          {autoSaveStatus?.state === "saving"
            ? "Auto-Saving…"
            : autoSaveStatus?.state === "error"
              ? "Auto-Save Failed — Use Save All"
              : autoSaveStatus?.state === "saved" && !dirty
                ? "All Changes Auto-Saved"
                : saveStateLabel(dirtyDocuments.length, projectDirty, recoveryAvailable)}
        </span>
        {errors}
      </p>
      <span className="editor-status-version">{getBuildLabel()}</span>
    </footer>
  );
}
