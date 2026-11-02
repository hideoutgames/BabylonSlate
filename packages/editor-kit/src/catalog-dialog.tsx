import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { popupMenuFrame } from "./catalog-menu";
import { SearchInput } from "./search-input";
import {
  POPUP_PICKER_ATTRIBUTE,
  usePopupOutsideDismiss,
} from "./use-popup-outside-dismiss";
import { Separator } from "@haptic/ui/components/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { cn } from "@haptic/ui/lib/utils";

export interface CatalogCategory {
  id: string;
  label: string;
  /** Optional badge count shown beside the category label. */
  count?: number;
}

export interface CatalogCategoryGroup {
  label: string;
  ids: string[];
}

export interface CatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  categories: CatalogCategory[];
  groups?: CatalogCategoryGroup[];
  activeCategoryId: string;
  onCategoryChange: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** `medium` suits pick lists and leaves the editor visible; `large` suits settings. */
  size?: "large" | "medium";
  /**
   * `dialog` (default) is a centered modal sized by `size`. `popup` is a
   * compact context popup (680x500, clamped to the safe viewport) placed at
   * `anchor`, centered without one: no backdrop dimming or Close button, a
   * smaller header, and it closes instantly on Escape or any outside press.
   */
  presentation?: "dialog" | "popup";
  /** Viewport point a `popup` opens from. */
  anchor?: { x: number; y: number } | null;
  /** Body scroll offset applied each time the body mounts (every open). */
  initialScrollTop?: number;
  onBodyScroll?: (scrollTop: number) => void;
  "data-testid"?: string;
  className?: string;
}

const POPUP_SIZE = { width: 680, height: 500 };

function categorySections(
  categories: CatalogCategory[],
  groups?: CatalogCategoryGroup[],
): Array<{ label: string | null; items: CatalogCategory[] }> {
  if (!groups?.length) {
    return [{ label: null, items: categories }];
  }
  const byId = new Map(categories.map((category) => [category.id, category]));
  const used = new Set<string>();
  const sections: Array<{ label: string | null; items: CatalogCategory[] }> =
    [];
  for (const group of groups) {
    const items = group.ids.flatMap((id) => {
      const category = byId.get(id);
      return category ? [category] : [];
    });
    if (items.length === 0) continue;
    sections.push({ label: group.label, items });
    for (const item of items) used.add(item.id);
  }
  const rest = categories.filter((category) => !used.has(category.id));
  if (rest.length > 0) {
    sections.push({ label: null, items: rest });
  }
  return sections;
}

