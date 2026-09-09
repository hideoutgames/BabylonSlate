import {
  useId,
  useLayoutEffect,
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
  const queryRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filtered = useMemo(
    () => filterSearchItems(items, query),
    [items, query],
  );
  const activeIndex = filtered.findIndex((item) => item.id === activeId);
  const optionId = (id: string) => `${listId}-${encodeURIComponent(id)}`;
  const activeOptionId =
    activeIndex < 0 ? undefined : optionId(filtered[activeIndex]!.id);
  const resetQuery = (value: string) => {
    setQuery(value);
    setActiveId(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  const commit = (id: string) => {
    onSelect(id);
    resetQuery("");
    onOpenChange(false);
  };
  const navigate = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      event.stopPropagation();
      commit(filtered[activeIndex]!.id);
      return;
    }
    // Home/End still edit the query when the input owns focus.
    const inQuery = event.target === queryRef.current;
    if (
      !["ArrowDown", "ArrowUp", ...(inQuery ? [] : ["Home", "End"])].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!filtered.length) return;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? filtered.length - 1
          : activeIndex < 0
            ? event.key === "ArrowUp"
              ? filtered.length - 1
              : 0
            : Math.max(
                0,
                Math.min(
                  filtered.length - 1,
                  activeIndex + (event.key === "ArrowDown" ? 1 : -1),
                ),
              );
    setActiveId(filtered[next]!.id);
  };
  useLayoutEffect(() => {
    if (!open) {
      resetQuery("");
      return;
    }
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    const top = activeIndex * WINDOWED_LIST_TOUCH_ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (
      top + WINDOWED_LIST_TOUCH_ROW_HEIGHT >
      list.scrollTop + list.clientHeight
    ) {
      list.scrollTop = Math.max(
        0,
        top + WINDOWED_LIST_TOUCH_ROW_HEIGHT - list.clientHeight,
      );
    }
  }, [activeIndex, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent
        initialFocus={(interaction) =>
          interaction === "keyboard" ? queryRef.current : listRef.current
        }
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
            ref={queryRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            onKeyDown={navigate}
            className="min-h-[var(--touch-target,44px)]"
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            onChange={resetQuery}
            data-testid={testId ? `${testId}-query` : undefined}
          />
          <div
            ref={listRef}
            id={listId}
            tabIndex={0}
            aria-label={title}
            aria-activedescendant={activeOptionId}
            onKeyDown={navigate}
            className="min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y"
            style={{
              height: pickerListHeightPx(filtered.length),
              overflowY: "auto",
            }}
            role="listbox"
            data-testid={testId ? `${testId}-body` : undefined}
          >
            {filtered.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
            ) : (
              <WindowedList
                key={query}
                activeIndex={activeIndex}
                itemCount={filtered.length}
                rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}
              >
                {(index) => {
                  const item = filtered[index]!;
                  return (
                    <div
                      key={item.id}
                      id={optionId(item.id)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeIndex}
                      title={item.group ? [item.label, item.description, item.group].filter(Boolean).join(" · ") : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "touch" }),
                        "h-full w-full min-h-0 justify-between gap-2 overflow-hidden text-left touch-pan-y",
                        index === activeIndex &&
                          "bg-secondary border-l-2 border-l-primary",
                      )}
                      onClick={() => commit(item.id)}
                      onFocus={() => setActiveId(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ")
                          event.stopPropagation();
                        commitPickerOptionKeyDown(event, () => commit(item.id));
                      }}
                      data-testid={`search-item-${item.id}`}
                    >
                      <PickerIdentity
                        label={item.label}
                        description={item.description}
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
