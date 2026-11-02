import type { IDockviewPanelProps } from "dockview-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowUpDownIcon,
  FolderIcon,
  LayoutGridIcon,
  ListFilterIcon,
  ListIcon,
  MousePointerClickIcon,
  PlusIcon,
  PuzzleIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import {
  documentKindForAssetType,
  isSceneWorkspaceKind,
  type SerializedScene,
} from "@haptic/core";
import {
  CatalogCard,
  CatalogCardGrid,
  ContextMenuOverlay,
  PanelFrame,
  SearchInput,
  TreeView,
  TypeVisualIcon,
  useContextMenu,
  type NestedMenuItem,
  type TreeSelectOptions,
  type TreeViewNode,
} from "@haptic/editor-kit";
import { GraphDropHint, type GraphDropHintState } from "@haptic/graph-ui";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import {
  useDocumentActions,
  useEditorShellState,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useEditorSessionState } from "../context/editor-session-state-context";
import { usePlaySimulationDocumentId } from "../context/play-context";
import { useOptionalProjectSearch } from "../context/project-search-context";
import { useSceneEditing } from "../context/scene-editing-context";
import type { AssetsPanelPreferences } from "../lib/editor-session-state";
import type { PlaceActorItem } from "../lib/place-actors";
import { pluginRootId } from "../lib/plugin-ui";
import {
  SCENE_ASSET_KIND_LABELS,
  draggedSceneAssetIds,
  filterSceneAssets,
  sceneAssetDropPositions,
  sceneAssetFilterKinds,
  sceneAssetFolders,
  sceneAssetItems,
  selectSceneAsset,
  sortSceneAssets,
  type SceneAssetItem,
  type SceneAssetKind,
  type SceneAssetSelection,
  type SceneAssetSort,
} from "../lib/scene-assets";
import { useDockPanelShown } from "../lib/use-dock-panel-shown";
import { useDragOutGestures } from "../lib/use-drag-out-gestures";
import { usePlaceActorItems } from "../lib/use-place-actor-items";
import { useProjectPlaceActors } from "../lib/use-project-place-actors";
import { useRetainedValue } from "../lib/use-retained-value";
import { useThumbnailUrls } from "../lib/use-thumbnail-urls";
import { usePhoneTouchSizing } from "../shell/use-platform-layout";

const NO_PLACE_ACTOR_ITEMS: PlaceActorItem[] = [];
const NO_SELECTION: SceneAssetSelection = { ids: [], anchor: null };
const DOUBLE_TAP_MS = 350;

const SORT_OPTIONS: ReadonlyArray<{ id: SceneAssetSort; label: string }> = [
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
  { id: "folder", label: "Folder" },
];

/** Classes and Models have captured thumbnails; the rest keep their type icon. */
function hasThumbnail(entry: SceneAssetItem): boolean {
  return entry.guid !== null && (entry.kind === "model" || entry.kind === "actor" || entry.kind === "layer-actor");
}

function PluginMark({ name }: { name: string }) {
  return (
    <span
      role="img"
      aria-label={`Plugin: ${name}`}
      title={`Plugin: ${name}`}
      className="flex shrink-0 text-muted-foreground"
      data-testid="scene-assets-plugin-mark"
    >
      <PuzzleIcon aria-hidden className="size-2.5" />
    </span>
  );
}

type CardProps = {
  entry: SceneAssetItem;
  selected: boolean;
  imageUrl?: string;
  onSelect: (
    id: string,
    event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  onPointerDown: (id: string, event: ReactPointerEvent) => void;
  onContextMenu: (id: string, clientX: number, clientY: number) => void;
};

const AssetCard = memo(function AssetCard({
  entry,
  selected,
  imageUrl,
  onSelect,
  onPointerDown,
  onContextMenu,
}: CardProps) {
  return (
    <CatalogCard
      role="option"
      aria-selected={selected}
      title={entry.title}
      visual={entry.visual}
      imageUrl={imageUrl}
      density="compact"
      selected={selected}
      titleAdornment={entry.pluginName ? <PluginMark name={entry.pluginName} /> : null}
      onSelect={(event) => onSelect(entry.id, event)}
      onPointerDown={(event) => onPointerDown(entry.id, event)}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(entry.id, event.clientX, event.clientY);
      }}
      className="cursor-grab"
      data-testid={`scene-assets-card-${entry.id}`}
    />
  );
});

