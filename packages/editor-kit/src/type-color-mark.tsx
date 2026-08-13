import { cn } from "@babylonslate/ui/lib/utils";

/** Colored type swatch for pin / asset labels. Color comes from DataTypes tokens. */
export function TypeColorMark({
  colorVar,
  label,
  className,
  "data-testid": testId,
}: {
  colorVar: string;
  label?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      data-testid={testId}
    >
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: colorVar }}
        data-type-color-swatch
        aria-hidden
      />
      {label ? <span>{label}</span> : null}
    </span>
  );
}
