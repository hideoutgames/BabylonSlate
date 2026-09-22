import { useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogResultRow,
  TypeVisualIcon,
  resolveTypeVisual,
  useCatalogFilter,
} from "@babylonslate/editor-kit";
import {
  addableComponentsForHost,
  type AddComponentItem,
  type AddComponentSelection,
} from "../panels/add-component-catalog";

export function AddComponentDialog({
  open,
  onOpenChange,
  onSelect,
  projectItems = [],
  overlay = false,
  "data-testid": testId = "add-component-catalog",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: AddComponentSelection) => void;
  projectItems?: readonly AddComponentItem[];
  overlay?: boolean;
  "data-testid"?: string;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  const items = useMemo(
    () => [...addableComponentsForHost({ overlay }), ...projectItems],
    [overlay, projectItems],
  );

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
      description="Rendering, camera, physics, and project assets."
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
        <div role="group" aria-label="Components" className="flex flex-col">
          {visible.map((item, index) => (
            <CatalogResultRow
              key={item.id}
              data-testid={`${testId}-item-${item.id}`}
              title={item.label}
              description={item.description}
              leading={<TypeVisualIcon visual={visualForAddComponentItem(item)} />}
              striped={index % 2 === 1}
              onSelect={() => {
                onSelect({
                  classId: item.classId,
                  ...(item.properties ? { properties: item.properties } : {}),
                });
                onOpenChange(false);
              }}
            />
          ))}
        </div>
      )}
    </CatalogDialog>
  );
}

function visualForAddComponentItem(item: AddComponentItem) {
  if (item.id.startsWith("asset-")) {
    return resolveTypeVisual({ assetType: item.description });
  }
  return resolveTypeVisual({ classId: item.classId, ancestry: item.ancestry });
}