/**
 * Scene and Scene Layer Design mode: the project's placeable Models and
 * Actor Classes (a Scene Layer adds its built-in 2D elements first) as
 * compact cards or a list. Search, Asset Types, Folder and Show Plugin
 * Content narrow it; picks follow the Outliner's multi-selection; drag one
 * entry or the selection onto the Viewport, or use Place, to add actors.
 */
export function SceneAssetsPanel({ api }: IDockviewPanelProps) {
  const touchSizing = usePhoneTouchSizing();
  const actionSize = touchSizing ? "touch-icon" : "icon-sm";
  const { documentId } = useDocumentWorkspace();
  const doc = useOpenDocument(documentId);
  const scene = isSceneWorkspaceKind(doc?.ref.kind) ? (doc.content as SerializedScene) : null;
  const overlay = doc?.ref.kind === "scene-layer";
  const simulating = usePlaySimulationDocumentId() === documentId;
  const shown = useDockPanelShown(api);
  const { openDocument, loadAssetThumbnail } = useDocumentActions();
  const { thumbnailVersions } = useEditorShellState();
  const { assetRegistry, registryEpoch, pluginDescriptors } = useRegistryState();
  const projectSearch = useOptionalProjectSearch();
  const { viewportDropApi } = useSceneEditing();
  const sessionState = useEditorSessionState();

  const [preferences, setPreferences] = useState<AssetsPanelPreferences>(() =>
    sessionState.readAssetsPanelPreferences(),
  );
  const updatePreferences = useCallback(
    (next: Partial<AssetsPanelPreferences>) => {
      sessionState.writeAssetsPanelPreferences(next);
      setPreferences((current) => ({ ...current, ...next }));
    },
    [sessionState],
  );
  const { view, sort, showPluginContent } = preferences;
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<SceneAssetKind[]>([]);
  const [folder, setFolder] = useState("");
  const [selection, setSelection] = useState<SceneAssetSelection>(NO_SELECTION);
  const [dropHint, setDropHint] = useState<GraphDropHintState | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Built only while the panel is on screen; hidden, it keeps the last list.
  const { items: shownProjectItems, graphForPath } = useProjectPlaceActors({
    enabled: shown && Boolean(scene),
    overlay,
  });
  const projectItems = useRetainedValue(shownProjectItems, NO_PLACE_ACTOR_ITEMS);

  const allEntries = useMemo(() => {
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const names = new Map(
      pluginDescriptors.map((plugin) => [pluginRootId(plugin.pluginGuid), plugin.settings.displayName]),
    );
    return sceneAssetItems({
      projectItems,
      assets: assetRegistry?.list() ?? [],
      overlay,
      pluginName: (rootId) => names.get(rootId) ?? null,
    });
  }, [assetRegistry, overlay, pluginDescriptors, projectItems, registryEpoch]);
  const byId = useMemo(() => new Map(allEntries.map((entry) => [entry.id, entry])), [allEntries]);
  const pluginEntries = useMemo(
    () => (showPluginContent ? allEntries : allEntries.filter((entry) => entry.pluginName === null)),
    [allEntries, showPluginContent],
  );
  const folders = useMemo(() => sceneAssetFolders(pluginEntries), [pluginEntries]);
  const visible = useMemo(
    () => sortSceneAssets(filterSceneAssets(allEntries, { search, kinds, showPluginContent, folder }), sort),
    [allEntries, folder, kinds, search, showPluginContent, sort],
  );
  const orderedIds = useMemo(() => visible.map((entry) => entry.id), [visible]);
  // Entries hidden by search or filters leave the selection: Place and drag act on what is shown.
  const selectedIds = useMemo(() => {
    const shownIds = new Set(orderedIds);
    return selection.ids.filter((id) => shownIds.has(id));
  }, [orderedIds, selection.ids]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const thumbnailGuids = useMemo(
    () => allEntries.filter(hasThumbnail).map((entry) => entry.guid!).sort(),
    [allEntries],
  );
  const thumbnails = useThumbnailUrls(
    thumbnailGuids,
    loadAssetThumbnail,
    thumbnailVersions,
    shown && view === "cards",
  );

  const placeItems = usePlaceActorItems({ documentId, scene, overlay, graphForPath });
  const canPlace = Boolean(scene) && !simulating;
  const placeAt = useCallback(
    (ids: readonly string[], center: readonly [number, number, number]) => {
      if (!canPlace || !scene) return;
      const entries = ids.flatMap((id) => byId.get(id) ?? []);
      if (entries.length === 0) return;
      const plane = overlay || scene.viewportMode === "2d" ? "xy" : "xz";
      placeItems(
        entries.map((entry) => entry.item),
        sceneAssetDropPositions(center, entries.length, plane),
      );
    },
    [byId, canPlace, overlay, placeItems, scene],
  );
  const placeAtViewCenter = useCallback(
    (ids: readonly string[]) => placeAt(ids, viewportDropApi.worldPositionAtViewCenter()),
    [placeAt, viewportDropApi],
  );

  const select = useCallback(
    (id: string, options?: TreeSelectOptions) => {
      const shownIds = new Set(orderedIds);
      setSelection((current) =>
        selectSceneAsset(id, options, orderedIds, {
          ids: current.ids.filter((entry) => shownIds.has(entry)),
          anchor: current.anchor,
        }),
      );
    },
    [orderedIds],
  );

  const dragLabel = useCallback(
    (id: string) => {
      const ids = draggedSceneAssetIds(id, selectedIds, orderedIds);
      return ids.length === 1 ? (byId.get(ids[0]!)?.title ?? "Asset") : `${ids.length} Assets`;
    },
    [byId, orderedIds, selectedIds],
  );
  const onDragMove = useCallback(
    (id: string, clientX: number, clientY: number) => {
      setDropHint({
        clientX,
        clientY,
        allowed: canPlace && viewportDropApi.containsClientPoint(clientX, clientY),
        label: dragLabel(id),
      });
    },
    [canPlace, dragLabel, viewportDropApi],
  );
  const onDrop = useCallback(
    (id: string, clientX: number, clientY: number) => {
      setDropHint(null);
      if (!canPlace || !viewportDropApi.containsClientPoint(clientX, clientY)) return;
      const position = viewportDropApi.worldPositionAtClient(clientX, clientY);
      if (!position) return;
      placeAt(draggedSceneAssetIds(id, selectedIds, orderedIds), position);
    },
    [canPlace, orderedIds, placeAt, selectedIds, viewportDropApi],
  );
  const onDragEnd = useCallback(() => setDropHint(null), []);

  /**
   * The menu of an entry acts on the group when the entry is part of one, on
   * the entry alone otherwise, like the Class tree. `previous` is the
   * selection a hold or right-click on an unselected entry replaced: Select
   * adds the entry to it, since touch has no modifier keys.
   */
  const menuItemsFor = useCallback(
    (id: string, groupIds: readonly string[], previous: readonly string[]): NestedMenuItem[] => {
      const entry = byId.get(id);
      if (!entry) return [];
      const count = groupIds.length;
      const openKind = entry.path && entry.item.kind.type === "asset"
        ? documentKindForAssetType(entry.item.kind.assetType ?? "")
        : null;
      return [
        {
          id: "place",
          label: count > 1 ? `Place ${count} Assets` : overlay ? "Place in Scene Layer" : "Place in Scene",
          icon: <PlusIcon />,
          disabled: !canPlace,
          testId: "scene-assets-menu-place",
          onSelect: () => placeAtViewCenter(groupIds),
        },
        ...(count > 1
          ? [{
              id: "deselect",
              label: "Deselect",
              icon: <MousePointerClickIcon />,
              testId: "scene-assets-menu-deselect",
              onSelect: () => {
                const rest = groupIds.filter((entryId) => entryId !== id);
                setSelection({ ids: rest, anchor: rest[rest.length - 1] ?? null });
              },
            }]
          : previous.length > 0
            ? [{
                id: "select",
                label: "Select",
                icon: <MousePointerClickIcon />,
                testId: "scene-assets-menu-select",
                onSelect: () => setSelection({ ids: [...previous, id], anchor: id }),
              }]
            : []),
        { type: "separator" as const, id: "asset-separator" },
        {
          id: "open",
          label: "Open",
          icon: <SquareArrowOutUpRightIcon />,
          disabled: count !== 1 || !openKind,
          testId: "scene-assets-menu-open",
          onSelect: () => {
            if (openKind && entry.path) void openDocument({ kind: openKind, path: entry.path, label: entry.title });
          },
        },
        {
          id: "reveal",
          label: "Show in Content Browser",
          icon: <FolderIcon />,
          disabled: count !== 1 || !entry.guid || !entry.path || !projectSearch,
          testId: "scene-assets-menu-reveal",
          onSelect: () => {
            if (entry.guid && entry.path) projectSearch?.revealAsset(entry.guid, entry.path);
          },
        },
      ];
    },
    [byId, canPlace, openDocument, overlay, placeAtViewCenter, projectSearch],
  );
  const { menu, closeMenu, openMenuAt } = useContextMenu({ items: [] });
  const openEntryMenu = useCallback(
    (id: string, clientX: number, clientY: number) => {
      // A hold or right-click on an unselected entry replaces the selection; on a selected one it keeps the group.
      const inGroup = selectedSet.has(id);
      const groupIds = inGroup ? draggedSceneAssetIds(id, selectedIds, orderedIds) : [id];
      if (!inGroup) setSelection({ ids: [id], anchor: id });
      openMenuAt(clientX, clientY, menuItemsFor(id, groupIds, inGroup ? [] : selectedIds));
    },
    [menuItemsFor, openMenuAt, orderedIds, selectedIds, selectedSet],
  );

  const gestures = useDragOutGestures(scrollRef, {
    dragEnabled: canPlace,
    onDragMove,
    onDrop,
    onDragEnd,
    onLongPress: openEntryMenu,
  });

  const onCardSelect = useCallback(
    (id: string, event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>) => {
      const modifier = event.ctrlKey || event.metaKey;
      if ("key" in event && event.key === "Enter" && !modifier && !event.shiftKey) {
        placeAtViewCenter(draggedSceneAssetIds(id, selectedIds, orderedIds));
        return;
      }
      select(id, event.shiftKey ? { range: true } : modifier ? { additive: true } : undefined);
      if ("key" in event || event.shiftKey || modifier) return;
      const now = Date.now();
      const last = lastTapRef.current;
      if (last && last.id === id && now - last.at <= DOUBLE_TAP_MS) {
        lastTapRef.current = null;
        placeAtViewCenter([id]);
      } else {
        lastTapRef.current = { id, at: now };
      }
    },
    [orderedIds, placeAtViewCenter, select, selectedIds],
  );

  const treeNodes = useMemo<TreeViewNode[]>(
    () =>
      visible.map((entry) => ({
        id: entry.id,
        label: entry.title,
        depth: 0,
        hasChildren: false,
        expanded: false,
        icon: <TypeVisualIcon visual={entry.visual} />,
        trailing: (
          <span className="flex shrink-0 items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
            {entry.pluginName ? <PluginMark name={entry.pluginName} /> : null}
            {SCENE_ASSET_KIND_LABELS[entry.kind]}
          </span>
        ),
      })),
    [visible],
  );

  const filterKinds = sceneAssetFilterKinds(overlay);
  const activeFilters = kinds.length + (showPluginContent ? 0 : 1) + (folder ? 1 : 0);
  const clearFilters = () => {
    setSearch("");
    setKinds([]);
    setFolder("");
    updatePreferences({ showPluginContent: true });
  };
  const chips: Array<{ id: string; label: string; clear: () => void }> = [
    ...kinds.map((kind) => ({
      id: `kind-${kind}`,
      label: filterKinds.find((entry) => entry.kind === kind)?.label ?? kind,
      clear: () => setKinds((current) => current.filter((entry) => entry !== kind)),
    })),
    ...(showPluginContent
      ? []
      : [{ id: "plugins", label: "Plugins Hidden", clear: () => updatePreferences({ showPluginContent: true }) }]),
    ...(folder ? [{ id: "folder", label: folder, clear: () => setFolder("") }] : []),
  ];
  const count = visible.length === allEntries.length
    ? `${allEntries.length} ${allEntries.length === 1 ? "Asset" : "Assets"}`
    : `${visible.length} of ${allEntries.length} Assets`;

  let body;
  if (!scene) {
    body = <p className="p-3 text-sm text-muted-foreground">Open A Scene</p>;
  } else if (allEntries.length === 0) {
    body = (
      <Empty className="py-10" data-testid="scene-assets-empty">
        <EmptyHeader>
          <EmptyTitle>No Assets Yet</EmptyTitle>
          <EmptyDescription>
            Import a Model or create a Class whose parent is Actor to list it here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (visible.length === 0) {
    body = (
      <Empty className="py-10" data-testid="scene-assets-no-matches">
        <EmptyHeader>
          <EmptyTitle>No Matches</EmptyTitle>
          <EmptyDescription>No assets match these filters.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
            Clear Filters
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else if (view === "list") {
    body = (
      <TreeView
        nodes={treeNodes}
        selectedIds={selectedIds}
        onSelect={select}
        onActivate={(id) => placeAtViewCenter([id])}
        onContextMenu={openEntryMenu}
        onExternalDrop={canPlace ? onDrop : undefined}
        onExternalDragMove={onDragMove}
        onExternalDragEnd={onDragEnd}
        rowHeight={touchSizing ? 44 : undefined}
        aria-label="Assets"
        data-testid="scene-assets-list"
      />
    );
  } else {
    body = (
        <CatalogCardGrid
          label="Assets"
          density="compact"
          role="listbox"
          aria-multiselectable
          data-testid="scene-assets-grid"
        >
          {visible.map((entry) => (
            <AssetCard
              key={entry.id}
              entry={entry}
              selected={selectedSet.has(entry.id)}
              imageUrl={entry.guid ? thumbnails[entry.guid] : undefined}
              onSelect={onCardSelect}
              onPointerDown={gestures.pointerDown}
              onContextMenu={openEntryMenu}
            />
          ))}
        </CatalogCardGrid>
    );
  }
  const cardsShown = Boolean(scene) && view === "cards" && visible.length > 0;

  return (
    <PanelFrame data-testid="scene-assets-panel">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 bg-panel-header px-1 py-1">
          <div className="flex items-center gap-1">
            <SearchInput
              className={touchSizing ? "h-11" : "h-7"}
              placeholder={overlay ? "Search 2D elements and assets" : "Search models and actors"}
              aria-label="Search assets"
              value={search}
              onChange={setSearch}
              data-testid="scene-assets-search"
            />
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant={activeFilters > 0 ? "secondary" : "ghost"}
                          size={actionSize}
                          aria-label={activeFilters > 0 ? `Filter (${activeFilters})` : "Filter"}
                          data-testid="scene-assets-filter"
                        />
                      }
                    />
                  }
                >
                  <ListFilterIcon />
                </TooltipTrigger>
                <TooltipContent>Filter</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-52" data-testid="scene-assets-filter-menu">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Asset Types</DropdownMenuLabel>
                  {filterKinds.map(({ kind, label }) => (
                    <DropdownMenuCheckboxItem
                      key={kind}
                      checked={kinds.includes(kind)}
                      data-testid={`scene-assets-filter-${kind}`}
                      onCheckedChange={(checked) =>
                        setKinds((current) =>
                          checked === true
                            ? [...current.filter((entry) => entry !== kind), kind]
                            : current.filter((entry) => entry !== kind),
                        )
                      }
                    >
                      {label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Plugins</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={showPluginContent}
                    data-testid="scene-assets-show-plugins"
                    onCheckedChange={(checked) => updatePreferences({ showPluginContent: checked === true })}
                  >
                    <PuzzleIcon className="size-4 text-muted-foreground" />
                    Show Plugin Content
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
                {folders.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Folder</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={folder} onValueChange={(value) => setFolder(value as string)}>
                        <DropdownMenuRadioItem value="">All Folders</DropdownMenuRadioItem>
                        {folders.map((entry) => (
                          <DropdownMenuRadioItem key={entry} value={entry} data-testid={`scene-assets-folder-${entry}`}>
                            <FolderIcon className="size-4 text-muted-foreground" />
                            {entry}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size={actionSize}
                          aria-label="Sort"
                          data-testid="scene-assets-sort"
                        />
                      }
                    />
                  }
                >
                  <ArrowUpDownIcon />
                </TooltipTrigger>
                <TooltipContent>Sort</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Sort By</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={sort}
                    onValueChange={(value) => updatePreferences({ sort: value as SceneAssetSort })}
                  >
                    {SORT_OPTIONS.map((option) => (
                      <DropdownMenuRadioItem key={option.id} value={option.id} data-testid={`scene-assets-sort-${option.id}`}>
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[view]}
              onValueChange={(value) => {
                const next = value[0] as AssetsPanelPreferences["view"] | undefined;
                if (next) updatePreferences({ view: next });
              }}
              aria-label="View"
            >
              <ToggleGroupItem value="cards" aria-label="Cards" title="Cards" data-testid="scene-assets-view-cards">
                <LayoutGridIcon />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List" title="List" data-testid="scene-assets-view-list">
                <ListIcon />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex min-h-5 flex-wrap items-center gap-1 px-1 text-[11px] text-muted-foreground">
            <span className="mr-auto tabular-nums" data-testid="scene-assets-count">{count}</span>
            {chips.map((chip) => (
              <Button
                key={chip.id}
                type="button"
                variant="outline"
                size="xs"
                className="h-5 rounded-full px-1.5 text-[10px]"
                aria-label={`Remove filter ${chip.label}`}
                onClick={chip.clear}
                data-testid={`scene-assets-chip-${chip.id}`}
              >
                {chip.label}
                <XIcon data-icon="inline-end" />
              </Button>
            ))}
          </div>
        </div>
        {/* One scroll container for every state, so the drag gestures keep their touch listener. */}
        <div
          ref={scrollRef}
          className={cardsShown ? "min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-2 touch-pan-y" : "min-h-0 flex-1"}
          onScroll={gestures.cancelPending}
          onClick={(event) => {
            if (cardsShown && event.target === event.currentTarget) setSelection(NO_SELECTION);
          }}
          data-testid="scene-assets-body"
        >
          {body}
        </div>
        {selectedIds.length > 0 ? (
          <div
            className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2 py-1"
            data-testid="scene-assets-selection"
          >
            <span className="mr-auto text-xs text-muted-foreground tabular-nums">
              {`${selectedIds.length} Selected`}
            </span>
            <Button
              type="button"
              variant="outline"
              size={touchSizing ? "touch" : "xs"}
              onClick={() => setSelection(NO_SELECTION)}
              data-testid="scene-assets-deselect"
            >
              Deselect
            </Button>
            <Button
              type="button"
              size={touchSizing ? "touch" : "xs"}
              disabled={!canPlace}
              onClick={() => placeAtViewCenter(selectedIds)}
              data-testid="scene-assets-place"
            >
              {selectedIds.length > 1 ? `Place (${selectedIds.length})` : "Place"}
            </Button>
          </div>
        ) : null}
      </div>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} contentTestId="scene-assets-menu" />
      <GraphDropHint hint={dropHint} testId="scene-assets-drop-hint" />
    </PanelFrame>
  );
}
