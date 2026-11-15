import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  HistoryIcon,
  PanelRightOpenIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@haptic/ui/components/dropdown-menu";
import { useIntegratedSync, useIntegratedSyncState } from "../context/document-context";
import { useTouchUi } from "@haptic/editor-kit";
import { useOpenHistory, useSourceControlActions } from "./source-control-actions";
import { BranchMenuItems } from "./source-control-branch-menu";

/**
 * The phone layout has no status bar, so More Tools carries its Source
 * Control menu (Integrated mode only). `onAction` closes the sheet.
 */
export function SourceControlPhoneTools({ onAction }: { onAction: () => void }) {
  const sync = useIntegratedSyncState();
  if (!sync.active) return null;
  return (
    <PhoneTools
      branch={sync.branch}
      behind={sync.behind}
      ahead={sync.ahead}
      changes={sync.rows.length}
      busy={sync.operation !== null && sync.operation.kind !== "fetch"}
      committed={sync.head !== null}
      onAction={onAction}
    />
  );
}

function PhoneTools({ branch, behind, ahead, changes, busy, committed, onAction }: {
  branch: string;
  behind: number;
  ahead: number;
  changes: number;
  busy: boolean;
  /** The branch has a commit, so a new branch can start from it. */
  committed: boolean;
  onAction: () => void;
}) {
  const actions = useSourceControlActions();
  const openHistory = useOpenHistory();
  const sync = useIntegratedSync();
  const touch = useTouchUi();
  const size = touch ? "touch" : "sm";
  const run = (action: () => void | Promise<void>) => () => {
    onAction();
    // With no status bar, a failure shows where its reason is: the Changes window.
    void Promise.resolve(action()).then(() => {
      if (sync.getSnapshot().problem) actions.openSourceControl();
    });
  };
  return (
    <>
      <Button variant="outline" size={size} data-testid="phone-source-control-commit" disabled={busy} onClick={run(actions.requestCommit)}>
        <GitCommitHorizontalIcon data-icon="inline-start" />
        Commit… ({changes})
      </Button>
      <Button variant="outline" size={size} data-testid="phone-source-control-pull" disabled={busy} onClick={run(actions.requestPull)}>
        <ArrowDownToLineIcon data-icon="inline-start" />
        Pull{behind > 0 ? ` ${behind}` : ""}
      </Button>
      <Button variant="outline" size={size} data-testid="phone-source-control-push" disabled={busy || ahead === 0} onClick={run(actions.push)}>
        <ArrowUpFromLineIcon data-icon="inline-start" />
        Push{ahead > 0 ? ` ${ahead}` : ""}
      </Button>
      <Button variant="outline" size={size} data-testid="phone-source-control-refresh" disabled={busy} onClick={run(actions.refresh)}>
        <RefreshCwIcon data-icon="inline-start" />
        Refresh
      </Button>
      {/* The sheet stays open under the menu; choosing a branch closes it as the other actions do. */}
      <DropdownMenu onOpenChange={(open, details) => { if (!open && details.reason === "item-press") onAction(); }}>
        <DropdownMenuTrigger render={<Button variant="outline" size={size} data-testid="phone-source-control-switch-branch" disabled={busy} />}>
          <GitBranchIcon data-icon="inline-start" />
          Switch Branch ({branch})
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <BranchMenuItems testId="phone-source-control" />
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size={size} data-testid="phone-source-control-new-branch" disabled={busy || !committed} onClick={run(actions.requestNewBranch)}>
        <PlusIcon data-icon="inline-start" />
        New Branch…
      </Button>
      <Button variant="outline" size={size} data-testid="phone-source-control-open" onClick={run(actions.openSourceControl)}>
        <PanelRightOpenIcon data-icon="inline-start" />
        Open Source Control
      </Button>
      <Button variant="outline" size={size} data-testid="phone-source-control-history" onClick={run(openHistory)}>
        <HistoryIcon data-icon="inline-start" />
        Open History
      </Button>
    </>
  );
}
