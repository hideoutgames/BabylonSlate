import type { ComponentProps, ReactNode } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { typeColorThumbAccent } from "@babylonslate/ui/lib/data-types";
import { cn } from "@babylonslate/ui/lib/utils";
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
  onSelect: () => void;
}

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
  className,
  onKeyDown,
  role = "button",
  tabIndex = 0,
  ...props
}: CatalogCardProps) {
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
            <TypeVisualIcon visual={visual} size={TYPE_VISUAL_ICON_TILE_SIZE} />
          )}
        </span>
      </span>
      <CardHeader className="min-h-0 w-full gap-0.5 p-1.5">
        <CardTitle className="truncate text-xs font-medium">{title}</CardTitle>
        {subtitle ? (
          <CardDescription className="truncate text-[10px]">{subtitle}</CardDescription>
        ) : null}
      </CardHeader>
    </Card>
  );
}

/** Responsive card grid; columns stay near the Content Browser tile width. */
export function CatalogCardGrid({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fill,minmax(min(7.5rem,100%),1fr))] gap-2"
    >
      {children}
    </div>
  );
}
