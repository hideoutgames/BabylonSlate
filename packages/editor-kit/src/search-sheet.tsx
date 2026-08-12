import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { SearchInput } from "./search-input";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@babylonslate/ui/components/sheet";

export interface SearchSheetItem {
  id: string;
  label: string;
  /** Secondary line, also matched by the filter. */
  description?: string;
  group?: string;
  trailing?: ReactNode;
}

export interface SearchSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  items: SearchSheetItem[];
  onSelect: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  /** Bottom sheet on touch; right side reads better on desktop. */
  side?: "bottom" | "right";
  "data-testid"?: string;
}

export function filterSearchItems(
  items: SearchSheetItem[],
  query: string,
): SearchSheetItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    `${item.label} ${item.description ?? ""} ${item.group ?? ""}`
      .toLowerCase()
      .includes(needle),
  );
}

/** Searchable bottom sheet used by the node palette, asset picker and add-component. */
export function SearchSheet({
  open,
  onOpenChange,
  title,
  description,
  items,
  onSelect,
  placeholder = "Search",
  emptyLabel = "No matches",
  side = "bottom",
  "data-testid": testId,
}: SearchSheetProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterSearchItems(items, query), [items, query]);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <SheetContent
        side={side}
        className={side === "bottom" ? "h-[70vh]" : undefined}
        data-testid={testId}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description ? (
            <SheetDescription>{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4">
          <SearchInput
            className="min-h-[var(--touch-target,44px)]"
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            onChange={setQuery}
            data-testid={testId ? `${testId}-query` : undefined}
          />
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1">
              {filtered.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  size="touch"
                  className="w-full justify-between gap-2 text-left"
                  onClick={() => {
                    onSelect(item.id);
                    setQuery("");
                    onOpenChange(false);
                  }}
                  data-testid={`search-item-${item.id}`}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{item.label}</span>
                    {item.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                  {item.trailing}
                </Button>
              ))}
              {filtered.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
              ) : null}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
