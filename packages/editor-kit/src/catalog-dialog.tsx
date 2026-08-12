import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import { Input } from "@babylonslate/ui/components/input";
import { Separator } from "@babylonslate/ui/components/separator";
import { cn } from "@babylonslate/ui/lib/utils";

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
  /** When true, focus the search field on open. Default false (iPad keyboard). */
  autoFocusSearch?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  "data-testid"?: string;
  className?: string;
}

function categorySections(
  categories: CatalogCategory[],
  groups?: CatalogCategoryGroup[],
): Array<{ label: string | null; items: CatalogCategory[] }> {
  if (!groups?.length) {
    return [{ label: null, items: categories }];
  }
  const byId = new Map(categories.map((category) => [category.id, category]));
  const used = new Set<string>();
  const sections: Array<{ label: string | null; items: CatalogCategory[] }> = [];
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

/** Large centered dialog with category nav, search, and a scrollable body. */
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
  autoFocusSearch = false,
  children,
  footer,
  "data-testid": testId,
  className,
}: CatalogDialogProps) {
  const sections = useMemo(
    () => categorySections(categories, groups),
    [categories, groups],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={testId}
        className={cn(
          "flex h-[min(90vh,52rem)] w-[min(96vw,64rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none z-50",
          className,
        )}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="shrink-0 border-b px-4 py-3">
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="min-h-[var(--touch-target,44px)]"
            data-testid={testId ? `${testId}-search` : undefined}
            data-autofocus-search={autoFocusSearch ? "true" : undefined}
            autoFocus={autoFocusSearch}
          />
        </div>
        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-44 shrink-0 flex-col gap-2 overflow-y-auto border-r p-2 sm:w-52"
            data-testid={testId ? `${testId}-categories` : undefined}
          >
            {sections.map((section, index) => (
              <div key={section.label ?? `ungrouped-${index}`} className="flex flex-col gap-1">
                {section.label ? (
                  <>
                    {index > 0 ? <Separator className="my-1" /> : null}
                    <p className="px-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
                        "min-h-[var(--touch-target,44px)] justify-between rounded-md border-l-2",
                        active ? "border-l-foreground" : "border-l-transparent",
                      )}
                      onClick={() => onCategoryChange(category.id)}
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="p-4">{children}</div>
          </div>
        </div>
        {footer ? (
          <div className="shrink-0 border-t px-4 py-3">{footer}</div>
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
