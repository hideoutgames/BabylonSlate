import { useCallback, useMemo, useState } from "react";
import { FolderIcon } from "lucide-react";
import type { FolderNode } from "@babylonslate/assets";
import { normalizeAlwaysPackageFolders } from "@babylonslate/core";
import { NamedListEditor } from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { useRegistryState } from "../context/document-context";
import { FolderPickerDialog } from "./folder-picker-dialog";

function folderPaths(node: FolderNode): string[] {
  return [node.path, ...node.children.flatMap(folderPaths)];
}

export interface AlwaysPackageFoldersFieldProps {
  folders: readonly string[];
  onChange: (folders: string[]) => void;
}

/** Project Settings list of the folders whose assets always ship, with a folder picker to add one. */
export function AlwaysPackageFoldersField({ folders, onChange }: AlwaysPackageFoldersFieldProps) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const [picking, setPicking] = useState(false);
  const folderTrees = useMemo(
    () => (assetRegistry ? assetRegistry.listRoots().map((root) => assetRegistry.folderTree(root.id)) : []),
    // The registry mutates in place; its epoch says when to read it again.
    [assetRegistry, registryEpoch],
  );
  const existing = useMemo(() => new Set(folderTrees.flatMap(folderPaths)), [folderTrees]);
  const listed = useMemo(() => new Set(folders), [folders]);
  const isListed = useCallback((path: string) => listed.has(path), [listed]);
  return (
    <>
      <NamedListEditor
        values={folders}
        onChange={onChange}
        itemLabel="Folder"
        addLabel="Add Folder"
        onAdd={() => setPicking(true)}
        data-testid="settings-always-package-folders"
        renderItem={({ value, index }) => (
          <div
            className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-2 text-sm"
            data-testid={`settings-always-package-folders-${index}`}
          >
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={value}>{value}</span>
            {existing.has(value) ? null : (
              <Badge variant="destructive" data-testid={`settings-always-package-folders-${index}-missing`}>
                Missing Folder
              </Badge>
            )}
          </div>
        )}
      />
      {picking ? (
        <FolderPickerDialog
          open
          onOpenChange={setPicking}
          title="Add Always Package Folder"
          confirmLabel="Add Folder"
          folderTrees={folderTrees}
          isDisabled={isListed}
          onConfirm={(path) => {
            onChange(normalizeAlwaysPackageFolders([...folders, path]));
            setPicking(false);
          }}
          data-testid="settings-always-package-folders-picker"
        />
      ) : null}
    </>
  );
}
