import { useMemo } from "react";
import { FolderIcon, FolderPlusIcon, type LucideIcon } from "lucide-react";
import { stripAssetFileSuffix, type IndexedAsset } from "@haptic/assets";
import {
  ShortcutKeys,
  TreeView,
  TypeVisualIcon,
  ariaKeyShortcuts,
  type TreeViewProps,
  type TypeVisual,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import type { useKeybindings } from "../context/keybind-context";
import { isFolderTreeRoot, type ContentBrowserTreeRow } from "../lib/content-browser-helpers";
import { contentBrowserFolderOps, type ContentBrowserRoot } from "../lib/plugin-ui";

interface ContentBrowserFolderNavigationProps {
  touchSizing: boolean;
  keybinds: ReturnType<typeof useKeybindings>;
  busy: boolean;
  selectedRootWritable: boolean;
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
 * New Folder and the folder tree, for the desktop sidebar or the phone
 * Folders sheet. A fragment, so it adds no element to either.
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

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size={touchSizing ? "touch" : "sm"}
              className="w-full justify-start"
              data-testid="content-browser-new-folder"
              aria-keyshortcuts={ariaKeyShortcuts(keybinds.get("edit.newFolder")?.[0] ?? "")}
              disabled={busy || !selectedRootWritable}
              onClick={onNewFolder}
            >
              <FolderPlusIcon data-icon="inline-start" />
              New Folder
            </Button>
          }
        />
        <TooltipContent>
          New Folder <ShortcutKeys chord={keybinds.get("edit.newFolder")?.[0]} decorative />
        </TooltipContent>
      </Tooltip>
      <div className="min-h-0 flex-1">
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
    </>
  );
}
