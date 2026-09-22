import type { ComponentProps, ReactNode } from "react";
import { buttonVariants } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";

export interface CatalogResultRowProps
  extends Omit<ComponentProps<"div">, "children" | "onClick" | "onSelect" | "title"> {
  title: string;
  description?: string;
  /** Optional full contract shown on hover without changing the compact rows. */
  tooltip?: string;
  leading?: ReactNode;
  active?: boolean;
  striped?: boolean;
  onSelect: () => void;
}

/** Shared Add Node-style result. A non-button host preserves touch scrolling. */
export function CatalogResultRow({
  title,
  description,
  tooltip,
  leading,
  active = false,
  striped = false,
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
      title={tooltip}
      role={role}
      aria-selected={role === "option" ? active : undefined}
      tabIndex={tabIndex}
      className={cn(
        buttonVariants({ variant: "ghost", size: "touch" }),
        "h-[var(--touch-target,44px)] w-full min-h-0 justify-start gap-2 overflow-hidden touch-pan-y",
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
      <span className="flex min-w-0 flex-col items-start leading-tight">
        <span className="truncate">{title}</span>
        {description ? (
          <span className="truncate text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
