import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  GitCommitHorizontalIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { useIntegratedSync, useIntegratedSyncState } from "../context/document-context";
import { useTouchUi } from "@haptic/editor-kit";
import { useSourceControlActions } from "./source-control-actions";

/**
 * The phone layout has no status bar, so More Tools carries its Source
 * Control menu (Integrated mode only). `onAction` closes the sheet.
 */
export function SourceControlPhoneTools({ onAction }: { onAction: () => void }) {
  const sync = useIntegratedSyncState();
  if (!sync.active) return null;
  return <PhoneTools behind={sync.behind} ahead={sync.ahead} changes={sync.rows.length} busy={sync.operation !== null && sync.operation.kind !== "fetch"} onAction={onAction} />;
}

function PhoneTools({ behind, ahead, changes, busy, onAction }: { behind: number; ahead: number; changes: number; busy: boolean; onAction: () => void }) {
  const actions = useSourceControlActions();
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
      <Button variant="outline" size={size} data-testid="phone-source-control-open" onClick={run(actions.openSourceControl)}>
        <PanelRightOpenIcon data-icon="inline-start" />
        Open Source Control
      </Button>
    </>
  );
}
