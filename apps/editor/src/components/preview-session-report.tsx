import { Button } from "@babylonslate/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@babylonslate/ui/components/sheet";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { SelectableText } from "@babylonslate/editor-kit";
import type { SessionReportEntry } from "@babylonslate/runtime";

export interface PreviewSessionReportProps {
  open: boolean;
  entries: SessionReportEntry[];
  dropped: number;
  onOpenChange: (open: boolean) => void;
  onNavigate: (entry: SessionReportEntry) => void;
}

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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[70vh]"
        data-testid="preview-session-report"
      >
        <SheetHeader>
          <SheetTitle>Preview session report</SheetTitle>
          <SheetDescription>
            Runtime errors from the last Play session.
            {dropped > 0 ? ` (${dropped} more dropped)` : ""}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="max-h-[40vh] px-4">
          <ul className="flex flex-col gap-2 py-2">
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
        </ScrollArea>
        <SheetFooter>
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
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
