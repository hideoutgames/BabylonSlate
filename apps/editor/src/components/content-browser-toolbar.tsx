import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { FolderIcon, PlusIcon, UploadIcon } from "lucide-react";
import { pickerImportAccept } from "@haptic/assets";
import { SearchInput, ShortcutKeys, ariaKeyShortcuts } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@haptic/ui/components/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import type { useKeybindings } from "../context/keybind-context";
import type { ContentBrowserSortMode, ContentBrowserTreeRow } from "../lib/content-browser-helpers";
import { ContentBrowserFilterSortMenus } from "./content-browser-filter-sort-menus";
import { ContentBrowserNewAssetMenu } from "./content-browser-new-asset-dialog";
import { ContentBrowserSelectionActions } from "./content-browser-selection-actions";

interface ContentBrowserToolbarProps {
  phone: boolean;
  touchSizing: boolean;
  phoneIconSize: ComponentProps<typeof ContentBrowserFilterSortMenus>["phoneIconSize"];
  hidden: boolean;
  foldersOpen: boolean;
  setFoldersOpen: (open: boolean) => void;
  browserRows: ContentBrowserTreeRow[];
  selectedFolderPath: string;
  /** New Folder and the folder tree, shown in the phone Folders sheet. */
  folderNavigation: ReactNode;
  busy: boolean;
  selectedRootWritable: boolean;
  keybinds: ReturnType<typeof useKeybindings>;
  onImport: () => Promise<void>;
  newAssetMenu: Omit<ComponentProps<typeof ContentBrowserNewAssetMenu>, "children">;
  search: string;
  setSearch: (search: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  typeChips: string[];
  typeFilters: string[];
  setTypeFilters: Dispatch<SetStateAction<string[]>>;
  sortMode: ContentBrowserSortMode;
  setSortMode: (mode: ContentBrowserSortMode) => void;
  selectionCount: number;
  /** Set when the selection is one openable asset or folder. */
  onOpenSelection?: () => void;
  onDeselectAll: () => void;
  onRequestDelete: () => void;
  importInputRef: RefObject<HTMLInputElement | null>;
  onImportFiles: (files: FileList | null) => Promise<void>;
}

/**
 * The toolbar row: the phone Folders sheet, Import, New Asset, search, Filter
 * and Sort, the desktop selection actions and the hidden import file input.
 */
export function ContentBrowserToolbar({
  phone,
  touchSizing,
  phoneIconSize,
  hidden,
  foldersOpen,
  setFoldersOpen,
  browserRows,
  selectedFolderPath,
  folderNavigation,
  busy,
  selectedRootWritable,
  keybinds,
  onImport,
  newAssetMenu,
  search,
  setSearch,
  searchRef,
  typeChips,
  typeFilters,
  setTypeFilters,
  sortMode,
  setSortMode,
  selectionCount,
  onOpenSelection,
  onDeselectAll,
  onRequestDelete,
  importInputRef,
  onImportFiles,
}: ContentBrowserToolbarProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel-header px-2 py-1.5",
        phone && "px-2",
      )}
    >
      {phone ? (
        <Sheet open={foldersOpen && !hidden} onOpenChange={setFoldersOpen}>
          <SheetTrigger
            render={
              <Button
                variant="outline"
                size={touchSizing ? "touch" : "sm"}
                className="min-w-0 flex-1 justify-start"
                aria-label="Browse Folders"
                data-testid="content-browser-browse-folders"
              />
            }
          >
            <FolderIcon data-icon="inline-start" />
            <span className="truncate">
              {browserRows.find((row) => row.id === selectedFolderPath)?.label ??
                selectedFolderPath.split("/").at(-1) ??
                "Content"}
            </span>
          </SheetTrigger>
          <SheetContent
            side="left"
            bodyClassName="gap-0"
            data-testid="content-browser-folders-sheet"
          >
            <SheetHeader>
              <SheetTitle>Folders</SheetTitle>
              <SheetDescription>Choose a folder to browse.</SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
              {folderNavigation}
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size={phone ? phoneIconSize : "sm"}
              aria-label="Import"
              data-testid="content-browser-import"
              aria-keyshortcuts={ariaKeyShortcuts(keybinds.get("browser.import")?.[0] ?? "")}
              disabled={busy || !selectedRootWritable}
              onClick={() => void onImport()}
            >
              <UploadIcon data-icon="inline-start" />
              {!phone ? "Import" : null}
            </Button>
          }
        />
        <TooltipContent>
          Import <ShortcutKeys chord={keybinds.get("browser.import")?.[0]} decorative />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <ContentBrowserNewAssetMenu {...newAssetMenu}>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size={touchSizing ? "touch" : "sm"}
                data-testid="content-browser-new-asset"
                aria-keyshortcuts={ariaKeyShortcuts(keybinds.get("browser.newAsset")?.[0] ?? "")}
                disabled={busy || !selectedRootWritable}
              >
                <PlusIcon data-icon="inline-start" />
                New Asset
              </Button>
            }
          />
        </ContentBrowserNewAssetMenu>
        <TooltipContent>
          New Asset <ShortcutKeys chord={keybinds.get("browser.newAsset")?.[0]} decorative />
        </TooltipContent>
      </Tooltip>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          phone && "basis-full",
        )}
      >
        <SearchInput
          ref={searchRef}
          value={search}
          onChange={setSearch}
          placeholder="Search assets…"
          aria-label="Search Assets"
          aria-keyshortcuts={ariaKeyShortcuts(keybinds.get("edit.find")?.[0] ?? "")}
          className={cn(
            "min-h-[var(--chrome-row,28px)]",
            phone ? "min-w-0" : "min-w-40",
            touchSizing && "h-11",
          )}
          data-testid="content-browser-search"
        />
        <ContentBrowserFilterSortMenus
          phone={phone}
          phoneIconSize={phoneIconSize}
          typeChips={typeChips}
          typeFilters={typeFilters}
          setTypeFilters={setTypeFilters}
          sortMode={sortMode}
          setSortMode={setSortMode}
        />
      </div>
      {!phone ? (
        <ContentBrowserSelectionActions
          selectionCount={selectionCount}
          busy={busy}
          onOpen={onOpenSelection}
          onDeselectAll={onDeselectAll}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      <input
        ref={importInputRef}
        type="file"
        multiple
        disabled={busy}
        className="hidden"
        data-testid="content-browser-import-input"
        accept={pickerImportAccept()}
        onChange={(event) => {
          void onImportFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
