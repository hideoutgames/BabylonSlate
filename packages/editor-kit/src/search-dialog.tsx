import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { SearchInput } from "./search-input";
import { PickerIdentity } from "./picker-identity";
import { WindowedList, WINDOWED_LIST_TOUCH_ROW_HEIGHT } from "./windowed-list";

export interface SearchDialogItem {
  id: string;
  label: string;
  /** Secondary line, also matched by the filter. */
  description?: string;
  group?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  items: SearchDialogItem[];
  onSelect: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  "data-testid"?: string;
}

export function filterSearchItems(
  items: SearchDialogItem[],
  query: string,
): SearchDialogItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    `${item.label} ${item.description ?? ""} ${item.group ?? ""}`
      .toLowerCase()
      .includes(needle),
  );
}

export type SearchItemGroup = {
  group?: string;
  items: SearchDialogItem[];
};

/** Consecutive items that share `group` become one labeled section. */
export function groupSearchItems(items: SearchDialogItem[]): SearchItemGroup[] {
  const groups: SearchItemGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.group === item.group) {
      last.items.push(item);
    } else {
      groups.push({ group: item.group, items: [item] });
    }
  }
  return groups;
}

/** Compact searchable dialog used by asset and class pickers. */
export function SearchDialog({
  open,
  onOpenChange,
  title,
  description,
  items,
  onSelect,
  placeholder = "Search",
  emptyLabel = "No matches",
  "data-testid": testId,
}: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterSearchItems(items, query), [items, query]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-h-[min(24rem,70vh)] w-full max-w-md flex-col gap-3 overflow-hidden sm:max-w-md"
        data-testid={testId}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <SearchInput
            className="min-h-[var(--touch-target,44px)]"
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            onChange={setQuery}
            data-testid={testId ? `${testId}-query` : undefined}
          />
          <ScrollArea className="h-0 min-h-0 max-h-64 flex-1">
            {filtered.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
            ) : (
              <WindowedList
                itemCount={filtered.length}
                rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}
              >
                {(index) => {
                  const item = filtered[index]!;
                  return (
                    <Button
                      key={item.id}
                      variant="ghost"
                      size="touch"
                      className="h-full w-full min-h-0 justify-between gap-2 overflow-hidden text-left"
                      onClick={() => {
                        onSelect(item.id);
                        setQuery("");
                        onOpenChange(false);
                      }}
                      data-testid={`search-item-${item.id}`}
                    >
                      <PickerIdentity
                        label={item.label}
                        description={item.description}
                        leading={item.leading}
                      />
                      {item.trailing}
                    </Button>
                  );
                }}
              </WindowedList>
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
