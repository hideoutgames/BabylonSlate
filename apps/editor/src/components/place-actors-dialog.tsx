import { useEffect, useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogItemButton,
  TypeVisualIcon,
  useCatalogFilter,
} from "@babylonslate/editor-kit";
import {
  ENGINE_PLACE_ACTORS,
  visualForPlaceActor,
  type PlaceActorItem,
} from "../lib/place-actors";

export function PlaceActorsDialog({
  open,
  onOpenChange,
  onSelect,
  projectItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: PlaceActorItem) => void;
  projectItems: PlaceActorItem[];
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
    () => [...ENGINE_PLACE_ACTORS, ...projectItems],
    [projectItems],
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
    (item) => `${item.title} ${item.category}`,
  );
  const visible =
    activeCategory === "all"
      ? bySearch
      : bySearch.filter((item) => item.category === activeCategory);

  return (
    <CatalogDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Place Actors"
      description="Spawn a shape, light, camera, empty actor, or project asset."
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={setActiveCategory}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search actors"
      data-testid="place-actors-catalog"
    >
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((item) => (
            <CatalogItemButton
              key={item.id}
              data-testid={`place-actors-item-${item.id}`}
              onClick={() => onSelect(item)}
            >
              <TypeVisualIcon visual={visualForPlaceActor(item)} />
              <span className="truncate">{item.title}</span>
            </CatalogItemButton>
          ))}
        </div>
      )}
    </CatalogDialog>
  );
}
