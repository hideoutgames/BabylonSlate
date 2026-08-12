import { useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogItemButton,
  TypeVisualIcon,
  resolveTypeVisual,
  useCatalogFilter,
} from "@babylonslate/editor-kit";
import { ADDABLE_COMPONENT_CLASSES } from "../panels/add-component-catalog";

export function AddComponentDialog({
  open,
  onOpenChange,
  onSelect,
  "data-testid": testId = "add-component-catalog",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (classId: string) => void;
  "data-testid"?: string;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  const items = useMemo(() => [...ADDABLE_COMPONENT_CLASSES], []);

  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      map.set(item.category, (map.get(item.category) ?? 0) + 1);
    }
    const listed = [...map.entries()].map(([id, count]) => ({
      id,
      label: id,
      count,
    }));
    return [{ id: "all", label: "All", count: items.length }, ...listed];
  }, [items]);

  const bySearch = useCatalogFilter(
    items,
    search,
    (item) => `${item.label} ${item.description} ${item.category}`,
  );
  const visible =
    activeCategory === "all"
      ? bySearch
      : bySearch.filter((item) => item.category === activeCategory);

  return (
    <CatalogDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setSearch("");
          setActiveCategory("all");
        }
      }}
      title="Add Component"
      description="Rendering, camera, and physics components."
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={setActiveCategory}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search components"
      data-testid={testId}
    >
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((item) => (
            <CatalogItemButton
              key={item.id}
              data-testid={`${testId}-item-${item.id}`}
              onClick={() => {
                onSelect(item.id);
                onOpenChange(false);
              }}
            >
              <TypeVisualIcon
                visual={resolveTypeVisual({ classId: item.id })}
              />
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span className="truncate">{item.label}</span>
                <span className="text-xs text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </CatalogItemButton>
          ))}
        </div>
      )}
    </CatalogDialog>
  );
}
