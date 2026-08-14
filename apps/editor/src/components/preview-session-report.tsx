import { SelectableText } from "@babylonslate/editor-kit";
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

export interface PreviewSessionReportProps {
  open: boolean;
  entries: SessionReportEntry[];
  dropped: number;
  onOpenChange: (open: boolean) => void;
  onNavigate: (entry: SessionReportEntry) => void;
}

/** Centered dialog of runtime errors from the last Play session. */
export function PreviewSessionReport({
  open,
  entries,
  dropped,
  onOpenChange,
  onNavigate,
}: PreviewSessionReportProps) {
  const copyReport = async () => {
    const text = entries
      .map(
        (e) =>
          `[${e.severity}] ${e.code} x${e.count} ${e.message}` +
          (e.nodeId ? ` @ ${e.assetGuid ?? ""}/${e.nodeId}` : ""),
      )
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
        <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
          {entries.map((entry) => (
            <li key={`${entry.code}-${entry.assetGuid}-${entry.nodeId}`}>
              <button
                type="button"
                className="flex min-h-11 w-full flex-col items-start gap-1 rounded-md border border-border px-3 py-2 text-left"
                data-testid="session-report-row"
                data-node-id={entry.btNodeId ?? entry.nodeId ?? ""}
                onClick={() => onNavigate(entry)}
              >
                <span className="text-sm font-medium">
                  {entry.severity}: {entry.message}
                  {entry.count > 1 ? ` ×${entry.count}` : ""}
                </span>
                <SelectableText className="text-xs text-muted-foreground">
                  {entry.assetGuid ?? "unknown"}
                  {entry.btNodeId
                    ? ` › ${entry.btNodeId}`
                    : entry.nodeId
                      ? ` › ${entry.nodeId}`
                      : ""}
                </SelectableText>
              </button>
            </li>
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
