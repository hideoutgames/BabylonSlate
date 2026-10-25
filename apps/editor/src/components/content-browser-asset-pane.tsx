import { PlusIcon, UploadIcon } from "lucide-react";
import { FolderBreadcrumbs } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent } from "@haptic/ui/components/empty";
import { isContentBrowserEmptyGridDoubleClickTarget } from "../lib/content-browser-helpers";
import { PROJECT_CONTENT_ROOT_ID, type ContentBrowserRoot } from "../lib/plugin-ui";
import type { useContentBrowserGridWindow } from "../lib/use-content-browser-grid-window";
import type { useContentBrowserPaintSelect } from "../lib/use-content-browser-paint-select";
import type { useLongPressMenu } from "../lib/use-long-press-menu";
import {
  ContentBrowserGridTiles,
  type ContentBrowserGridActions,
  type ContentBrowserGridTilesProps,
} from "./content-browser-grid-tiles";

type GridWindow = ReturnType<typeof useContentBrowserGridWindow>;

interface ContentBrowserAssetPaneProps {
  /** The open folder's content root, where the breadcrumbs start. */
  folderRoot: ContentBrowserRoot;
  selectedFolderPath: string;
  touchSizing: boolean;
  onNavigate: (path: string) => void;
  scrollerRef: GridWindow["scrollerRef"];
  /** The typed search is ahead of the one the grid shows. */
  searchPending: boolean;
  paintBind: ReturnType<typeof useContentBrowserPaintSelect>["gridBind"];
  emptyGridBind: ReturnType<typeof useLongPressMenu>;
  consumeSelectClick: () => boolean;
  onClearSelection: () => void;
  canOpenSelection: boolean;
  onOpenSelection: () => void;
  onOpenNewAssetMenu: (anchor: { x: number; y: number }) => void;
  onImport: () => Promise<void>;
  gridItems: ContentBrowserGridTilesProps["items"];
  gridSearch: string;
  typeFilters: string[];
  onClearFilters: () => void;
  selectedRootWritable: boolean;
  busy: boolean;
  slice: GridWindow["slice"];
  spacerHeight: number;
  selectedGuids: ContentBrowserGridTilesProps["selectedGuids"];
  selectedFolderPaths: ContentBrowserGridTilesProps["selectedFolderPaths"];
  thumbnailUrls: ContentBrowserGridTilesProps["thumbnailUrls"];
  compileErrorGuids: ContentBrowserGridTilesProps["compileErrors"];
  encodingTextures: ContentBrowserGridTilesProps["encodingTextures"];
  typeVisualFor: ContentBrowserGridTilesProps["typeVisualFor"];
  pluginRootIcons: ContentBrowserGridTilesProps["folderIcons"];
  sourceControlEnabled: boolean;
  tileLocks: ContentBrowserGridTilesProps["locks"];
  gridActions: ContentBrowserGridActions;
}

/**
 * The asset pane: folder breadcrumbs over the windowed tile grid or its
 * empty state. A fragment, so the resizable pane stays the parent.
 */
export function ContentBrowserAssetPane({
  folderRoot,
  selectedFolderPath,
  touchSizing,
  onNavigate,
  scrollerRef,
  searchPending,
  paintBind,
  emptyGridBind,
  consumeSelectClick,
  onClearSelection,
  canOpenSelection,
  onOpenSelection,
  onOpenNewAssetMenu,
  onImport,
  gridItems,
  gridSearch,
  typeFilters,
  onClearFilters,
  selectedRootWritable,
  busy,
  slice,
  spacerHeight,
  selectedGuids,
  selectedFolderPaths,
  thumbnailUrls,
  compileErrorGuids,
  encodingTextures,
  typeVisualFor,
  pluginRootIcons,
  sourceControlEnabled,
  tileLocks,
  gridActions,
}: ContentBrowserAssetPaneProps) {
  return (
    <>
      <div className="shrink-0 border-b border-border/60 bg-sidebar px-1 py-0.5">
        <FolderBreadcrumbs
          root={{ path: folderRoot.pathPrefix, label: folderRoot.id === PROJECT_CONTENT_ROOT_ID ? "Content" : folderRoot.label }}
          path={selectedFolderPath}
          touch={touchSizing}
          onNavigate={onNavigate}
        />
      </div>
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
        data-testid="content-browser-asset-grid"
        aria-busy={searchPending || undefined}
        style={paintBind.style}
        tabIndex={0}
        onClick={() => {
          if (consumeSelectClick()) return;
          onClearSelection();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.defaultPrevented) return;
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            (target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.isContentEditable)
          ) {
            return;
          }
          // The toolbar Open action: open one asset or enter one folder.
          if (!canOpenSelection) return;
          event.preventDefault();
          onOpenSelection();
        }}
        onDoubleClick={(event) => {
          if (!isContentBrowserEmptyGridDoubleClickTarget(event.target)) {
            return;
          }
          onOpenNewAssetMenu({ x: event.clientX, y: event.clientY });
        }}
        onContextMenu={emptyGridBind.onContextMenu}
        onPointerDown={emptyGridBind.onPointerDown}
        onPointerMove={emptyGridBind.onPointerMove}
        onPointerUp={emptyGridBind.onPointerUp}
        onPointerCancel={emptyGridBind.onPointerCancel}
        onPointerDownCapture={paintBind.onPointerDownCapture}
        onPointerMoveCapture={paintBind.onPointerMoveCapture}
        onPointerUpCapture={paintBind.onPointerUpCapture}
        onPointerCancelCapture={paintBind.onPointerCancelCapture}
      >
        {gridItems.length === 0 ? (
          <Empty data-testid="content-browser-empty-copy" className="border-0 py-10">
            <EmptyHeader>
              <EmptyTitle>{gridSearch.trim() || typeFilters.length ? "No Matching Assets" : "This Folder Is Empty"}</EmptyTitle>
              <EmptyDescription>{gridSearch.trim() || typeFilters.length ? "Try another search or clear the filters." : "Add an asset or import files to get started."}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {gridSearch.trim() || typeFilters.length ? (
                <Button variant="outline" size={touchSizing ? "touch" : "sm"} onClick={onClearFilters}>Clear Filters</Button>
              ) : selectedRootWritable ? (
                <div className="flex items-center gap-2">
                  <Button size={touchSizing ? "touch" : "sm"} disabled={busy} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onOpenNewAssetMenu({ x: rect.left, y: rect.bottom + 4 }); }}><PlusIcon data-icon="inline-start" />New Asset</Button>
                  <Button variant="outline" size={touchSizing ? "touch" : "sm"} disabled={busy} onClick={() => void onImport()}><UploadIcon data-icon="inline-start" />Import</Button>
                </div>
              ) : null}
            </EmptyContent>
          </Empty>
        ) : (
          <ContentBrowserGridTiles
            items={gridItems}
            firstIndex={slice.firstIndex}
            lastIndex={slice.lastIndex}
            columnCount={slice.columnCount}
            height={spacerHeight}
            selectedGuids={selectedGuids}
            selectedFolderPaths={selectedFolderPaths}
            thumbnailUrls={thumbnailUrls}
            compileErrors={compileErrorGuids}
            encodingTextures={encodingTextures}
            typeVisualFor={typeVisualFor}
            folderIcons={pluginRootIcons}
            sourceControlEnabled={sourceControlEnabled}
            locks={tileLocks}
            actions={gridActions}
          />
        )}
      </div>
    </>
  );
}