/** Category sidebar on tablets and desktop; category picker on phones. */
export function CatalogDialog({
  open,
  onOpenChange,
  title,
  description,
  categories,
  groups,
  activeCategoryId,
  onCategoryChange,
  search,
  onSearchChange,
  searchPlaceholder = "Search",
  children,
  footer,
  size = "large",
  presentation = "dialog",
  anchor,
  initialScrollTop,
  onBodyScroll,
  "data-testid": testId,
  className,
}: CatalogDialogProps) {
  const sections = useMemo(
    () => categorySections(categories, groups),
    [categories, groups],
  );
  const popup = presentation === "popup";
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The body mounts on every open; restore the host's offset as it attaches.
  const attachBody = useCallback(
    (node: HTMLDivElement | null) => {
      bodyRef.current = node;
      if (node && initialScrollTop) node.scrollTop = initialScrollTop;
    },
    [initialScrollTop],
  );
  const pickCategory = (id: string) => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    onCategoryChange(id);
  };
  usePopupOutsideDismiss(open && popup, () => onOpenChange(false));
  const frame = popup ? popupMenuFrame(anchor, POPUP_SIZE) : null;
  const pickerProps = { [POPUP_PICKER_ATTRIBUTE]: "" };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={testId}
        data-presentation={presentation}
        {...(popup ? pickerProps : {})}
        showCloseButton={!popup}
        overlayClassName={
          popup ? "bg-transparent data-closed:animate-none" : undefined
        }
        initialFocus={(interaction) =>
          interaction === "keyboard" ? searchRef.current : bodyRef.current
        }
        className={cn(
          "catalog-dialog max-w-none sm:max-w-none",
          popup
            ? "translate-x-0 translate-y-0 rounded-lg data-closed:animate-none"
            : "editor-dialog-large",
          !popup && size === "medium" && "catalog-dialog-medium",
          className,
        )}
        bodyClassName="flex flex-col gap-0 overflow-hidden p-0"
        style={frame ?? undefined}
      >
        <DialogHeader
          className={cn(
            "shrink-0",
            popup ? "min-h-0 px-3 pt-2 pb-1.5" : "min-h-14 border-b px-4 py-3 pr-14",
          )}
        >
          <DialogTitle className={popup ? "text-sm" : undefined}>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div
          className={cn(
            "catalog-category-picker shrink-0 border-b py-2",
            popup ? "px-3" : "px-4",
          )}
        >
          <Select
            items={categories.map((category) => ({
              value: category.id,
              label: category.label,
            }))}
            value={activeCategoryId}
            onValueChange={(id) => {
              if (id !== null) pickCategory(id);
            }}
          >
            <SelectTrigger
              aria-label="Category"
              className="min-h-[var(--touch-target,44px)] w-full"
              data-testid={testId ? `${testId}-category-picker` : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" {...pickerProps}>
              {sections.map((section, index) => (
                <SelectGroup key={section.label ?? `ungrouped-${index}`}>
                  {section.label ? (
                    <SelectLabel>{section.label}</SelectLabel>
                  ) : null}
                  {section.items.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      <span className="min-w-0 flex-1 truncate">
                        {category.label}
                      </span>
                      {typeof category.count === "number" ? (
                        <span className="text-muted-foreground">
                          {category.count}
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div
          className={cn("shrink-0 border-b", popup ? "px-3 pb-2" : "px-4 py-2")}
          onKeyDown={(event) => {
            // Keep Escape free so the CatalogDialog can dismiss; block other
            // keystrokes from leaking into the graph behind the modal.
            if (event.key === "Escape") return;
            event.stopPropagation();
          }}
          onKeyUp={(event) => {
            if (event.key === "Escape") return;
            event.stopPropagation();
          }}
        >
          <SearchInput
            ref={searchRef}
            aria-label={searchPlaceholder}
            value={search}
            onChange={onSearchChange}
            placeholder={searchPlaceholder}
            className={cn("min-h-[var(--chrome-row,28px)]", popup && "h-7")}
            data-testid={testId ? `${testId}-search` : undefined}
          />
        </div>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Categories"
            className={cn(
              "catalog-sidebar flex shrink-0 flex-col overflow-y-auto overscroll-y-contain border-r bg-sidebar",
              popup ? "w-36 gap-1 p-1.5" : "w-44 gap-2 p-2",
            )}
            data-testid={testId ? `${testId}-categories` : undefined}
          >
            {sections.map((section, index) => (
              <div
                key={section.label ?? `ungrouped-${index}`}
                className="flex flex-col gap-1"
              >
                {section.label ? (
                  <>
                    {index > 0 ? <Separator className="my-1" /> : null}
                    <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">
                      {section.label}
                    </p>
                  </>
                ) : null}
                {section.items.map((category) => {
                  const active = activeCategoryId === category.id;
                  return (
                    <Button
                      key={category.id}
                      type="button"
                      size="sm"
                      variant={active ? "secondary" : "ghost"}
                      className={cn(
                        "justify-between rounded-md",
                        category.count === 0 && !active && "text-muted-foreground/60",
                      )}
                      onClick={() => pickCategory(category.id)}
                      aria-current={active ? "true" : undefined}
                      data-testid={
                        testId ? `${testId}-category-${category.id}` : undefined
                      }
                    >
                      <span className="truncate">{category.label}</span>
                      {typeof category.count === "number" ? (
                        <span className="text-xs text-muted-foreground">
                          {category.count}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div
            ref={attachBody}
            tabIndex={-1}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain outline-none"
            style={{ overflowY: "auto" }}
            onScroll={
              onBodyScroll
                ? (event) => onBodyScroll(event.currentTarget.scrollTop)
                : undefined
            }
            data-testid={testId ? `${testId}-body` : undefined}
          >
            <div className={popup ? "p-3" : "p-4"}>{children}</div>
          </div>
        </div>
        {footer ? (
          <div className="shrink-0 border-t bg-muted/40 px-4 py-3">{footer}</div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function useCatalogFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  return useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => getText(item).toLowerCase().includes(needle));
  }, [items, query, getText]);
}

export function useCatalogSearchState(initial = "") {
  const [search, setSearch] = useState(initial);
  return { search, setSearch };
}

/** Compact outline row used by Behaviour Tree Add Service / Add Decorator. */
export function CatalogItemButton({
  children,
  onClick,
  "data-testid": testId,
}: {
  children: ReactNode;
  onClick: () => void;
  "data-testid"?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-[var(--chrome-row,28px)] w-full justify-start gap-2 even:bg-list-stripe touch-manipulation"
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
