import { memo, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import type { IndexedAsset } from "@babylonslate/assets";
import type { TypeVisual } from "@babylonslate/editor-kit";
import { contentBrowserTileStyle } from "../lib/content-browser-grid";
import { ContentBrowserAssetTile } from "./content-browser-asset-tile";
import { ContentBrowserFolderTile } from "./content-browser-folder-tile";

export type ContentBrowserGridItem =
  | { kind: "folder"; path: string; name: string }
  | { kind: "asset"; asset: IndexedAsset };

export type ContentBrowserTileHit =
  | { kind: "asset"; guid: string }
  | { kind: "folder"; path: string };

type TileSelectEvent = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/**
 * Reference-stable tile handlers. Cells call them with their own identity, so
 * a memoized cell does not re-render when the workspace rebuilds its callbacks.
 */
export type ContentBrowserGridActions = {
  select: (hit: ContentBrowserTileHit, event: TileSelectEvent) => void;
  openFolder: (path: string) => void;
  openAsset: (asset: IndexedAsset) => void;
  openFolderMenu: (path: string, clientX: number, clientY: number) => void;
  openAssetMenu: (guid: string, clientX: number, clientY: number) => void;
  consumeSelectClick: () => boolean;
};

export type ContentBrowserTileLock = {
  state: "mine" | "theirs";
  ownerName?: string;
};

export type ContentBrowserGridTilesProps = {
  items: readonly ContentBrowserGridItem[];
  firstIndex: number;
  lastIndex: number;
  columnCount: number;
  height: number;
  selectedGuids: ReadonlySet<string>;
  selectedFolderPaths: ReadonlySet<string>;
  thumbnailUrls: Readonly<Record<string, string>>;
  /** Asset guids and paths with compile errors. */
  compileErrors: ReadonlySet<string>;
  typeVisualFor: (asset: IndexedAsset) => TypeVisual;
  folderIcons: ReadonlyMap<string, LucideIcon | undefined>;
  sourceControlEnabled: boolean;
  /** Locks of mounted assets, keyed by asset path. */
  locks: Readonly<Record<string, ContentBrowserTileLock>>;
  actions: ContentBrowserGridActions;
};

/**
 * Mounted Content Browser tiles inside the windowed spacer. Memoized so a
 * workspace render that leaves the grid inputs unchanged (typing ahead of the
 * deferred search, dialogs, menus) skips every tile.
 */
export const ContentBrowserGridTiles = memo(function ContentBrowserGridTiles({
  items,
  firstIndex,
  lastIndex,
  columnCount,
  height,
  selectedGuids,
  selectedFolderPaths,
  thumbnailUrls,
  compileErrors,
  typeVisualFor,
  folderIcons,
  sourceControlEnabled,
  locks,
  actions,
}: ContentBrowserGridTilesProps) {
  const cells = [];
  const end = Math.min(lastIndex, items.length);
  for (let index = firstIndex; index < end; index++) {
    const item = items[index]!;
    if (item.kind === "folder") {
      cells.push(
        <FolderGridCell
          key={item.path}
          index={index}
          columnCount={columnCount}
          path={item.path}
          name={item.name}
          icon={folderIcons.get(item.path)}
          selected={selectedFolderPaths.has(item.path)}
          actions={actions}
        />,
      );
      continue;
    }
    const { asset } = item;
    const guid = asset.header.guid;
    const lock = locks[asset.path];
    cells.push(
      <AssetGridCell
        key={guid}
        index={index}
        columnCount={columnCount}
        asset={asset}
        selected={selectedGuids.has(guid)}
        thumbnailUrl={thumbnailUrls[guid] ?? null}
        typeVisual={typeVisualFor(asset)}
        hasCompileError={compileErrors.has(guid) || compileErrors.has(asset.path)}
        sourceControlEnabled={sourceControlEnabled}
        lockState={lock?.state ?? null}
        lockOwnerName={lock?.ownerName}
        actions={actions}
      />,
    );
  }
  return (
    <div className="relative" style={{ height }}>
      {cells}
    </div>
  );
});

const FolderGridCell = memo(function FolderGridCell({
  index,
  columnCount,
  path,
  name,
  icon,
  selected,
  actions,
}: {
  index: number;
  columnCount: number;
  path: string;
  name: string;
  icon: LucideIcon | undefined;
  selected: boolean;
  actions: ContentBrowserGridActions;
}) {
  const onSelect = useCallback(
    (event: TileSelectEvent) => actions.select({ kind: "folder", path }, event),
    [actions, path],
  );
  const onOpen = useCallback(() => actions.openFolder(path), [actions, path]);
  const onLongPressMenu = useCallback(
    (clientX: number, clientY: number) =>
      actions.openFolderMenu(path, clientX, clientY),
    [actions, path],
  );
  return (
    <div style={contentBrowserTileStyle(index, columnCount)}>
      <ContentBrowserFolderTile
        path={path}
        name={name}
        icon={icon}
        selected={selected}
        consumeSelectClick={actions.consumeSelectClick}
        onSelect={onSelect}
        onOpen={onOpen}
        onLongPressMenu={onLongPressMenu}
      />
    </div>
  );
});

const AssetGridCell = memo(function AssetGridCell({
  index,
  columnCount,
  asset,
  selected,
  thumbnailUrl,
  typeVisual,
  hasCompileError,
  sourceControlEnabled,
  lockState,
  lockOwnerName,
  actions,
}: {
  index: number;
  columnCount: number;
  asset: IndexedAsset;
  selected: boolean;
  thumbnailUrl: string | null;
  typeVisual: TypeVisual;
  hasCompileError: boolean;
  sourceControlEnabled: boolean;
  lockState: "mine" | "theirs" | null;
  lockOwnerName: string | undefined;
  actions: ContentBrowserGridActions;
}) {
  const guid = asset.header.guid;
  const onSelect = useCallback(
    (event: TileSelectEvent) => actions.select({ kind: "asset", guid }, event),
    [actions, guid],
  );
  const onOpen = useCallback(() => actions.openAsset(asset), [actions, asset]);
  const onLongPressMenu = useCallback(
    (clientX: number, clientY: number) =>
      actions.openAssetMenu(guid, clientX, clientY),
    [actions, guid],
  );
  return (
    <div style={contentBrowserTileStyle(index, columnCount)}>
      <ContentBrowserAssetTile
        asset={asset}
        selected={selected}
        thumbnailUrl={thumbnailUrl}
        typeVisual={typeVisual}
        hasCompileError={hasCompileError}
        onSelect={onSelect}
        consumeSelectClick={actions.consumeSelectClick}
        onOpen={onOpen}
        sourceControlEnabled={sourceControlEnabled}
        lockState={lockState}
        lockOwnerName={lockOwnerName}
        onLongPressMenu={onLongPressMenu}
      />
    </div>
  );
});
