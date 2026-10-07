import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { PlusIcon } from "lucide-react";
import { buttonVariants } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { cn } from "@babylonslate/ui/lib/utils";
import { popupMenuFrame } from "./catalog-menu";
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
  /**
   * Listed first for every query, such as Create New rows, and set apart from
   * the results. Arrow keys enter the list on an unpinned row.
   */
  pinned?: boolean;
  /** Selecting keeps the dialog open and the query; the caller closes it. */
  keepOpen?: boolean;
}

export interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  items: SearchDialogItem[];
  /** `query` is the search text at the time of selection. */
  onSelect: (id: string, query: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  /** Marks the list busy and ignores selections (a pending create). */
  busy?: boolean;
  /** Shown under the list, such as an error Alert. */
  status?: ReactNode;
  /** Popup origin; defaults to just below the control that opened the picker. */
  anchor?: { x: number; y: number } | null;
  "data-testid"?: string;
}

const POPUP_WIDTH = 400;
/** Title, search field and padding around the list. */
const POPUP_CHROME_HEIGHT = 96;

let lastTriggerAnchor: { x: number; y: number; time: number } | null = null;

if (typeof document !== "undefined") {
  // Pickers open from many call sites through `open` state, so remember the
  // pressed control before a menu item that opened the picker unmounts.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const trigger =
        target?.closest("button, [role='button'], [role='menuitem'], [role='combobox']") ??
        target;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      lastTriggerAnchor = { x: rect.left, y: rect.bottom + 4, time: performance.now() };
    },
    true,
  );
}

function openerAnchor(): { x: number; y: number } | null {
  if (lastTriggerAnchor && performance.now() - lastTriggerAnchor.time < 1500) {
    return { x: lastTriggerAnchor.x, y: lastTriggerAnchor.y };
  }
  const focused = document.activeElement;
  if (!focused || focused === document.body) return null;
  const rect = focused.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left, y: rect.bottom + 4 };
}

/** Leading glyph for pinned Create New rows. */
export function PickerCreateGlyph() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
      <PlusIcon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

export function filterSearchItems(
  items: SearchDialogItem[],
  query: string,
): SearchDialogItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  const matches: SearchDialogItem[] = [];
  const pinned: SearchDialogItem[] = [];
  for (const item of items) {
    if (item.pinned) pinned.push(item);
    else if (
      `${item.label} ${item.description ?? ""} ${item.group ?? ""}`
        .toLowerCase()
        .includes(needle)
    ) {
      matches.push(item);
    }
  }
  return [...pinned, ...matches];
}

/**
 * Row that ArrowDown (or ArrowUp from the end) activates when none is active:
 * the first unpinned row, so the keyboard never lands on a Create New row
 * unless it is all that is listed.
 */
function arrowEntryIndex(items: SearchDialogItem[], fromEnd: boolean): number {
  for (let step = 0; step < items.length; step += 1) {
    const index = fromEnd ? items.length - 1 - step : step;
    if (!items[index]!.pinned) return index;
  }
  return fromEnd ? items.length - 1 : 0;
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

/** Compact searchable popup anchored to its trigger, used by asset and class pickers. */
export function SearchDialog({
  open,
  onOpenChange,
  title,
  description,
  items,
  onSelect,
  placeholder = "Search",
  emptyLabel = "No Matches",
  busy = false,
  status,
  anchor,
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
  const commit = (item: SearchDialogItem) => {
    if (busy) return;
    onSelect(item.id, query);
    if (item.keepOpen) return;
    resetQuery("");
    onOpenChange(false);
  };
  const navigate = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      event.stopPropagation();
      commit(filtered[activeIndex]!);
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
            ? arrowEntryIndex(filtered, event.key === "ArrowUp")
            : Math.max(
                0,
                Math.min(
                  filtered.length - 1,
                  activeIndex + (event.key === "ArrowDown" ? 1 : -1),
                ),
              );
    setActiveId(filtered[next]!.id);
  };
  // Placed once per opening so filtering does not move the popup.
  const frame = useMemo(() => {
    if (!open) return null;
    const { left, top, width, height } = popupMenuFrame(anchor ?? openerAnchor(), {
      width: POPUP_WIDTH,
      height: POPUP_CHROME_HEIGHT + pickerListHeightPx(items.length),
    });
    return { left, top, width, maxHeight: height };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placed once per opening
  }, [open]);
  const lastPinnedIndex = filtered.filter((item) => item.pinned).length - 1;
  // An external close clears the query while rendering; the list unmounts with it.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setQuery("");
      setActiveId(null);
    }
  }
  useLayoutEffect(() => {
    if (!open) return;
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
        showCloseButton={false}
        overlayClassName="catalog-menu-overlay bg-transparent"
        className="catalog-menu-popup flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-none"
        style={frame ?? undefined}
        data-testid={testId}
      >
        <DialogHeader className="shrink-0 gap-0.5 px-2 pt-2 pb-1.5">
          <DialogTitle className="text-sm">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-xs">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b px-2 pb-2">
          <SearchInput
            ref={queryRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            onKeyDown={navigate}
            className="h-7 min-h-[var(--chrome-row,28px)]"
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            onChange={resetQuery}
            data-testid={testId ? `${testId}-query` : undefined}
          />
          </div>
          <div
            ref={listRef}
            id={listId}
            tabIndex={0}
            aria-label={title}
            aria-activedescendant={activeOptionId}
            aria-busy={busy || undefined}
            onKeyDown={navigate}
            className="min-h-0 overflow-y-auto overscroll-y-contain p-1 touch-pan-y"
            style={{
              height: pickerListHeightPx(filtered.length) + 8,
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
                  const separated =
                    index === lastPinnedIndex && index < filtered.length - 1;
                  return (
                    <div
                      key={item.id}
                      className={cn("h-full", separated && "border-b pb-1")}
                    >
                    <div
                      id={optionId(item.id)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeIndex}
                      title={item.group ? `${item.label} · ${item.group}` : undefined}
                      data-pinned={item.pinned ? "true" : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "touch" }),
                        "h-full w-full min-h-0 justify-between gap-2 overflow-hidden text-left touch-pan-y",
                        item.pinned && "font-medium",
                        index === activeIndex
                          ? "bg-accent text-accent-foreground"
                          : !item.pinned &&
                              (index - lastPinnedIndex - 1) % 2 === 1 &&
                              "bg-list-stripe",
                      )}
                      onClick={() => commit(item)}
                      onFocus={() => setActiveId(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ")
                          event.stopPropagation();
                        commitPickerOptionKeyDown(event, () => commit(item));
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
                    </div>
                  );
                }}
              </WindowedList>
            )}
          </div>
          {status ? <div className="shrink-0">{status}</div> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
