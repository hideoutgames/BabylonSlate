import { useEffect, useMemo, useState } from "react";
import { ArrowUpDownIcon, FolderIcon, ListFilterIcon } from "lucide-react";
import { thumbnailMime } from "@babylonslate/assets";
import {
  CatalogCard,
  CatalogCardGrid,
  CatalogDialog,
  CatalogResultRow,
  TypeVisualIcon,
  resolveTypeVisual,
  useCatalogFilter,
  type CatalogCategory,
  type CatalogCategoryGroup,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
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
const ALL_FOLDERS = "";

type LoadThumbnail = (guid: string) => Promise<Uint8Array | null>;
type AssetSort = "name" | "type" | "folder";

const SORT_OPTIONS: ReadonlyArray<{ id: AssetSort; label: string }> = [
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
  { id: "folder", label: "Folder" },
];

function assetGuid(item: PlaceActorItem): string | null {
  return item.kind.type === "asset" ? item.kind.guid : null;
}

function assetType(item: PlaceActorItem): string {
  return item.kind.type === "asset" ? (item.kind.assetType ?? "") : "";
}

/** `ParticleSystem` → `Particle System`, matching Content Browser type names. */
function typeLabel(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/** Containing folder of an asset path (`assets/props/Tree.model.babasset` → `assets/props`). */
function assetFolder(item: PlaceActorItem): string {
  const path = item.kind.type === "asset" ? item.kind.path : undefined;
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function sortAssets(items: readonly PlaceActorItem[], sort: AssetSort): PlaceActorItem[] {
  const byName = (a: PlaceActorItem, b: PlaceActorItem) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
  const key = sort === "type" ? assetType : sort === "folder" ? assetFolder : null;
  return [...items].sort((a, b) => (key ? key(a).localeCompare(key(b)) : 0) || byName(a, b));
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

function AssetToolbar({
  scope,
  items,
  typeFilters,
  onTypeFiltersChange,
  folder,
  onFolderChange,
  sort,
  onSortChange,
  shown,
}: {
  scope: string;
  items: readonly PlaceActorItem[];
  typeFilters?: string[];
  onTypeFiltersChange?: (types: string[]) => void;
  folder: string;
  onFolderChange: (folder: string) => void;
  sort: AssetSort;
  onSortChange: (sort: AssetSort) => void;
  shown: number;
}) {
  const types = useMemo(
    () => [...new Set(items.map(assetType))].filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [items],
  );
  const folders = useMemo(
    () => [...new Set(items.map(assetFolder))].sort((a, b) => a.localeCompare(b)),
    [items],
  );
  const prefix = `place-actors-${scope}`;
  const filterTypes = typeFilters && onTypeFiltersChange && types.length > 1;
  const filterFolders = folders.length > 1;
  const activeFilters = (typeFilters?.length ?? 0) + (folder === ALL_FOLDERS ? 0 : 1);
  const sortOptions = typeFilters ? SORT_OPTIONS : SORT_OPTIONS.filter((option) => option.id !== "type");

  return (
    <div
      className="sticky -top-4 z-10 -mx-4 -mt-4 mb-2 flex items-center gap-2 border-b bg-popover px-4 py-2"
      data-testid={`${prefix}-toolbar`}
    >
      <span className="mr-auto text-xs text-muted-foreground tabular-nums" data-testid={`${prefix}-count`}>
        {shown === items.length
          ? `${shown} ${shown === 1 ? "Asset" : "Assets"}`
          : `${shown} of ${items.length} Assets`}
      </span>
      {filterTypes || filterFolders ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant={activeFilters > 0 ? "secondary" : "outline"}
                size="sm"
                data-testid={`${prefix}-filter`}
                aria-label={activeFilters > 0 ? `Filter (${activeFilters})` : "Filter"}
              />
            }
          >
            <ListFilterIcon data-icon="inline-start" />
            {`Filter${activeFilters > 0 ? ` (${activeFilters})` : ""}`}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44" data-testid={`${prefix}-filter-menu`}>
            {filterTypes ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Asset Types</DropdownMenuLabel>
                {types.map((type) => (
                  <DropdownMenuCheckboxItem
                    key={type}
                    checked={typeFilters.includes(type)}
                    data-testid={`${prefix}-filter-${type}`}
                    onCheckedChange={(checked) =>
                      onTypeFiltersChange(
                        checked === true
                          ? [...typeFilters.filter((entry) => entry !== type), type]
                          : typeFilters.filter((entry) => entry !== type),
                      )
                    }
                  >
                    <TypeVisualIcon visual={resolveTypeVisual({ assetType: type })} className="size-4" />
                    {typeLabel(type)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            ) : null}
            {filterTypes && filterFolders ? <DropdownMenuSeparator /> : null}
            {filterFolders ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Folder</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={folder} onValueChange={(value) => onFolderChange(value as string)}>
                  <DropdownMenuRadioItem value={ALL_FOLDERS}>All Folders</DropdownMenuRadioItem>
                  {folders.filter(Boolean).map((entry) => (
                    <DropdownMenuRadioItem key={entry} value={entry} data-testid={`${prefix}-folder-${entry}`}>
                      <FolderIcon className="size-4 text-muted-foreground" />
                      {entry}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="outline" size="sm" data-testid={`${prefix}-sort`} aria-label="Sort" />}
        >
          <ArrowUpDownIcon data-icon="inline-start" />
          Sort
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sort By</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as AssetSort)}>
              {sortOptions.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id} data-testid={`${prefix}-sort-${option.id}`}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function FilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
      No assets match these filters.
      <Button type="button" variant="outline" size="sm" onClick={onClear}>
        Clear Filters
      </Button>
    </div>
  );
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
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [projectFolder, setProjectFolder] = useState(ALL_FOLDERS);
  const [modelFolder, setModelFolder] = useState(ALL_FOLDERS);
  const [projectSort, setProjectSort] = useState<AssetSort>("name");
  const [modelSort, setModelSort] = useState<AssetSort>("name");

  // The Outliner closes this dialog itself once an actor spawns, so resetting
  // from `onOpenChange` alone would leave the previous filter in place. Sort
  // order is a preference and survives reopening.
  useEffect(() => {
    if (open) return;
    setSearch("");
    setActiveCategory(FEATURED);
    setTypeFilters([]);
    setProjectFolder(ALL_FOLDERS);
    setModelFolder(ALL_FOLDERS);
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
  const models = useMemo(() => items.filter((item) => item.category === MODELS), [items]);
  const project = useMemo(() => items.filter((item) => item.category === PROJECT), [items]);

  const bySearch = useCatalogFilter(
    items,
    search,
    (item) => `${item.title} ${item.category} ${assetType(item)} ${assetFolder(item)}`,
  );
  const searching = search.trim().length > 0;

  const { categories, groups } = useMemo(() => {
    const counted = searching ? bySearch : items;
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.category, 0);
    for (const item of counted) counts.set(item.category, counts.get(item.category)! + 1);
    const content = [MODELS, PROJECT].filter((id) => counts.has(id));
    const engine = [...counts.keys()].filter((id) => !content.includes(id));
    const list: CatalogCategory[] = [
      ...content.map((id) => ({ id, label: id, count: counts.get(id) })),
      { id: FEATURED, label: "Featured" },
      ...engine.map((id) => ({ id, label: id, count: counts.get(id) })),
    ];
    const grouped: CatalogCategoryGroup[] = [
      ...(content.length ? [{ label: "Content", ids: content }] : []),
      { label: "Engine", ids: [FEATURED, ...engine] },
    ];
    return { categories: list, groups: grouped };
  }, [bySearch, items, searching]);

  const visibleModels = useMemo(
    () =>
      sortAssets(
        models.filter((item) => modelFolder === ALL_FOLDERS || assetFolder(item) === modelFolder),
        modelSort,
      ),
    [modelFolder, modelSort, models],
  );
  const visibleProject = useMemo(
    () =>
      sortAssets(
        project.filter(
          (item) =>
            (typeFilters.length === 0 || typeFilters.includes(assetType(item))) &&
            (projectFolder === ALL_FOLDERS || assetFolder(item) === projectFolder),
        ),
        projectSort,
      ),
    [project, projectFolder, projectSort, typeFilters],
  );

  const thumbnails = useThumbnailUrls(
    useMemo(() => models.flatMap((item) => assetGuid(item) ?? []), [models]),
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
  const assetLine = (item: PlaceActorItem) =>
    [typeLabel(assetType(item)), assetFolder(item)].filter(Boolean).join(" · ");

  let body;
  if (searching) {
    body =
      bySearch.length === 0 ? (
        <CatalogNoMatches search={search} />
      ) : (
        <div role="group" aria-label="Search Results" className="flex flex-col">
          {bySearch.map((item, index) =>
            row(item, index, item.kind.type === "asset" ? `${item.category} · ${assetLine(item)}` : item.category),
          )}
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
      <>
        <AssetToolbar
          scope="models"
          items={models}
          folder={modelFolder}
          onFolderChange={setModelFolder}
          sort={modelSort}
          onSortChange={setModelSort}
          shown={visibleModels.length}
        />
        <CatalogCardGrid label={MODELS}>
          {visibleModels.map((item) =>
            card(item, assetFolder(item) || "Model", thumbnails[assetGuid(item) ?? ""]),
          )}
        </CatalogCardGrid>
      </>
    );
  } else if (activeCategory === PROJECT) {
    body = (
      <>
        <AssetToolbar
          scope="project"
          items={project}
          typeFilters={typeFilters}
          onTypeFiltersChange={setTypeFilters}
          folder={projectFolder}
          onFolderChange={setProjectFolder}
          sort={projectSort}
          onSortChange={setProjectSort}
          shown={visibleProject.length}
        />
        {visibleProject.length === 0 ? (
          <FilteredEmpty
            onClear={() => {
              setTypeFilters([]);
              setProjectFolder(ALL_FOLDERS);
            }}
          />
        ) : (
          <div role="group" aria-label={PROJECT} className="flex flex-col">
            {visibleProject.map((item, index) => row(item, index, assetLine(item)))}
          </div>
        )}
      </>
    );
  } else {
    body = (
      <div role="group" aria-label={activeCategory} className="flex flex-col">
        {items
          .filter((item) => item.category === activeCategory)
          .map((item, index) => row(item, index))}
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
      groups={groups}
      activeCategoryId={activeCategory}
      onCategoryChange={(id) => {
        setActiveCategory(id);
        setSearch("");
      }}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search actors and assets"
      data-testid="place-actors-catalog"
    >
      {body}
    </CatalogDialog>
  );
}
