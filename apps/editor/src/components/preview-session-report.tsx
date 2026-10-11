import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import type { SessionReportEntry } from "@babylonslate/runtime";
import {
  EMPTY_SESSION_REPORT_LABELS,
  groupSessionReportEntries,
  resolveSessionReportLabels,
  sessionReportAssetLabel,
  sessionReportLocationLabel,
  sessionReportNodeId,
  type SessionReportGroup,
  type SessionReportLabels,
  type SessionReportLocationCache,
  type SessionReportLocationSources,
} from "../lib/session-report-locations";
import { DiagnosticResultRow } from "./diagnostic-result-row";

export interface PreviewSessionReportProps {
  open: boolean;
  entries: SessionReportEntry[];
  dropped: number;
  onOpenChange: (open: boolean) => void;
  onNavigate: (entry: SessionReportEntry) => void;
  /** Resolves asset names and node titles; without it rows show raw ids. */
  locationSources?: SessionReportLocationSources;
}

const NO_GROUPS: ReadonlySet<string> = new Set();

/**
 * Names for the open report, resolved once per report: open documents
 * supply their working content and closed assets are read on demand.
 */
function useSessionReportLabels(
  open: boolean,
  entries: SessionReportEntry[],
  sources: SessionReportLocationSources | undefined,
): SessionReportLabels {
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const hasSources = sources != null;
  const cache = useMemo<SessionReportLocationCache>(() => {
    void entries;
    return new Map();
  }, [entries]);
  const [resolved, setResolved] = useState<{
    entries: SessionReportEntry[];
    labels: SessionReportLabels;
  } | null>(null);
  useEffect(() => {
    const current = sourcesRef.current;
    if (!open || !current) return;
    let live = true;
    void resolveSessionReportLabels(entries, current, cache).then(
      (labels) => {
        if (live) setResolved({ entries, labels });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [cache, entries, hasSources, open]);
  return resolved?.entries === entries
    ? resolved.labels
    : EMPTY_SESSION_REPORT_LABELS;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function SessionReportGroupSection({
  group,
  labels,
  expanded,
  onExpandedChange,
  onNavigate,
}: {
  group: SessionReportGroup;
  labels: SessionReportLabels;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onNavigate: (entry: SessionReportEntry) => void;
}) {
  const listId = useId();
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <li
      className="flex flex-col border-b border-border last:border-b-0"
      data-testid="session-report-group"
      data-asset-ref={group.assetRef}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full min-w-0 justify-start gap-2 rounded-none px-2 font-normal pointer-coarse:min-h-11"
        aria-expanded={expanded}
        aria-controls={listId}
        data-testid="session-report-group-toggle"
        onClick={() => onExpandedChange(!expanded)}
      >
        <Chevron data-icon="inline-start" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
          {sessionReportAssetLabel(labels, group.assetRef || undefined)}
        </span>
        <span
          className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums"
          data-testid="session-report-group-counts"
        >
          {group.errors > 0 ? (
            <span className="text-destructive">{plural(group.errors, "Error")}</span>
          ) : null}
          {group.warnings > 0 ? (
            <span className="text-(--warning)">{plural(group.warnings, "Warning")}</span>
          ) : null}
        </span>
      </Button>
      {expanded ? (
        <ul id={listId} className="flex flex-col">
          {group.entries.map((entry) => (
            <li
              key={`${entry.code}-${entry.assetGuid}-${entry.nodeId}-${entry.btNodeId}`}
              className="h-11"
            >
              <DiagnosticResultRow
                severity={entry.severity}
                message={
                  entry.count > 1 ? `${entry.message} ×${entry.count}` : entry.message
                }
                code={entry.code}
                location={sessionReportLocationLabel(labels, entry)}
                nodeId={sessionReportNodeId(entry) ?? ""}
                testId="session-report-row"
                onSelect={() => onNavigate(entry)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Centered dialog of runtime errors from the last Play session, grouped by
 * owning asset. Groups start collapsed; a row opens its asset at the node.
 */
export function PreviewSessionReport({
  open,
  entries,
  dropped,
  onOpenChange,
  onNavigate,
  locationSources,
}: PreviewSessionReportProps) {
  const labels = useSessionReportLabels(open, entries, locationSources);
  const groups = useMemo(() => groupSessionReportEntries(entries), [entries]);
  // Expansion belongs to one report; a new report starts collapsed.
  const [expansion, setExpansion] = useState<{
    entries: SessionReportEntry[];
    refs: ReadonlySet<string>;
  }>({ entries, refs: NO_GROUPS });
  const expanded = expansion.entries === entries ? expansion.refs : NO_GROUPS;
  const setGroupExpanded = (assetRef: string, next: boolean) => {
    const refs = new Set(expanded);
    if (next) refs.add(assetRef);
    else refs.delete(assetRef);
    setExpansion({ entries, refs });
  };

  const copyReport = async () => {
    const text = entries
      .map((e) => {
        const nodeId = sessionReportNodeId(e);
        return (
          `[${e.severity}] ${e.code} x${e.count} ${e.message}` +
          (e.assetGuid || nodeId
            ? ` @ ${sessionReportLocationLabel(labels, e)} (${e.assetGuid ?? ""}${nodeId ? `/${nodeId}` : ""})`
            : "")
        );
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(32rem,80vh)] w-full flex-col gap-3 sm:max-w-lg"
        data-testid="preview-session-report"
      >
        <DialogHeader>
          <DialogTitle>Preview Session Report</DialogTitle>
          <DialogDescription>
            Runtime errors from the last Play session.
            {dropped > 0 ? ` (${dropped} more dropped)` : ""}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex min-h-0 flex-1 touch-pan-y flex-col overflow-y-auto overscroll-y-contain rounded-md border border-border">
          {groups.map((group) => (
            <SessionReportGroupSection
              key={group.assetRef}
              group={group}
              labels={labels}
              expanded={expanded.has(group.assetRef)}
              onExpandedChange={(next) => setGroupExpanded(group.assetRef, next)}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
        <DialogFooter>
          <Button
            variant="secondary"
            data-testid="session-report-copy"
            onClick={() => void copyReport()}
          >
            Copy Report
          </Button>
          <Button
            data-testid="session-report-close"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
