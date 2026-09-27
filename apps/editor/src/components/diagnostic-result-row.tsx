import { SelectableText } from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";

/** A one-click fix offered on a diagnostic row. */
export interface DiagnosticRowAction {
  label: string;
  onClick: () => void;
  /** While the fix runs, so a second click cannot start it again. */
  disabled?: boolean;
}

/**
 * One 44px Compiler Results row: a ghost button (severity Badge and the
 * truncated message) that selects the row, plus an optional compact outline
 * action beside it (disabled while it runs). The action is a sibling, never
 * nested in the row button.
 */
export function DiagnosticResultRow({
  severity,
  message,
  onSelect,
  action,
  testId,
}: {
  severity: "error" | "warning";
  message: string;
  onSelect: () => void;
  action?: DiagnosticRowAction;
  /** On the row button; the action gets `${testId}-action`. */
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
      {action ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 pointer-coarse:min-h-11"
          disabled={action.disabled}
          onClick={action.onClick}
          data-testid={`${testId}-action`}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
