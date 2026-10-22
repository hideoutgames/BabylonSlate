import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@haptic/ui/components/dropdown-menu";
import { SearchInput } from "./search-input";
import {
  filterSearchItems,
  groupSearchItems,
  type SearchDialogItem,
} from "./search-dialog";
import { PickerIdentity } from "./picker-identity";
import { cn } from "@haptic/ui/lib/utils";

export interface SearchDropdownProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: string;
  items: SearchDialogItem[];
  onSelect: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  children: ReactElement;
  /** When true, outside clicks are captured so chrome behind the menu is not hit. Default false so canvas pickers do not paint an iPad WKWebView black overlay. */
  modal?: boolean;
  /** Size classes for the menu; the header stays fixed and only the results scroll. Default max-h-96. */
  contentClassName?: string;
  /** Viewport point to open at instead of the trigger (a double-tap on empty space). */
  anchor?: { x: number; y: number } | null;
  "data-testid"?: string;
}

const MENU_KEYS = new Set(["Escape", "ArrowDown", "ArrowUp"]);

function pointAnchor(x: number, y: number) {
  const rect = { x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
  return { getBoundingClientRect: () => ({ ...rect, toJSON: () => rect }) };
}

/** Searchable dropdown anchored to a trigger. Use for pick lists with a nearby button. */
export function SearchDropdown({
  open,
  onOpenChange,
  title,
  description,
  items,
  onSelect,
  placeholder = "Search",
  emptyLabel = "No matches",
  children,
  modal = false,
  contentClassName,
  anchor,
  "data-testid": testId,
}: SearchDropdownProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => filterSearchItems(items, query),
    [items, query],
  );
  const grouped = useMemo(() => groupSearchItems(filtered), [filtered]);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ above: false, below: false });
  const overflowRef = useRef(overflow);
  const measureOverflow = useCallback(() => {
    if (!scrollEl) return;
    // One pixel of slack absorbs fractional scroll positions at either end.
    const above = scrollEl.scrollTop > 1;
    const below = scrollEl.scrollTop + scrollEl.clientHeight < scrollEl.scrollHeight - 1;
    if (above === overflowRef.current.above && below === overflowRef.current.below) return;
    overflowRef.current = { above, below };
    setOverflow(overflowRef.current);
  }, [scrollEl]);
  useLayoutEffect(() => {
    measureOverflow();
  }, [measureOverflow, filtered]);
  useLayoutEffect(() => {
    if (!scrollEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [measureOverflow, scrollEl]);
  const anchorX = anchor?.x;
  const anchorY = anchor?.y;
  const virtualAnchor = useMemo(
    () => (anchorX === undefined || anchorY === undefined ? undefined : pointAnchor(anchorX, anchorY)),
    [anchorX, anchorY],
  );

  return (
    <DropdownMenu
      modal={modal}
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange?.(next);
      }}
    >
      <DropdownMenuTrigger render={children} />
      <DropdownMenuContent
        align="start"
        anchor={virtualAnchor}
        // The popup does not scroll: a fixed header over its own results
        // scroller, so no row can slide behind or above the search field.
        className={cn(
          "flex flex-col overflow-hidden p-0",
          contentClassName ?? "max-h-96 w-max min-w-52 max-w-sm",
        )}
        data-testid={testId}
      >
        <div className="shrink-0 px-1 pt-1">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{title}</DropdownMenuLabel>
          </DropdownMenuGroup>
          {description ? (
            <p className="px-1.5 pb-1 text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
          <div
            className="px-1 pb-1"
            onKeyDown={(event) => {
              // Escape closes and the arrows move into the results; other keys
              // stay in the field instead of driving menu typeahead.
              if (MENU_KEYS.has(event.key)) return;
              event.stopPropagation();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <SearchInput
              className="h-7 pointer-coarse:h-[var(--touch-target,44px)]"
              aria-label={placeholder}
              placeholder={placeholder}
              value={query}
              onChange={setQuery}
              data-testid={testId ? `${testId}-query` : undefined}
            />
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={setScrollEl}
            onScroll={measureOverflow}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 pt-0"
            data-testid={testId ? `${testId}-results` : undefined}
          >
            {grouped.map((section, index) => (
              <DropdownMenuGroup key={section.items[0]?.id ?? index}>
                {section.group ? (
                  <DropdownMenuLabel>{section.group}</DropdownMenuLabel>
                ) : null}
                {section.items.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    className="min-h-7 pointer-coarse:min-h-[var(--touch-target,44px)]"
                    onClick={() => {
                      onSelect(item.id);
                      onOpenChange?.(false);
                    }}
                    data-testid={`search-item-${item.id}`}
                  >
                    <PickerIdentity
                      label={item.label}
                      description={item.description}
                      leading={item.leading}
                    />
                    {item.trailing}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
            {filtered.length === 0 ? (
              <DropdownMenuGroup>
                <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
              </DropdownMenuGroup>
            ) : null}
          </div>
          <div
            aria-hidden="true"
            data-visible={overflow.above || undefined}
            className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-linear-to-b from-popover to-transparent opacity-0 transition-opacity duration-150 data-visible:opacity-100"
          />
          <div
            aria-hidden="true"
            data-visible={overflow.below || undefined}
            data-testid={testId ? `${testId}-more-below` : undefined}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-lg bg-linear-to-t from-popover to-transparent opacity-0 transition-opacity duration-150 data-visible:opacity-100"
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
