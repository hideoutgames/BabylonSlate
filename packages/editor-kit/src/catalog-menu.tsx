import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Kbd } from "@babylonslate/ui/components/kbd";
import { cn } from "@babylonslate/ui/lib/utils";
import { clampOverlayMenuPosition } from "./clamp-overlay-menu";
import { humanizePropertyLabel } from "./humanize-property-label";
import { isCoarsePointerEnvironment } from "./prevent-document-overscroll";
import { SearchInput } from "./search-input";
import { WindowedList } from "./windowed-list";
import "./styles/catalog-menu.css";

/** Desktop rows match `--chrome-row`; coarse pointers use `--touch-target`. */
export const CATALOG_MENU_ROW_HEIGHT = 28;
export const CATALOG_MENU_TOUCH_ROW_HEIGHT = 44;

const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 460;
const POPUP_MARGIN = 8;

export interface CatalogMenuItem {
  id: string;
  title: string;
  category: string;
  description?: string;
}

export interface CatalogMenuProps<T extends CatalogMenuItem> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: readonly T[];
  onSelect: (item: T) => void;
  /** Viewport point the popup opens from. Without one it is centered. */
  anchor?: { x: number; y: number } | null;
  /**
   * `modal` fills the viewport like other large catalogs, ignores `anchor`, and
   * adds a category sidebar (hidden on phones) unless `flat`.
   */
  presentation?: "popup" | "modal";
  /** Defaults to a title / category / description substring match. */
  filterItems?: (items: readonly T[], query: string) => T[];
  /** Keep the given order as one flat list instead of a category tree. */
  flat?: boolean;
  /** Visible category label; defaults to `humanizePropertyLabel` for camelCase ids. */
  formatCategory?: (category: string) => string;
  renderLeading?: (item: T) => ReactNode;
  /** Right side of the title row (Add Node's Context Sensitive checkbox). */
  headerAccessory?: ReactNode;
  searchLabel: string;
  searchPlaceholder: string;
  treeLabel: string;
  /** Extra identity for the windowed list, reset alongside search. */
  listKey?: string;
  /** Prefix for `-search`, `-body`, `-category-*`, and `-item-*` test ids. */
  "data-testid": string;
}

type MenuRow<T> =
  | { kind: "category"; key: string; category: string; count: number; expanded: boolean }
  | { kind: "item"; key: string; item: T; nested: boolean; flatCategory?: boolean };

function defaultFilter<T extends CatalogMenuItem>(
  items: readonly T[],
  query: string,
  formatCategory: (category: string) => string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    `${item.title} ${formatCategory(item.category)} ${item.description ?? ""}`
      .toLowerCase()
      .includes(needle),
  );
}

function rowId(listId: string, key: string): string {
  return `${listId}-${encodeURIComponent(key)}`;
}

function cssPixels(name: string): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return Number.isFinite(value) ? value : 0;
}

/** Viewport-clamped placement for anchored popup menus; centered without an anchor. */
export function popupMenuFrame(
  anchor: { x: number; y: number } | null | undefined,
  size: { width: number; height: number } = { width: POPUP_WIDTH, height: POPUP_HEIGHT },
) {
  const insets = {
    top: cssPixels("--safe-top"),
    right: cssPixels("--safe-right"),
    bottom: cssPixels("--safe-bottom"),
    left: cssPixels("--safe-left"),
  };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(size.width, vw - insets.left - insets.right - POPUP_MARGIN * 2);
  const height = Math.min(size.height, vh - insets.top - insets.bottom - POPUP_MARGIN * 2);
  const origin = anchor ?? { x: (vw - width) / 2, y: (vh - height) / 2 };
  const { x, y } = clampOverlayMenuPosition({
    ...origin,
    width,
    height,
    viewportWidth: vw,
    viewportHeight: vh,
    margin: POPUP_MARGIN,
    insets,
  });
  return { left: x, top: y, width, height };
}

/**
 * Unreal-style searchable popup menu: a pointer-anchored (or modal) Dialog with
 * a search combobox, a collapsible A–Z category tree, and keyboard navigation.
 */
