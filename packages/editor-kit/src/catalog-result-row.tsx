import type { ComponentProps, ReactNode } from "react";
import { buttonVariants } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";

export interface CatalogResultRowProps
  extends Omit<ComponentProps<"div">, "children" | "onClick" | "onSelect" | "title"> {
  title: string;
  description?: string;
  leading?: ReactNode;
  active?: boolean;
  striped?: boolean;
  /**
   * `default`: 44px with the description on a second line. `compact`: one
   * chrome row (44px in the touch layout) with the description trailing.
   */
  size?: "default" | "compact";
  onSelect: () => void;
}

/** Shared Add Node-style result. A non-button host preserves touch scrolling. */
export function CatalogResultRow({
  title,
  description,
  leading,
  active = false,
  striped = false,
  size = "default",
  onSelect,
  className,
  onKeyDown,
  role = "button",
  tabIndex = 0,
  ...props
}: CatalogResultRowProps) {
  return (
    <div
      {...props}
      role={role}
      aria-selected={role === "option" ? active : undefined}
      tabIndex={tabIndex}
      className={cn(
        buttonVariants({ variant: "ghost", size: "touch" }),
        "w-full min-h-0 justify-start gap-2 overflow-hidden touch-pan-y",
        size === "compact"
          ? "h-7 pointer-coarse:h-[var(--touch-target,44px)]"
          : "h-[var(--touch-target,44px)]",
        active ? "bg-accent text-accent-foreground" : striped && "bg-list-stripe",
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
      {leading}
      {size === "compact" ? (
        <>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {description ? (
            <span className="min-w-0 max-w-[60%] truncate text-xs text-muted-foreground">
              {description}
            </span>
          ) : null}
        </>
      ) : (
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="truncate">{title}</span>
          {description ? (
            <span className="truncate text-xs text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}
