import { cn } from "@babylonslate/ui/lib/utils";

export type PinShape = "diamond" | "circle" | "list" | "map";

const LIST_ROWS = [3, 9, 15] as const;

export function pinShapeForContainer(
  container?: string | null,
): PinShape {
  if (container === "array") return "list";
  if (container === "map") return "map";
  return "circle";
}

/** Shared Array list-bars / Map key-value glyph used on pins and variable type chrome. */
export function PinShapeGlyph({
  shape,
  connected = false,
  color,
  size,
  className,
  "data-testid": testId,
  "data-icon": dataIcon,
}: {
  shape: PinShape;
  connected?: boolean;
  color?: string;
  size?: string | number;
  className?: string;
  "data-testid"?: string;
  "data-icon"?: string;
}) {
  const dimension = size ?? "1em";
  const styleSize = typeof dimension === "number" ? `${dimension}px` : dimension;

  if (shape === "list" || shape === "map") {
    const bars =
      shape === "list"
        ? LIST_ROWS.map((y) => ({ x: 2, y, width: 18 }))
        : LIST_ROWS.flatMap((y) => [
            { x: 2, y, width: 8 },
            { x: 12, y, width: 8 },
          ]);
    return (
      <svg
        className={cn("block", className)}
        data-pin-shape={shape}
        data-pin-connected={connected ? "true" : "false"}
        data-testid={testId}
        data-icon={dataIcon}
        viewBox="0 0 22 22"
        aria-hidden="true"
        style={{ width: styleSize, height: styleSize, color }}
      >
        {bars.map((bar) => (
          <rect
            key={`${bar.x}-${bar.y}`}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={4}
            rx={1}
            fill={connected ? "currentColor" : "transparent"}
            stroke={connected ? "var(--card)" : "currentColor"}
            strokeWidth={2}
          />
        ))}
      </svg>
    );
  }

  return (
    <span
      className={cn(
        "block border-2",
        connected ? "border-card" : "",
        shape === "diamond" ? "rotate-45 rounded-sm" : "rounded-full",
        className,
      )}
      data-pin-shape={shape}
      data-pin-connected={connected ? "true" : "false"}
      data-testid={testId}
      data-icon={dataIcon}
      aria-hidden="true"
      style={{
        width: styleSize,
        height: styleSize,
        background: connected ? color : "transparent",
        borderColor: connected ? undefined : color,
      }}
    />
  );
}