export function CatalogMenu<T extends CatalogMenuItem>({
  open,
  onOpenChange,
  title,
  items,
  onSelect,
  anchor,
  presentation = "popup",
  filterItems,
  flat = false,
  formatCategory = humanizePropertyLabel,
  renderLeading,
  headerAccessory,
  searchLabel,
  searchPlaceholder,
  treeLabel,
  listKey = "",
  "data-testid": testId,
}: CatalogMenuProps<T>) {
  const modal = presentation === "modal";
  const [search, setSearch] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /** Sidebar filter in the modal; `null` lists every category. */
  const [sidebarCategory, setSidebarCategory] = useState<string | null>(null);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const coarse = isCoarsePointerEnvironment();
  const rowHeight = coarse ? CATALOG_MENU_TOUCH_ROW_HEIGHT : CATALOG_MENU_ROW_HEIGHT;

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setActiveKey(null);
    setCollapsed(new Set());
    setSidebarCategory(null);
  }, [open]);

  const filtered = useMemo(
    () => (filterItems ? filterItems(items, search) : defaultFilter(items, search, formatCategory)),
    [filterItems, formatCategory, items, search],
  );

  const sidebar = modal && !flat;
  const sidebarCategories = useMemo(() => {
    if (!sidebar) return [];
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.category, 0);
    for (const item of filtered) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => formatCategory(a.category).localeCompare(formatCategory(b.category)));
  }, [filtered, formatCategory, items, sidebar]);

  const rows = useMemo((): MenuRow<T>[] => {
    if (flat) {
      return filtered.map((item) => ({ kind: "item", key: item.id, item, nested: false }));
    }
    if (sidebar && sidebarCategory !== null) {
      return filtered
        .filter((item) => item.category === sidebarCategory)
        .map((item) => ({ kind: "item", key: item.id, item, nested: false, flatCategory: true }));
    }
    const groups = new Map<string, T[]>();
    for (const item of filtered) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) =>
      formatCategory(a).localeCompare(formatCategory(b)),
    );
    const result: MenuRow<T>[] = [];
    for (const [category, grouped] of sorted) {
      const expanded = !collapsed.has(category);
      result.push({
        kind: "category",
        key: `category:${category}`,
        category,
        count: grouped.length,
        expanded,
      });
      if (!expanded) continue;
      for (const item of grouped) {
        result.push({ kind: "item", key: item.id, item, nested: true });
      }
    }
    return result;
  }, [collapsed, filtered, flat, formatCategory, sidebar, sidebarCategory]);

  const stripedRows = useMemo(() => {
    const striped = new Set<number>();
    let itemIndex = 0;
    rows.forEach((row, index) => {
      if (row.kind === "category") {
        itemIndex = 0;
        return;
      }
      if (itemIndex % 2 === 1) striped.add(index);
      itemIndex += 1;
    });
    return striped;
  }, [rows]);

  const activeIndex = rows.findIndex((row) => row.key === activeKey);
  const firstItemIndex = rows.findIndex((row) => row.kind === "item");

  const close = () => onOpenChange(false);
  const commit = (item: T) => {
    onSelect(item);
    close();
  };
  const toggleCategory = (category: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };
  const activate = (row: MenuRow<T>) => {
    if (row.kind === "item") commit(row.item);
    else toggleCategory(row.category);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || rows.length === 0) return;
    const active = activeIndex >= 0 ? rows[activeIndex]! : null;
    let next = activeIndex;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(rows.length - 1, activeIndex + 1);
        break;
      case "ArrowUp":
        next = activeIndex < 0 ? rows.length - 1 : Math.max(0, activeIndex - 1);
        break;
      case "Home":
        if (activeIndex < 0) return;
        next = 0;
        break;
      case "End":
        if (activeIndex < 0) return;
        next = rows.length - 1;
        break;
      case "ArrowRight":
        if (active?.kind !== "category" || active.expanded) return;
        event.preventDefault();
        toggleCategory(active.category);
        return;
      case "ArrowLeft":
        if (!active) return;
        event.preventDefault();
        if (active.kind === "category") {
          if (active.expanded) toggleCategory(active.category);
          return;
        }
        if (active.nested) {
          setActiveKey(`category:${active.item.category}`);
        }
        return;
      case "Enter": {
        event.preventDefault();
        const target = active ?? (firstItemIndex >= 0 ? rows[firstItemIndex]! : null);
        if (target) activate(target);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    setActiveKey(rows[next]!.key);
  };

  const frame = modal ? null : popupMenuFrame(anchor);
  const activeDescendant = activeIndex >= 0 ? rowId(listId, rows[activeIndex]!.key) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={testId}
        data-presentation={presentation}
        showCloseButton={modal}
        overlayClassName={cn("catalog-menu-overlay", !modal && "bg-transparent")}
        initialFocus={(interaction) =>
          coarse && interaction !== "keyboard" ? bodyRef.current : searchRef.current
        }
        className={cn(
          "catalog-menu flex max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none",
          modal
            ? "catalog-menu-modal editor-dialog-large"
            : "catalog-menu-popup translate-x-0 translate-y-0 rounded-lg",
        )}
        style={frame ?? undefined}
      >
        <div
          className={cn(
            "flex shrink-0 items-center justify-between gap-2",
            modal ? "min-h-14 px-4 py-3 pr-14" : "px-2 pt-2 pb-1.5",
          )}
        >
          <DialogTitle className={modal ? undefined : "text-sm"}>{title}</DialogTitle>
          {headerAccessory}
        </div>
        <div className={cn("shrink-0 border-b pb-2", modal ? "px-4" : "px-2")}>
          <SearchInput
            ref={searchRef}
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls={rows.length > 0 ? listId : undefined}
            aria-activedescendant={activeDescendant}
            value={search}
            onChange={(value) => {
              setSearch(value);
              setActiveKey(null);
              setCollapsed(new Set());
            }}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder}
            className="h-7 min-h-[var(--chrome-row,28px)]"
            data-testid={`${testId}-search`}
          />
        </div>
        <div className="flex min-h-0 flex-1">
        {sidebar ? (
          <nav
            aria-label="Categories"
            className="catalog-sidebar flex w-48 shrink-0 flex-col gap-1 overflow-y-auto overscroll-y-contain border-r bg-sidebar p-2"
            data-testid={`${testId}-sidebar`}
          >
            {[{ category: null, count: filtered.length }, ...sidebarCategories].map(
              ({ category, count }) => {
                const active = sidebarCategory === category;
                return (
                  <Button
                    key={category ?? "__all__"}
                    type="button"
                    size="sm"
                    variant={active ? "secondary" : "ghost"}
                    className={cn(
                      "justify-between rounded-md",
                      count === 0 && !active && "text-muted-foreground/60",
                    )}
                    aria-current={active ? "true" : undefined}
                    data-testid={`${testId}-sidebar-${category ?? "all"}`}
                    onClick={() => {
                      setSidebarCategory(category);
                      setActiveKey(null);
                      if (bodyRef.current) bodyRef.current.scrollTop = 0;
                    }}
                  >
                    <span className="truncate">
                      {category === null ? "All Categories" : formatCategory(category)}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                  </Button>
                );
              },
            )}
          </nav>
        ) : null}
        <div
          ref={bodyRef}
          tabIndex={-1}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain outline-none",
            modal ? "px-3 py-1" : "p-1",
          )}
          style={{ overflowY: "auto" }}
          data-testid={`${testId}-body`}
        >
          {rows.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No matches</p>
          ) : (
            <div role="tree" id={listId} aria-label={treeLabel}>
              <WindowedList
                key={`${search}:${listKey}:${sidebarCategory ?? ""}`}
                itemCount={rows.length}
                rowHeight={rowHeight}
                activeIndex={activeIndex}
              >
                {(index) => {
                  const row = rows[index]!;
                  const active = row.key === activeKey;
                  const stripe = modal && stripedRows.has(index) ? "true" : undefined;
                  if (row.kind === "category") {
                    return (
                      <div
                        role="treeitem"
                        id={rowId(listId, row.key)}
                        aria-expanded={row.expanded}
                        aria-selected={active}
                        aria-level={1}
                        tabIndex={-1}
                        data-active={active ? "true" : undefined}
                        data-testid={`${testId}-category-${row.category}`}
                        className="catalog-menu-row catalog-menu-category"
                        onClick={() => {
                          setActiveKey(row.key);
                          toggleCategory(row.category);
                        }}
                      >
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="catalog-menu-chevron"
                          data-expanded={row.expanded ? "true" : undefined}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {formatCategory(row.category)}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.count}
                        </span>
                      </div>
                    );
                  }
                  const item = row.item;
                  return (
                    <div
                      role="treeitem"
                      id={rowId(listId, row.key)}
                      aria-selected={active}
                      aria-level={row.nested ? 2 : 1}
                      aria-description={item.description}
                      title={item.description}
                      tabIndex={-1}
                      data-active={active ? "true" : undefined}
                      data-nested={row.nested ? "true" : undefined}
                      data-stripe={stripe}
                      data-testid={`${testId}-item-${item.id}`}
                      className="catalog-menu-row catalog-menu-item"
                      onClick={() => commit(item)}
                      onFocus={() => setActiveKey(row.key)}
                    >
                      {renderLeading?.(item)}
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {modal && item.description ? (
                        <span className="min-w-0 flex-[2] truncate text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      ) : null}
                      {row.nested || row.flatCategory ? null : (
                        <span className="truncate text-xs text-muted-foreground">
                          {formatCategory(item.category)}
                        </span>
                      )}
                    </div>
                  );
                }}
              </WindowedList>
            </div>
          )}
        </div>
        </div>
        <div
          className={cn(
            "catalog-menu-hints shrink-0 items-center gap-3 border-t py-1.5 text-xs text-muted-foreground",
            modal ? "px-4" : "px-2",
          )}
        >
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Navigate
          </span>
          {flat || (sidebar && sidebarCategory !== null) ? null : (
            <span className="flex items-center gap-1">
              <Kbd>←</Kbd>
              <Kbd>→</Kbd>
              Collapse / Expand
            </span>
          )}
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd>
            Add
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
