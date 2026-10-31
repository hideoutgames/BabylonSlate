import { cn } from "@haptic/ui/lib/utils";
import { emptySquareFill } from "./pin-shape-glyph";

/**
 * Colored type swatch for pin / asset labels. Color comes from DataTypes
 * tokens. A `square` swatch (Delegate) is drawn like an unwired delegate pin:
 * its color as the border around a darker fill.
 */
export function TypeColorMark({
  colorVar,
  label,
  shape = "circle",
  className,
  "data-testid": testId,
}: {
  colorVar: string;
  label?: string;
  shape?: "circle" | "square";
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      data-testid={testId}
    >
      <span
        className={cn("size-2.5 shrink-0", shape === "square" ? "rounded-sm border-2" : "rounded-full")}
        style={
          shape === "square"
            ? { backgroundColor: emptySquareFill(colorVar), borderColor: colorVar }
            : { backgroundColor: colorVar }
        }
        data-type-color-swatch={shape}
        aria-hidden
      />
      {label ? <span>{label}</span> : null}
    </span>
  );
}
