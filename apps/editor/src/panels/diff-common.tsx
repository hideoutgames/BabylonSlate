import { useEffect, type ReactNode } from "react";
import type { DockviewPanelApi } from "dockview-react";
import type { DiffCounts, DiffStatus } from "@haptic/assets/asset-diff";
import { PanelFrame } from "@haptic/editor-kit";
import { Badge } from "@haptic/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { cn } from "@haptic/ui/lib/utils";
import { useSourceControlDiff } from "../components/source-control-actions";
import { useDockPanelShown } from "../lib/use-dock-panel-shown";
import type { DiffState } from "../services/source-control-diff";
import { STATUS_LABEL, STATUS_LETTER } from "./diff-status";

/**
 * Whether this window is on screen (its dock tab shown and the Source
 * Control tab in front). The open diff loads while it is; hidden, a save only
 * marks the diff stale and a graph canvas unmounts. Without a dock API
 * (tests) the window counts as shown.
 */
// The windows' shared hook lives with their shared parts.
// eslint-disable-next-line react-refresh/only-export-components
export function useDiffWindowShown(api: DockviewPanelApi | undefined): boolean {
  const diff = useSourceControlDiff();
  const shown = useDockPanelShown(api);
  useEffect(() => (shown ? diff.watch() : undefined), [diff, shown]);
  return shown;
}

const STATUS_TEXT: Record<Exclude<DiffStatus, "unchanged">, string> = {
  added: "text-(--success)",
  removed: "text-destructive",
  changed: "text-(--warning)",
};
const STATUS_BADGE = { added: "success", removed: "destructive", changed: "warning" } as const;

/** The A, M or D letter a changed item ends with, as in Changes. */
export function StatusLetter({ status }: { status: DiffStatus }) {
  if (status === "unchanged") return null;
  return (
    <span className={cn("w-3.5 shrink-0 text-center text-xs font-bold", STATUS_TEXT[status])} title={STATUS_LABEL[status]} data-diff-status={status}>
      {STATUS_LETTER[status]}
    </span>
  );
}

/** `Added`, `Removed` or `Changed`, tinted. */
export function StatusBadge({ status }: { status: DiffStatus }) {
  if (status === "unchanged") return null;
  return <Badge variant={STATUS_BADGE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** `1 Added`, `1 Removed`, `2 Changed`. */
export function DiffCountBadges({ counts }: { counts: DiffCounts }) {
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="diff-counts">
      <Badge variant="success">{counts.added} Added</Badge>
      <Badge variant="destructive">{counts.removed} Removed</Badge>
      <Badge variant="warning">{counts.changed} Changed</Badge>
    </div>
  );
}

/** What a diff window shows before there is a result: nothing chosen, the versions being read, or why they could not be compared. */
export function DiffPlaceholder({ state, testId }: { state: DiffState; testId: string }): ReactNode {
  const [title, description] = !state.target
    ? ["No Change Chosen", "Choose a change to compare its versions."]
    : state.phase === "error"
      ? [`Could Not Compare ${state.target.name}`, state.error ?? ""]
      : [`Reading ${state.target.name}…`, ""];
  return (
    <PanelFrame data-testid={testId}>
      <Empty data-testid={`${testId}-placeholder`}>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          {description ? <EmptyDescription>{description}</EmptyDescription> : null}
        </EmptyHeader>
      </Empty>
    </PanelFrame>
  );
}
