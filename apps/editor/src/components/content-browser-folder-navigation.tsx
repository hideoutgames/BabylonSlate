import { useMemo } from "react";
import { FolderIcon, FolderPlusIcon, type LucideIcon } from "lucide-react";
import { stripAssetFileSuffix, type IndexedAsset } from "@haptic/assets";
import {
  ContextMenuOverlay,
  TreeView,
  TypeVisualIcon,
  useContextMenu,
  useContextMenuGesture,
  type TreeViewProps,
  type TypeVisual,
} from "@haptic/editor-kit";
import type { useKeybindings } from "../context/keybind-context";
import { isFolderTreeRoot, type ContentBrowserTreeRow } from "../lib/content-browser-helpers";
import { contentBrowserFolderOps, type ContentBrowserRoot } from "../lib/plugin-ui";

/** True for a press on empty tree space: below the rows or beside them, not on a row. */
function isEmptyTreeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('[role="treeitem"]');
}

interface ContentBrowserFolderNavigationProps {
  touchSizing: boolean;
  keybinds: ReturnType<typeof useKeybindings>;
  busy: boolean;
  selectedRootWritable: boolean;
  /** Creates a folder in the open folder and renames it inline in the tree. */
  onNewFolder: () => void;
  browserRows: ContentBrowserTreeRow[];
  assetsByGuid: ReadonlyMap<string, IndexedAsset>;
  browserRoots: ContentBrowserRoot[];
  rootPrefixes: string[];
  /** Plugin content root icons, keyed by root path. */
  pluginRootIcons: ReadonlyMap<string, LucideIcon | undefined>;
  typeVisualFor: (asset: IndexedAsset) => TypeVisual;
  treeSelectedId: string;
  treeSelectedIds: string[];
  onSelect: NonNullable<TreeViewProps["onSelect"]>;
  onToggleExpanded: (id: string) => void;
  onReparent: NonNullable<TreeViewProps["onReparent"]>;
  renamingId: string | null;
  onRenameRequest: (id: string) => void;
  onRenameDone: (id: string, name: string | null) => void;
}

/**
 * The folder tree, for the desktop sidebar or the phone Folders sheet, with a
 * New Folder menu on its empty space (right-click or long press).
 */
export function ContentBrowserFolderNavigation({
  touchSizing,
  keybinds,
  busy,
  selectedRootWritable,
  onNewFolder,
  browserRows,
  assetsByGuid,
  browserRoots,
  rootPrefixes,
  pluginRootIcons,
  typeVisualFor,
  treeSelectedId,
  treeSelectedIds,
  onSelect,
  onToggleExpanded,
  onReparent,
  renamingId,
  onRenameRequest,
  onRenameDone,
}: ContentBrowserFolderNavigationProps) {
  const treeNodes = useMemo(
    () =>
      browserRows.map((row) => {
        const FolderGlyph = pluginRootIcons.get(row.id) ?? FolderIcon;
        const asset = row.guid ? assetsByGuid.get(row.guid) : undefined;
        const renamable =
          !isFolderTreeRoot(row.path, rootPrefixes) &&
          !contentBrowserFolderOps(row.path, browserRoots).readOnly;
        return {
          id: row.id,
          label: row.label,
          renamable,
          ...(asset ? { renameValue: stripAssetFileSuffix(asset.path.split("/").at(-1) ?? asset.header.name) } : {}),
          depth: row.depth,
          hasChildren: row.hasChildren,
          expanded: row.expanded,
          icon:
            row.kind === "folder" ? (
              <FolderGlyph />
            ) : asset ? (
              <TypeVisualIcon visual={typeVisualFor(asset)} />
            ) : undefined,
        };
      }),
    [assetsByGuid, browserRoots, browserRows, pluginRootIcons, rootPrefixes, typeVisualFor],
  );

  const emptyMenuItems = useMemo(
    () => [
      {
        id: "new-folder",
        label: "New Folder",
        shortcut: keybinds.get("edit.newFolder")?.[0],
        icon: <FolderPlusIcon />,
        // Like the grid menu: a read-only root offers no action that would do nothing.
        disabled: busy || !selectedRootWritable,
        onSelect: onNewFolder,
      },
    ],
    [busy, keybinds, onNewFolder, selectedRootWritable],
  );
  const { menu, closeMenu, openMenuAt } = useContextMenu({ items: emptyMenuItems });
  const emptyBind = useContextMenuGesture({ exclusive: true, onMenu: (clientX, clientY) => openMenuAt(clientX, clientY) });

  return (
    <>
      <div
        className="min-h-0 flex-1"
        data-testid="content-browser-tree-area"
        onContextMenu={(event) => {
          if (isEmptyTreeTarget(event.target)) emptyBind.onContextMenu(event);
        }}
        onPointerDown={(event) => {
          if (isEmptyTreeTarget(event.target)) emptyBind.onPointerDown(event);
        }}
        onPointerMove={emptyBind.onPointerMove}
        onPointerUp={emptyBind.onPointerUp}
        onPointerCancel={emptyBind.onPointerCancel}
      >
        <TreeView
          nodes={treeNodes}
          selectedId={treeSelectedId}
          selectedIds={treeSelectedIds}
          rowHeight={touchSizing ? 44 : undefined}
          onSelect={onSelect}
          onToggleExpanded={onToggleExpanded}
          onReparent={onReparent}
          renamingId={renamingId}
          onRenameRequest={onRenameRequest}
          onRenameDone={onRenameDone}
          emptyLabel="No Folders"
          data-testid="content-browser-folder-tree"
        />
      </div>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
    </>
  );
}
