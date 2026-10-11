import { useMemo, useState } from "react";
import { FolderIcon } from "lucide-react";
import type { FolderNode } from "@babylonslate/assets";
import { SearchInput, TreeView } from "@babylonslate/editor-kit";
import { filterFolderTreeRows, flattenFolderTree } from "../lib/content-browser-helpers";

export interface FolderTreePickerProps {
  /** One tree per content root. */
  folderTrees: readonly FolderNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Rows that show muted and cannot be chosen. */
  isDisabled?: (path: string) => boolean;
  searchTestId?: string;
  treeTestId?: string;
}

/** Folder search and a collapsible folder tree over the registry's content roots. */
export function FolderTreePicker({
  folderTrees,
  selectedPath,
  onSelect,
  isDisabled,
  searchTestId,
  treeTestId,
}: FolderTreePickerProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const nodes = useMemo(() => {
    const searching = search.trim().length > 0;
    const rows = folderTrees.flatMap((tree) =>
      flattenFolderTree(tree, searching ? new Set() : collapsed),
    );
    return filterFolderTreeRows(rows, search).map((row) => ({
      id: row.id,
      label: row.label,
      depth: row.depth,
      hasChildren: row.hasChildren,
      expanded: searching ? true : row.expanded,
      muted: isDisabled?.(row.path) ?? false,
      icon: <FolderIcon />,
    }));
  }, [collapsed, folderTrees, isDisabled, search]);

  return (
    <>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search Folders"
        data-testid={searchTestId}
      />
      <div className="h-64 min-h-0 rounded-md border border-border">
        <TreeView
          nodes={nodes}
          selectedId={selectedPath}
          onSelect={(id) => {
            if (!isDisabled?.(id)) onSelect(id);
          }}
          onToggleExpanded={(id) =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          emptyLabel="No folders"
          data-testid={treeTestId}
        />
      </div>
    </>
  );
}
