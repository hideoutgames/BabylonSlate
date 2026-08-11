import { Button } from "@babylonslate/ui/components/button";
import { SelectableText } from "@babylonslate/editor-kit";
import type { SessionReportEntry } from "@babylonslate/runtime";

export interface PreviewSessionReportProps {
  open: boolean;
  entries: SessionReportEntry[];
  dropped: number;
  onOpenChange: (open: boolean) => void;
  onNavigate: (entry: SessionReportEntry) => void;
}

/**
 * Bottom-sheet style report (fixed panel). Avoids animated Sheet portals that
 * can leave interactive rows outside the layout viewport in Playwright.
 */
export function PreviewSessionReport({
  open,
  entries,
  dropped,
  onOpenChange,
  onNavigate,
}: PreviewSessionReportProps) {
  if (!open) return null;

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
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 border-t border-border bg-popover p-4 text-popover-foreground shadow-lg"
      data-testid="preview-session-report"
      role="dialog"
      aria-label="Preview session report"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-base font-medium">
          Preview session report
        </h2>
        <p className="text-sm text-muted-foreground">
          Runtime errors from the last Play session.
          {dropped > 0 ? ` (${dropped} more dropped)` : ""}
        </p>
      </div>
      <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
        {entries.map((entry) => (
          <li key={`${entry.code}-${entry.assetGuid}-${entry.nodeId}`}>
            <button
              type="button"
              className="flex min-h-11 w-full flex-col items-start gap-1 rounded-md border border-border px-3 py-2 text-left"
              data-testid="session-report-row"
              data-node-id={entry.nodeId ?? ""}
              onClick={() => onNavigate(entry)}
            >
              <span className="text-sm font-medium">
                {entry.severity}: {entry.message}
                {entry.count > 1 ? ` ×${entry.count}` : ""}
              </span>
              <SelectableText className="text-xs text-muted-foreground">
                {entry.assetGuid ?? "unknown"}
                {entry.nodeId ? ` › ${entry.nodeId}` : ""}
              </SelectableText>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          data-testid="session-report-copy"
          onClick={() => void copyReport()}
        >
          Copy report
        </Button>
        <Button
          data-testid="session-report-close"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      </div>
    </div>
  );
}
