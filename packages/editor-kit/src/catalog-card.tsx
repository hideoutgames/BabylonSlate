import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@haptic/ui/components/card";
import { typeColorThumbAccent } from "@haptic/ui/lib/data-types";
import { cn } from "@haptic/ui/lib/utils";
import {
  TYPE_VISUAL_ICON_TILE_SIZE,
  TypeVisualIcon,
  type TypeVisual,
} from "./type-visuals";

export interface CatalogCardProps
  extends Omit<ComponentProps<"div">, "children" | "onClick" | "onSelect" | "title"> {
  title: string;
  subtitle?: string;
  visual: TypeVisual;
  /** Thumbnail shown in the preview well; the type icon stands in without one. */
  imageUrl?: string | null;
  /** Click, tap, Enter or Space; the event carries the modifier keys. */
  onSelect: (
    event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  /** Selected cards keep the Content Browser tile's primary border and ring. */
  selected?: boolean;
  /** `compact`: smaller icon, title only, for narrow docked panels. */
  density?: "default" | "compact";
  /** Small mark after the title, such as a plugin glyph. */
  titleAdornment?: ReactNode;
}

/** Type icon size in a compact card's well. */
export const CATALOG_CARD_COMPACT_ICON_SIZE = 28;

// `Card size="sm"` sets its title to text-sm through a group variant; override at that variant.
const CARD_TITLE = "text-xs group-data-[size=sm]/card:text-xs";
const CARD_TITLE_COMPACT = "text-[11px] group-data-[size=sm]/card:text-[11px]";

/**
 * Pickable card styled like the Content Browser asset tile: `--card` well
 * framed in the type color, then title and type line. A non-button host
 * preserves touch scrolling.
 */
export function CatalogCard({
  title,
  subtitle,
  visual,
  imageUrl,
  onSelect,
  selected = false,
  density = "default",
  titleAdornment,
  className,
  onKeyDown,
  role = "button",
  tabIndex = 0,
  ...props
}: CatalogCardProps) {
  const compact = density === "compact";
  return (
    <Card
      size="sm"
      {...props}
      role={role}
      tabIndex={tabIndex}
      title={title}
      className={cn(
        "catalog-card w-full cursor-pointer select-none gap-0 py-0 text-left outline-none transition-colors touch-pan-y",
        "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary ring-1 ring-primary",
        className,
      )}
      data-selected={selected ? "true" : undefined}
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
        onSelect(event);
      }}
    >
      <span className="relative aspect-square w-full shrink-0">
        <span
          className="absolute inset-0.5 flex items-center justify-center overflow-hidden bg-card"
          style={typeColorThumbAccent(visual.colorVar)}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              className="size-full object-cover"
              data-slot="catalog-card-image"
            />
          ) : (
            <TypeVisualIcon
              visual={visual}
              size={compact ? CATALOG_CARD_COMPACT_ICON_SIZE : TYPE_VISUAL_ICON_TILE_SIZE}
            />
          )}
        </span>
      </span>
      <CardHeader className={cn("min-h-0 w-full gap-0.5", compact ? "px-1 py-1" : "p-1.5")}>
        {titleAdornment ? (
          <span className="flex min-w-0 items-center gap-1">
            <CardTitle className={cn("min-w-0 flex-1 truncate font-medium", compact ? CARD_TITLE_COMPACT : CARD_TITLE)}>
              {title}
            </CardTitle>
            {titleAdornment}
          </span>
        ) : (
          <CardTitle className={cn("truncate font-medium", compact ? CARD_TITLE_COMPACT : CARD_TITLE)}>{title}</CardTitle>
        )}
        {subtitle ? (
          <CardDescription className="truncate text-[10px]">{subtitle}</CardDescription>
        ) : null}
      </CardHeader>
    </Card>
  );
}

/**
 * Responsive card grid; columns stay near the Content Browser tile width, or
 * near 4.5rem for `compact` cards (three across a 260px docked panel).
 */
export function CatalogCardGrid({
  label,
  children,
  density = "default",
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  label: string;
  children: ReactNode;
  density?: "default" | "compact";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      {...props}
      className={cn(
        "grid",
        density === "compact"
          ? "grid-cols-[repeat(auto-fill,minmax(min(4.5rem,100%),1fr))] gap-1.5"
          : "grid-cols-[repeat(auto-fill,minmax(min(7.5rem,100%),1fr))] gap-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
