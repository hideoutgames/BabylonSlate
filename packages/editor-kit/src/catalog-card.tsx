import type { ComponentProps, ReactNode } from "react";
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
  /** Thumbnail shown in the preview well; the tinted type icon stands in without one. */
  imageUrl?: string | null;
  onSelect: () => void;
}

/** Preview card for catalog pages. A non-button host preserves touch scrolling. */
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
    <div
      {...props}
      role={role}
      tabIndex={tabIndex}
      title={title}
      className={cn(
        "catalog-card flex min-w-0 cursor-pointer select-none flex-col overflow-hidden rounded-lg border bg-card text-left outline-none transition-colors touch-pan-y",
        "hover:border-ring/50 hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
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
        className="flex aspect-[4/3] items-center justify-center overflow-hidden"
        style={{
          backgroundColor: `color-mix(in oklab, ${visual.colorVar} 10%, var(--muted))`,
        }}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            className="size-full object-contain"
            data-slot="catalog-card-image"
          />
        ) : (
          <TypeVisualIcon visual={visual} size={TYPE_VISUAL_ICON_TILE_SIZE} />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 border-t px-2 py-1.5 leading-tight">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {subtitle ? (
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
      </span>
    </div>
  );
}

/** Responsive card grid. */
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
      className="grid grid-cols-[repeat(auto-fill,minmax(min(8rem,100%),1fr))] gap-2"
    >
      {children}
    </div>
  );
}
