import { useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogTile,
  CatalogTileGroup,
  catalogCategories,
  catalogSections,
  resolveTypeVisual,
  useCatalogFilter,
} from "@babylonslate/editor-kit";
import {
  addableComponentsForHost,
  type AddComponentItem,
  type AddComponentSelection,
} from "../panels/add-component-catalog";
import { CatalogNoMatches } from "./catalog-no-matches";

const categoryOf = (item: AddComponentItem) => item.category;

export function AddComponentDialog({
  open,
  onOpenChange,
  onSelect,
  projectItems = [],
  overlay = false,
  physicsWorld = "3d",
  "data-testid": testId = "add-component-catalog",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: AddComponentSelection) => void;
  projectItems?: readonly AddComponentItem[];
  overlay?: boolean;
  physicsWorld?: "2d" | "3d";
  "data-testid"?: string;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  const items = useMemo(
    () => [...addableComponentsForHost({ overlay, physicsWorld }), ...projectItems],
    [overlay, physicsWorld, projectItems],
  );
  const bySearch = useCatalogFilter(
    items,
    search,
    (item) => `${item.label} ${item.description} ${item.category}`,
  );
  const categories = useMemo(
    () => catalogCategories(items, categoryOf, bySearch),
    [items, bySearch],
  );
  const visible =
    activeCategory === "all"
      ? bySearch
      : bySearch.filter((item) => item.category === activeCategory);
  const sections = catalogSections(visible, categoryOf);

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
      description="Attach rendering, gameplay, physics, or project components to the selected actor."
      size="medium"
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={setActiveCategory}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search components"
      data-testid={testId}
    >
      {sections.length === 0 ? (
        <CatalogNoMatches search={search} />
      ) : (
        <div className="flex flex-col gap-4">
          {sections.map((section) => (
            <CatalogTileGroup
              key={section.category}
              label={section.category}
              count={section.items.length}
              hideLabel={activeCategory !== "all"}
              minTileWidth="16rem"
            >
              {section.items.map((item) => (
                <CatalogTile
                  key={item.id}
                  data-testid={`${testId}-item-${item.id}`}
                  title={item.label}
                  description={item.description}
                  visual={visualForAddComponentItem(item)}
                  onSelect={() => {
                    onSelect({
                      classId: item.classId,
                      ...(item.properties ? { properties: item.properties } : {}),
                    });
                    onOpenChange(false);
                  }}
                />
              ))}
            </CatalogTileGroup>
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
