import { SelectableText } from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";

/**
 * One 44px Compiler Results row: a ghost button (severity Badge and the
 * truncated message) that selects the row.
 */
export function DiagnosticResultRow({
  severity,
  message,
  onSelect,
  testId,
}: {
  severity: "error" | "warning";
  message: string;
  onSelect: () => void;
  /** On the row button. */
  testId: string;
}) {
  return (
    <div className="flex h-full min-w-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="touch"
        className="h-full min-h-0 min-w-0 flex-1 justify-start gap-2 overflow-hidden text-left"
        onClick={onSelect}
        data-testid={testId}
        data-severity={severity}
      >
        <Badge variant={severity === "error" ? "destructive" : "secondary"}>
          {severity}
        </Badge>
        <SelectableText className="truncate">{message}</SelectableText>
      </Button>
    </div>
  );
}
