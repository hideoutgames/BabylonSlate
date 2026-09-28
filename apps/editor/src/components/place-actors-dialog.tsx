import { useEffect, useMemo, useState } from "react";
import { thumbnailMime } from "@babylonslate/assets";
import {
  CatalogCard,
  CatalogCardGrid,
  CatalogDialog,
  CatalogResultRow,
  TypeVisualIcon,
  useCatalogFilter,
  type CatalogCategory,
} from "@babylonslate/editor-kit";
import {
  FEATURED_PLACE_ACTOR_IDS,
  visualForPlaceActor,
  placeActorsForHost,
  type PlaceActorItem,
} from "../lib/place-actors";
import { CatalogNoMatches } from "./catalog-no-matches";

const FEATURED = "featured";
const MODELS = "Models";
const PROJECT = "Project";

type LoadThumbnail = (guid: string) => Promise<Uint8Array | null>;

function assetGuid(item: PlaceActorItem): string | null {
  return item.kind.type === "asset" ? item.kind.guid : null;
}

/** Object URLs for model thumbnails while `enabled`; released when hidden or changed. */
function useThumbnailUrls(
  guids: readonly string[],
  load: LoadThumbnail | undefined,
  versions: Readonly<Record<string, number>> | undefined,
  enabled: boolean,
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = enabled
    ? guids.map((guid) => `${guid}:${versions?.[guid] ?? 0}`).join("|")
    : "";
  useEffect(() => {
    if (!key || !load) return;
    let cancelled = false;
    const created: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const guid of key.split("|").map((entry) => entry.split(":")[0]!)) {
        const bytes = await load(guid).catch(() => null);
        if (cancelled) return;
        if (!bytes) continue;
        const url = URL.createObjectURL(new Blob([bytes], { type: thumbnailMime(bytes) }));
        created.push(url);
        next[guid] = url;
      }
      if (!cancelled) setUrls(next);
    })();
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
      setUrls({});
    };
  }, [key, load]);
  return urls;
}

export function PlaceActorsDialog({
  open,
  onOpenChange,
  onSelect,
  projectItems,
  overlay = false,
  loadThumbnail,
  thumbnailVersions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: PlaceActorItem) => void;
  projectItems: PlaceActorItem[];
  overlay?: boolean;
  loadThumbnail?: LoadThumbnail;
  thumbnailVersions?: Readonly<Record<string, number>>;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState(FEATURED);

  // The Outliner closes this dialog itself once an actor spawns, so resetting
  // from `onOpenChange` alone would leave the previous filter in place.
  useEffect(() => {
    if (open) return;
    setSearch("");
    setActiveCategory(FEATURED);
  }, [open]);

  const items = useMemo(
    () => [...placeActorsForHost({ overlay }), ...projectItems],
    [overlay, projectItems],
  );
  const featured = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return FEATURED_PLACE_ACTOR_IDS.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }, [items]);

  const bySearch = useCatalogFilter(
    items,
    search,
    (item) => `${item.title} ${item.category}`,
  );
  const searching = search.trim().length > 0;

  const categories = useMemo((): CatalogCategory[] => {
    const counted = searching ? bySearch : items;
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.category, 0);
    for (const item of counted) counts.set(item.category, counts.get(item.category)! + 1);
    const content = [MODELS, PROJECT].filter((id) => counts.has(id));
    const engine = [...counts.keys()].filter((id) => !content.includes(id));
    return [
      { id: FEATURED, label: "Featured", count: featured.length },
      ...[...engine, ...content].map((id) => ({ id, label: id, count: counts.get(id) })),
    ];
  }, [bySearch, featured.length, items, searching]);

  const inCategory = items.filter((item) => item.category === activeCategory);
  const modelGuids = useMemo(
    () =>
      items
        .filter((item) => item.category === MODELS)
        .flatMap((item) => assetGuid(item) ?? []),
    [items],
  );
  const thumbnails = useThumbnailUrls(
    modelGuids,
    loadThumbnail,
    thumbnailVersions,
    open && !searching && activeCategory === MODELS,
  );

  const row = (item: PlaceActorItem, index: number, description?: string) => (
    <CatalogResultRow
      key={item.id}
      data-testid={`place-actors-item-${item.id}`}
      title={item.title}
      description={description}
      leading={<TypeVisualIcon visual={visualForPlaceActor(item)} />}
      striped={index % 2 === 1}
      onSelect={() => onSelect(item)}
    />
  );
  const card = (item: PlaceActorItem, subtitle: string, imageUrl?: string) => (
    <CatalogCard
      key={item.id}
      data-testid={`place-actors-item-${item.id}`}
      title={item.title}
      subtitle={subtitle}
      visual={visualForPlaceActor(item)}
      imageUrl={imageUrl}
      onSelect={() => onSelect(item)}
    />
  );

  let body;
  if (searching) {
    body =
      bySearch.length === 0 ? (
        <CatalogNoMatches search={search} />
      ) : (
        <div role="group" aria-label="Search Results" className="flex flex-col">
          {bySearch.map((item, index) => row(item, index, item.category))}
        </div>
      );
  } else if (activeCategory === FEATURED) {
    body = (
      <CatalogCardGrid label="Featured">
        {featured.map((item) => card(item, item.category))}
      </CatalogCardGrid>
    );
  } else if (activeCategory === MODELS) {
    body = (
      <CatalogCardGrid label={MODELS}>
        {inCategory.map((item) => card(item, "Model", thumbnails[assetGuid(item) ?? ""]))}
      </CatalogCardGrid>
    );
  } else {
    body = (
      <div role="group" aria-label={activeCategory} className="flex flex-col">
        {inCategory.map((item, index) =>
          row(
            item,
            index,
            item.kind.type === "asset" ? item.kind.assetType : undefined,
          ),
        )}
      </div>
    );
  }

  return (
    <CatalogDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Place Actors"
      description="Spawn a shape, light, camera, volume, or project asset into the scene."
      size="medium"
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={(id) => {
        setActiveCategory(id);
        setSearch("");
      }}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search actors"
      data-testid="place-actors-catalog"
    >
      {body}
    </CatalogDialog>
  );
}
