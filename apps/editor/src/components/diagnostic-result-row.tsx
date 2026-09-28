import { CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";

/**
 * One 44px Compiler Results row: a ghost button with a severity icon, the
 * truncated message, and an optional mono code / location line.
 */
export function DiagnosticResultRow({
  severity,
  message,
  code,
  location,
  selected = false,
  onSelect,
  testId,
}: {
  severity: "error" | "warning";
  message: string;
  code?: string;
  /** Node or pin the diagnostic points at. */
  location?: string;
  selected?: boolean;
  onSelect: () => void;
  /** On the row button. */
  testId: string;
}) {
  const Icon = severity === "error" ? CircleXIcon : TriangleAlertIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="touch"
      className={cn(
        "h-full min-h-0 w-full min-w-0 justify-start gap-2 overflow-hidden rounded-none px-2 text-left font-normal",
        selected && "bg-accent text-accent-foreground hover:bg-accent",
      )}
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={testId}
      data-severity={severity}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          severity === "error" ? "text-destructive" : "text-(--warning)",
        )}
      />
      <span className="sr-only">{severity === "error" ? "Error" : "Warning"}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SelectableText className="truncate text-xs leading-4 text-foreground">
          {message}
        </SelectableText>
        {code || location ? (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-3.5 text-muted-foreground">
            {code ? <span className="shrink-0">{code}</span> : null}
            {code && location ? <span aria-hidden="true">·</span> : null}
            {location ? <span className="truncate">{location}</span> : null}
          </span>
        ) : null}
      </span>
    </Button>
  );
}
