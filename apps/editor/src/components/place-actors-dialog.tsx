import { useEffect, useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogTile,
  CatalogTileGroup,
  catalogCategories,
  catalogSections,
  useCatalogFilter,
} from "@babylonslate/editor-kit";
import {
  visualForPlaceActor,
  placeActorsForHost,
  type PlaceActorItem,
} from "../lib/place-actors";
import { CatalogNoMatches } from "./catalog-no-matches";

const categoryOf = (item: PlaceActorItem) => item.category;

export function PlaceActorsDialog({
  open,
  onOpenChange,
  onSelect,
  projectItems,
  overlay = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: PlaceActorItem) => void;
  projectItems: PlaceActorItem[];
  overlay?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  // The Outliner closes this dialog itself once an actor spawns, so resetting
  // from `onOpenChange` alone would leave the previous filter in place.
  useEffect(() => {
    if (open) return;
    setSearch("");
    setActiveCategory("all");
  }, [open]);

  const items = useMemo(
    () => [...placeActorsForHost({ overlay }), ...projectItems],
    [overlay, projectItems],
  );
  const bySearch = useCatalogFilter(
    items,
    search,
    (item) => `${item.title} ${item.category}`,
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
      onOpenChange={onOpenChange}
      title="Place Actors"
      description="Spawn a shape, light, camera, volume, or project asset into the scene."
      size="medium"
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={setActiveCategory}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search actors"
      data-testid="place-actors-catalog"
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
            >
              {section.items.map((item) => (
                <CatalogTile
                  key={item.id}
                  data-testid={`place-actors-item-${item.id}`}
                  title={item.title}
                  visual={visualForPlaceActor(item)}
                  onSelect={() => onSelect(item)}
                />
              ))}
            </CatalogTileGroup>
          ))}
        </div>
      )}
    </CatalogDialog>
  );
}
