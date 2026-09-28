import type { ComponentProps, ReactNode } from "react";
import { cn } from "@babylonslate/ui/lib/utils";
import { TypeVisualIcon, type TypeVisual } from "./type-visuals";

export interface CatalogTileProps
  extends Omit<ComponentProps<"div">, "children" | "onClick" | "onSelect" | "title"> {
  title: string;
  description?: string;
  visual: TypeVisual;
  onSelect: () => void;
}

/** Catalog grid card. A non-button host preserves touch scrolling. */
export function CatalogTile({
  title,
  description,
  visual,
  onSelect,
  className,
  onKeyDown,
  role = "button",
  tabIndex = 0,
  ...props
}: CatalogTileProps) {
  return (
    <div
      {...props}
      role={role}
      tabIndex={tabIndex}
      title={description ? `${title}: ${description}` : title}
      className={cn(
        "catalog-tile group/tile flex min-h-9 min-w-0 cursor-pointer select-none items-center gap-2.5 rounded-md border border-border/70 bg-card px-2 py-1.5 text-left outline-none transition-colors touch-pan-y",
        "hover:border-border hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:border-primary aria-pressed:bg-accent",
        className,
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        onSelect();
      }}
    >
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-md"
        style={{
          backgroundColor: `color-mix(in oklab, ${visual.colorVar} 16%, transparent)`,
        }}
      >
        <TypeVisualIcon visual={visual} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Headed responsive grid of CatalogTiles; `hideLabel` keeps the name for assistive tech only. */
export function CatalogTileGroup({
  label,
  count,
  hideLabel = false,
  minTileWidth = "12rem",
  children,
  "data-testid": testId,
}: {
  label: string;
  count?: number;
  hideLabel?: boolean;
  /** Narrowest column before the grid wraps; widen it for tiles with descriptions. */
  minTileWidth?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      {!hideLabel ? (
        <h3 className="flex items-baseline gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
          <span>{label}</span>
          {typeof count === "number" ? (
            <span className="tabular-nums text-muted-foreground/70">{count}</span>
          ) : null}
        </h3>
      ) : null}
      <div
        role="group"
        aria-label={label}
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(min(${minTileWidth}, 100%), 1fr))`,
        }}
      >
        {children}
      </div>
    </section>
  );
}
