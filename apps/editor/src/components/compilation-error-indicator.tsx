import { Badge } from "@babylonslate/ui/components/badge";

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
      render={<button type="button" />}
      data-testid="compilation-error"
      aria-label="Compilation Error, open Compiler Results"
      onClick={onOpenResults}
    >
      Compilation Error
    </Badge>
  );
}
