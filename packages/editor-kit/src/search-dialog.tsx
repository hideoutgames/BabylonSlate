import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { buttonVariants } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { cn } from "@babylonslate/ui/lib/utils";
import { SearchInput } from "./search-input";
import { PickerIdentity } from "./picker-identity";
import {
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  pickerListHeightPx,
} from "./windowed-list";

/** Enter/Space on a listbox option — native buttons are not used so touch can pan. */
export function commitPickerOptionKeyDown(
  event: KeyboardEvent,
  commit: () => void,
): void {
  if (event.nativeEvent.isComposing) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  commit();
}

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(
    () => filterSearchItems(items, query),
    [items, query],
  );
  const activeIndex = filtered.findIndex((item) => item.id === activeId);
  const optionId = (id: string) => `${listId}-${encodeURIComponent(id)}`;
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveId(null);
    }
  }, [open]);

  const commit = (id: string) => {
    onSelect(id);
    setQuery("");
    setActiveId(null);
    onOpenChange(false);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || filtered.length === 0) return;
    let next = activeIndex;
    if (event.key === "ArrowDown")
      next = Math.min(filtered.length - 1, activeIndex + 1);
    else if (event.key === "ArrowUp")
      next =
        activeIndex < 0 ? filtered.length - 1 : Math.max(0, activeIndex - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = filtered.length - 1;
    else if (event.key === "Enter") {
      event.preventDefault();
      commit(filtered[Math.max(0, activeIndex)]!.id);
      return;
    } else return;
    event.preventDefault();
    setActiveId(filtered[next]!.id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          setActiveId(null);
        }
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
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open && filtered.length > 0}
            aria-controls={listId}
            aria-activedescendant={
              activeIndex >= 0 ? optionId(filtered[activeIndex]!.id) : undefined
            }
            placeholder={placeholder}
            value={query}
            onChange={(value) => {
              setQuery(value);
              setActiveId(null);
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
            }}
            onKeyDown={onSearchKeyDown}
            data-testid={testId ? `${testId}-query` : undefined}
          />
          <div
            ref={scrollRef}
            id={listId}
            className="min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y"
            style={{
              height: pickerListHeightPx(filtered.length),
              overflowY: "auto",
            }}
            role="listbox"
            aria-label={title}
            data-testid={testId ? `${testId}-body` : undefined}
          >
            {filtered.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
            ) : (
              <WindowedList
                key={query}
                itemCount={filtered.length}
                rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}
                activeIndex={activeIndex}
              >
                {(index) => {
                  const item = filtered[index]!;
                  const select = () => commit(item.id);
                  return (
                    <div
                      key={item.id}
                      role="option"
                      id={optionId(item.id)}
                      aria-selected={index === activeIndex}
                      tabIndex={-1}
                      title={
                        item.group
                          ? `${item.label} · ${item.description ?? ""} · ${item.group}`
                          : undefined
                      }
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "touch" }),
                        "h-full w-full min-h-0 justify-between gap-2 overflow-hidden text-left touch-pan-y",
                        index === activeIndex && "bg-accent",
                      )}
                      onClick={select}
                      onFocus={() => setActiveId(item.id)}
                      onKeyDown={(event) =>
                        commitPickerOptionKeyDown(event, select)
                      }
                      data-testid={`search-item-${item.id}`}
                    >
                      <PickerIdentity
                        label={item.label}
                        description={[item.description, item.group]
                          .filter(Boolean)
                          .join(" · ")}
                        leading={item.leading}
                      />
                      {item.trailing}
                    </div>
                  );
                }}
              </WindowedList>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
