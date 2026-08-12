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
import { cn } from "@babylonslate/ui/lib/utils";

export interface CatalogCategory {
  id: string;
  label: string;
  /** Optional badge count shown beside the category label. */
  count?: number;
}

export interface CatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  categories: CatalogCategory[];
  activeCategoryId: string;
  onCategoryChange: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  children: ReactNode;
  footer?: ReactNode;
  "data-testid"?: string;
  className?: string;
}

/** Large centered dialog with category nav, search, and a scrollable body. */
export function CatalogDialog({
  open,
  onOpenChange,
  title,
  description,
  categories,
  activeCategoryId,
  onCategoryChange,
  search,
  onSearchChange,
  searchPlaceholder = "Search",
  children,
  footer,
  "data-testid": testId,
  className,
}: CatalogDialogProps) {
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
            className="min-h-11"
            data-testid={testId ? `${testId}-search` : undefined}
            autoFocus
          />
        </div>
        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 sm:w-52"
            data-testid={testId ? `${testId}-categories` : undefined}
          >
            {categories.map((category) => (
              <Button
                key={category.id}
                type="button"
                size="sm"
                variant={activeCategoryId === category.id ? "secondary" : "ghost"}
                className="min-h-11 justify-between"
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
