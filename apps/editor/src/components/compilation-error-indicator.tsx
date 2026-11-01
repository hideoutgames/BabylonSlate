import { Badge } from "@haptic/ui/components/badge";
import { CircleAlertIcon } from "lucide-react";

export function CompilationErrorIndicator({
  errorCount,
  onOpenResults,
}: {
  errorCount: number;
  onOpenResults: () => void;
}) {
  if (errorCount <= 0) return null;

  return (
    <Badge
      variant="destructive"
      size="lg"
      render={<button type="button" />}
      className="chrome-action-button"
      data-testid="compilation-error"
      aria-label="Compilation Error, open Compiler Results"
      onClick={onOpenResults}
    >
      <CircleAlertIcon data-icon="inline-start" aria-hidden="true" />
      Compilation Error
    </Badge>
  );
}
