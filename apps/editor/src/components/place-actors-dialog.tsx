import { useMemo, useState } from "react";
import { ArrowUpDownIcon, FolderIcon, ListFilterIcon } from "lucide-react";
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
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
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
} from "@haptic/ui/components/dropdown-menu";
import { useEditorSessionState } from "../context/editor-session-state-context";
import {
  featuredPlaceActors,
  visualForPlaceActor,
  placeActorsForHost,
  type PlaceActorItem,
  type PlaceActorsAssetSort as AssetSort,
  type PlaceActorsView,
} from "../lib/place-actors";
import { CatalogNoMatches } from "./catalog-no-matches";
import { useThumbnailUrls, type LoadThumbnail } from "../lib/use-thumbnail-urls";

const FEATURED = "featured";
const MODELS = "Models";
const PROJECT = "Project";
const ALL_FOLDERS = "";

const INITIAL_VIEW: PlaceActorsView = {
  search: "",
  category: FEATURED,
  typeFilters: [],
  projectFolder: ALL_FOLDERS,
  modelFolder: ALL_FOLDERS,
  projectSort: "name",
  modelSort: "name",
  scrollTop: 0,
};

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

/** Containing folder of an asset path (`assets/props/Tree.model.hasset` → `assets/props`). */
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

/** Filter and Sort for Models and Project, in the search row; inactive while a search lists results. */
function AssetControls({
  scope,
  items,
  typeFilters,
  onTypeFiltersChange,
  folder,
  onFolderChange,
  sort,
  onSortChange,
  disabled,
}: {
  scope: string;
  items: readonly PlaceActorItem[];
  typeFilters?: string[];
  onTypeFiltersChange?: (types: string[]) => void;
  folder: string;
  onFolderChange: (folder: string) => void;
  sort: AssetSort;
  onSortChange: (sort: AssetSort) => void;
  disabled: boolean;
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
    <div className="flex shrink-0 items-center gap-2" data-testid={`${prefix}-toolbar`}>
      {filterTypes || filterFolders ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
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
          <DropdownMenuContent
            align="end"
            className="min-w-44"
            data-popup-picker=""
            data-testid={`${prefix}-filter-menu`}
          >
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
          disabled={disabled}
          render={<Button type="button" variant="outline" size="sm" data-testid={`${prefix}-sort`} aria-label="Sort" />}
        >
          <ArrowUpDownIcon data-icon="inline-start" />
          Sort
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44" data-popup-picker="">
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
  anchor,
  loadThumbnail,
  thumbnailVersions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: PlaceActorItem) => void;
  projectItems: PlaceActorItem[];
  overlay?: boolean;
  /** Viewport point the popup opens from; centered without one. */
  anchor?: { x: number; y: number } | null;
  loadThumbnail?: LoadThumbnail;
  thumbnailVersions?: Readonly<Record<string, number>>;
}) {
  // Search, category, filters, sort and scroll reopen as the user left them
  // for the rest of the project session (memory only), however the popup
  // closed, and separately for Scene Layers. `view.scrollTop` is the offset
  // restored on open; scrolling writes the store only, never re-renders.
  const session = useEditorSessionState();
  const [view, setView] = useState(
    () => session.loadPlaceActorsView(overlay) ?? INITIAL_VIEW,
  );
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setView(session.loadPlaceActorsView(overlay) ?? INITIAL_VIEW);
  }
  const change = (patch: Partial<Omit<PlaceActorsView, "scrollTop">>) => {
    const next = { ...view, ...patch };
    setView(next);
    session.savePlaceActorsView(overlay, {
      ...next,
      scrollTop: session.loadPlaceActorsView(overlay)?.scrollTop ?? next.scrollTop,
    });
  };
  const { search, typeFilters, projectFolder, modelFolder, projectSort, modelSort } = view;

  const items = useMemo(
    () => [...placeActorsForHost({ overlay }), ...projectItems],
    [overlay, projectItems],
  );
  const featured = useMemo(() => featuredPlaceActors(items, { overlay }), [items, overlay]);
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
  // A remembered category can disappear with its last asset.
  const activeCategory = categories.some((category) => category.id === view.category)
    ? view.category
    : FEATURED;

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
      size="compact"
      data-testid={`place-actors-item-${item.id}`}
      title={item.title}
      description={description}
      leading={<TypeVisualIcon visual={visualForPlaceActor(item)} />}
      striped={index % 2 === 1}
      onSelect={() => onSelect(item)}
    />
  );
  const card = (item: PlaceActorItem, subtitle?: string, imageUrl?: string) => (
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
            row(item, index, item.kind.type === "asset" ? assetLine(item) : item.category),
          )}
        </div>
      );
  } else if (activeCategory === FEATURED) {
    body = (
      <CatalogCardGrid label="Featured" size="compact">
        {featured.map((item) => card(item))}
      </CatalogCardGrid>
    );
  } else if (activeCategory === MODELS) {
    body = (
      <CatalogCardGrid label={MODELS} size="compact">
        {visibleModels.map((item) =>
          card(item, assetFolder(item) || undefined, thumbnails[assetGuid(item) ?? ""]),
        )}
      </CatalogCardGrid>
    );
  } else if (activeCategory === PROJECT) {
    body =
      visibleProject.length === 0 ? (
        <FilteredEmpty
          onClear={() => change({ typeFilters: [], projectFolder: ALL_FOLDERS })}
        />
      ) : (
        <div role="group" aria-label={PROJECT} className="flex flex-col">
          {visibleProject.map((item, index) => row(item, index, assetLine(item)))}
        </div>
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

  // Filter and Sort share the fixed search row, so they never scroll away.
  const controls =
    activeCategory === MODELS ? (
      <AssetControls
        scope="models"
        items={models}
        folder={modelFolder}
        onFolderChange={(folder) => change({ modelFolder: folder })}
        sort={modelSort}
        onSortChange={(sort) => change({ modelSort: sort })}
        disabled={searching}
      />
    ) : activeCategory === PROJECT ? (
      <AssetControls
        scope="project"
        items={project}
        typeFilters={typeFilters}
        onTypeFiltersChange={(types) => change({ typeFilters: types })}
        folder={projectFolder}
        onFolderChange={(folder) => change({ projectFolder: folder })}
        sort={projectSort}
        onSortChange={(sort) => change({ projectSort: sort })}
        disabled={searching}
      />
    ) : null;

  return (
    <CatalogDialog
      open={open}
      onOpenChange={onOpenChange}
      presentation="popup"
      anchor={anchor}
      title="Place Actors"
      categories={categories}
      groups={groups}
      activeCategoryId={activeCategory}
      onCategoryChange={(id) => change({ category: id, search: "" })}
      search={search}
      onSearchChange={(value) => change({ search: value })}
      searchPlaceholder="Search actors and assets"
      searchAccessory={controls}
      initialScrollTop={view.scrollTop}
      onBodyScroll={(scrollTop) =>
        session.savePlaceActorsView(overlay, { ...view, scrollTop })
      }
      data-testid="place-actors-catalog"
    >
      {body}
    </CatalogDialog>
  );
}
