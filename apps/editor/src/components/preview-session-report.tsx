import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import type { SessionReportEntry } from "@babylonslate/runtime";
import {
  EMPTY_SESSION_REPORT_LABELS,
  NO_SOURCE_LABEL,
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
import {
  sessionReportNavigation,
  type SessionReportNavigationResult,
} from "../services/diagnostic-navigation";
import { usePhoneLayout } from "../shell/use-platform-layout";
import { DiagnosticResultRow } from "./diagnostic-result-row";

export interface PreviewSessionReportProps {
  open: boolean;
  entries: SessionReportEntry[];
  dropped: number;
  onOpenChange: (open: boolean) => void;
  /**
   * Opens the entry's source. The report stays open; a result that did not
   * open shows its message in the report.
   */
  onNavigate: (
    entry: SessionReportEntry,
  ) => Promise<SessionReportNavigationResult | void> | SessionReportNavigationResult | void;
  /** Resolves asset names and node titles; without it rows show raw ids. */
  locationSources?: SessionReportLocationSources;
}

const NO_GROUPS: ReadonlySet<string> = new Set();

/**
 * Desktop and tablet placement: the top right under the toolbar, clear of the
 * canvas centre where a navigated node is framed. Inline because
 * `.editor-dialog` positions every dialog from the viewport centre.
 */
const ANCHORED_FRAME: CSSProperties = {
  top: "calc(var(--safe-top) + 5rem)",
  right: "calc(var(--safe-right) + 0.5rem)",
  left: "auto",
  width: "min(26rem, calc(100vw - var(--safe-left) - var(--safe-right) - 1rem))",
  maxHeight: "min(32rem, calc(100dvh - var(--safe-top) - var(--safe-bottom) - 6rem))",
};

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
  hasSource,
  onNavigate,
}: {
  group: SessionReportGroup;
  labels: SessionReportLabels;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  hasSource: (entry: SessionReportEntry) => boolean;
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
          {group.entries.map((entry, index) => (
            <li
              key={`${index}-${entry.code}-${entry.nodeId}-${entry.btNodeId}`}
              className="h-11"
            >
              <DiagnosticResultRow
                severity={entry.severity}
                message={
                  entry.count > 1 ? `${entry.message} ×${entry.count}` : entry.message
                }
                code={entry.code}
                location={
                  hasSource(entry)
                    ? sessionReportLocationLabel(labels, entry)
                    : NO_SOURCE_LABEL
                }
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
 * Nonmodal panel of runtime errors from the last Play session, grouped by
 * owning asset. Groups start collapsed; a row opens its asset at the node and
 * leaves the report open, so the editor stays usable beside it. Only Close,
 * the title-bar close and Escape pressed inside the report dismiss it.
 */
export function PreviewSessionReport({
  open,
  entries,
  dropped,
  onOpenChange,
  onNavigate,
  locationSources,
}: PreviewSessionReportProps) {
  const phone = usePhoneLayout();
  const frameRef = useRef<HTMLDivElement>(null);
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

  // Why the last chosen row opened nothing; it belongs to one report too.
  const [notice, setNotice] = useState<{
    entries: SessionReportEntry[];
    message: string;
  } | null>(null);
  const navigation = useRef(0);
  const navigate = async (entry: SessionReportEntry) => {
    const request = ++navigation.current;
    let result: SessionReportNavigationResult | void;
    try {
      result = await onNavigate(entry);
    } catch (error) {
      result = { opened: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (request !== navigation.current) return;
    setNotice(result && !result.opened ? { entries, message: result.message } : null);
  };
  const message = notice?.entries === entries ? notice.message : null;

  // Without sources an entry's asset cannot be resolved, so only an entry that names none is known to lack one.
  const hasSource = (entry: SessionReportEntry) =>
    locationSources
      ? sessionReportNavigation(entry, (ref) => locationSources.findAsset(ref)).document !== undefined
      : Boolean(entry.assetGuid);

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
    // No backdrop and no focus trap: the editor behind stays visible and
    // usable, and a press outside never dismisses the report.
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        // Escape belongs to whatever has the keyboard: pressed in a graph or the
        // viewport (cancelling a wire, clearing a selection, closing a menu) it
        // must reach the editor, so it closes the report only from inside it.
        if (
          !next &&
          details.reason === "escape-key" &&
          !frameRef.current?.contains(document.activeElement)
        ) {
          details.cancel();
          details.allowPropagation();
          return;
        }
        onOpenChange(next);
      }}
      modal={false}
      disablePointerDismissal
    >
      <DialogContent
        ref={frameRef}
        className={
          phone
            ? "max-h-[min(32rem,80vh)] w-full sm:max-w-lg"
            : "max-w-none translate-x-0 translate-y-0 sm:max-w-none"
        }
        style={phone ? undefined : ANCHORED_FRAME}
        showOverlay={false}
        bodyClassName="flex flex-col gap-3"
        data-testid="preview-session-report"
      >
        <DialogHeader>
          <DialogTitle>Preview Session Report</DialogTitle>
          <DialogDescription>
            Runtime errors from the last Play session. Select an entry to open its source.
            {dropped > 0 ? ` (${dropped} more dropped)` : ""}
          </DialogDescription>
        </DialogHeader>
        {groups.length === 0 ? (
          <Empty className="flex-none gap-2 rounded-md border border-border p-3" data-testid="session-report-empty">
            <EmptyHeader>
              <EmptyTitle>No Entries</EmptyTitle>
              <EmptyDescription>The last session reported no errors or warnings.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex min-h-0 flex-1 touch-pan-y flex-col overflow-y-auto overscroll-y-contain rounded-md border border-border">
            {groups.map((group) => (
              <SessionReportGroupSection
                key={group.assetRef}
                group={group}
                labels={labels}
                expanded={expanded.has(group.assetRef)}
                onExpandedChange={(next) => setGroupExpanded(group.assetRef, next)}
                hasSource={hasSource}
                onNavigate={(entry) => void navigate(entry)}
              />
            ))}
          </ul>
        )}
        {message ? (
          <Alert data-testid="session-report-notice">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
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
