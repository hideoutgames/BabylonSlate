import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import type { WaterStyle, WaterStylizedLook } from "@babylonslate/core";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import type { FolderNode } from "@babylonslate/assets";
import {
  SearchDropdown,
  SearchInput,
  AssetPicker,
  AssetPickerControl,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  walkAncestry,
  type SearchDialogItem,
} from "@babylonslate/editor-kit";
import { contentEntryNameError } from "@babylonslate/assets";
import { MAX_CLASS_INHERITANCE_DEPTH } from "@babylonslate/object-model";
import { Button } from "@babylonslate/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  CREATABLE_ASSET_TYPE_GROUPS,
  buildParentClassTreeRows,
  classParentLookup,
  creatableAssetTypeDescription,
  creatableAssetTypeLabel,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { hasTouchInput } from "../lib/touch-input";
import { usePhoneLayout, usePhoneTouchSizing } from "../shell/use-platform-layout";

export type NewAssetClassAssetRef = {
  path?: string;
  header: { type: string; name: string; parentClass?: string | null };
};

export interface ContentBrowserNewAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chosen beforehand in the New Asset type menu. */
  type: CreatableAssetType;
  name: string;
  onNameChange: (name: string) => void;
  parentClass: string;
  onParentClassChange: (parentClass: string) => void;
  waterStyle?: WaterStyle;
  onWaterStyleChange?: (style: WaterStyle) => void;
  /** Stylized Water's look, shown while Stylized is chosen. */
  waterStylizedLook?: WaterStylizedLook;
  onWaterStylizedLookChange?: (look: WaterStylizedLook) => void;
  definitionGuid?: string | null;
  onDefinitionGuidChange?: (guid: string | null) => void;
  definitionAssets?: readonly { guid: string; name: string; type: string }[];
  /** Project + enabled-plugin Class assets for the Parent Class tree. */
  classAssets?: readonly NewAssetClassAssetRef[];
  /** Why the name is taken: by a file in the folder, or by another Class's id. */
  takenNameError?: string | null;
  /** Content Browser folder the asset is written to (`assets/Characters`). */
  destinationFolder?: string;
  /** Picks another folder from the Location button; without it Location is read-only. */
  onDestinationFolderChange?: (folder: string) => void;
  /** One tree per content root, for the Location picker. */
  folderTrees?: readonly FolderNode[];
  /** Folders the Location picker shows muted (read-only roots). */
  isFolderDisabled?: (path: string) => boolean;
  busy?: boolean;
  error?: string | null;
  onCreate: () => void;
}

/** Where the asset is written; a button that opens the folder picker when the caller allows a change. */
function NewAssetLocation({
  folder,
  busy,
  onChange,
  folderTrees,
  isFolderDisabled,
}: {
  folder: string;
  busy: boolean;
  onChange?: (folder: string) => void;
  folderTrees: readonly FolderNode[];
  isFolderDisabled?: (path: string) => boolean;
}) {
  const [picking, setPicking] = useState(false);
  const path = (
    <>
      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left" title={folder} data-testid="new-asset-location-path">{folder}</span>
    </>
  );
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={onChange ? "new-asset-location" : undefined}>Location</FieldLabel>
        {onChange ? (
          <Button
            id="new-asset-location"
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-start gap-1.5 font-normal"
            aria-label={`Location: ${folder}. Choose Location`}
            disabled={busy}
            onClick={() => setPicking(true)}
            data-testid="new-asset-location"
          >
            {path}
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        ) : (
          <div className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-1.5 text-sm" data-testid="new-asset-location">
            {path}
          </div>
        )}
      </Field>
      {picking && onChange ? (
        <FolderPickerDialog
          open
          onOpenChange={setPicking}
          title="Choose Location"
          confirmLabel="Choose"
          folderTrees={folderTrees}
          initialPath={folder}
          isDisabled={isFolderDisabled}
          onConfirm={(next) => {
            onChange(next);
            setPicking(false);
          }}
          data-testid="new-asset-location-picker"
        />
      ) : null}
    </FieldGroup>
  );
}

const NEW_ASSET_TYPE_ITEMS: SearchDialogItem[] = CREATABLE_ASSET_TYPE_GROUPS.flatMap((group) =>
  group.types.map((type) => ({
    id: type,
    label: creatableAssetTypeLabel(type),
    group: group.label,
    keywords: type,
    leading: <TypeVisualIcon visual={resolveTypeVisual({ assetType: type })} />,
  })),
);

/** Compact searchable menu of creatable types, grouped by category; a pick opens the New Asset dialog. */
export function ContentBrowserNewAssetMenu({
  open,
  onOpenChange,
  anchor,
  onSelect,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Viewport point for a menu opened from empty grid space; `null` opens under the trigger. */
  anchor: { x: number; y: number } | null;
  onSelect: (type: CreatableAssetType) => void;
  children: ReactElement;
}) {
  return (
    <SearchDropdown
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      title="New Asset"
      placeholder="Search Asset Types"
      emptyLabel="No asset types match the search."
      items={NEW_ASSET_TYPE_ITEMS}
      onSelect={(id) => onSelect(id as CreatableAssetType)}
      data-testid="new-asset-type-menu"
    >
      {children}
    </SearchDropdown>
  );
}

export function ContentBrowserNewAssetDialog({
  open,
  onOpenChange,
  type,
  name,
  onNameChange,
  parentClass,
  onParentClassChange,
  waterStyle = "realistic",
  onWaterStyleChange,
  waterStylizedLook = "painted",
  onWaterStylizedLookChange,
  definitionGuid = null,
  onDefinitionGuidChange,
  definitionAssets = [],
  classAssets = [],
  takenNameError = null,
  destinationFolder,
  onDestinationFolderChange,
  folderTrees = [],
  isFolderDisabled,
  busy = false,
  error = null,
  onCreate,
}: ContentBrowserNewAssetDialogProps) {
  const phone = usePhoneLayout();
  const touchSizing = usePhoneTouchSizing();
  const [parentSearch, setParentSearch] = useState("");
  const [definitionPickerOpen, setDefinitionPickerOpen] = useState(false);
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  const detailsRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const selectedVisual = resolveTypeVisual({ assetType: type });
  const isData = type === "DataTree";
  // The same rule as Rename, so a created name can always be renamed back.
  const nameError = name.trim() ? contentEntryNameError(name) : null;
  const nameInvalid = Boolean(takenNameError) || Boolean(nameError);

  useEffect(() => {
    if (open) setParentSearch("");
  }, [open]);

  const canCreate = !busy && !nameInvalid && Boolean(name.trim());

  const parentOf = useMemo(() => classParentLookup(classAssets), [classAssets]);
  const parentRows = useMemo(
    () =>
      buildParentClassTreeRows(classAssets, {
        search: parentSearch,
        maxDepth: MAX_CLASS_INHERITANCE_DEPTH,
      }),
    [classAssets, parentSearch],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="content-browser-new-asset-dialog"
        // Desktop starts in Name; touch skips the text field so the keyboard
        // does not cover the dialog.
        initialFocus={() => (phone || hasTouchInput() ? detailsRef.current : nameRef.current)}
        className={cn(
          "max-w-none sm:max-w-none",
          phone
            ? "editor-dialog-large"
            : "h-[80dvh] w-[max(50vw,min(36rem,calc(100vw-2rem)))]",
        )}
        bodyClassName="flex flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="min-h-14 shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>New Asset</DialogTitle>
        </DialogHeader>
        <aside
          ref={detailsRef}
          tabIndex={-1}
          data-testid="new-asset-details"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-y-contain outline-none"
        >
          <div
            className={cn(
              "flex shrink-0 flex-col gap-4 p-4",
              type === "Class" && "border-b",
            )}
          >
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <TypeVisualIcon visual={selectedVisual} />
              </span>
              <div className="min-w-0 flex flex-col gap-1">
                <p className="truncate font-medium">
                  {creatableAssetTypeLabel(type)}
                </p>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="new-asset-type-description"
                >
                  {creatableAssetTypeDescription(type)}
                </p>
              </div>
            </div>
            <FieldGroup>
              <Field data-invalid={nameInvalid || undefined}>
                <FieldLabel htmlFor="new-asset-name">Name</FieldLabel>
                <Input
                  ref={nameRef}
                  id="new-asset-name"
                  data-testid="new-asset-name"
                  className="min-h-[var(--chrome-row,28px)]"
                  value={name}
                  aria-invalid={nameInvalid || undefined}
                  aria-describedby={nameInvalid ? "new-asset-name-error" : undefined}
                  onChange={(event) => onNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (canCreate) onCreate();
                    }
                  }}
                />
                {nameError ? (
                  <FieldError id="new-asset-name-error" data-testid="new-asset-name-invalid">
                    {nameError}
                  </FieldError>
                ) : takenNameError ? (
                  <FieldError id="new-asset-name-error" data-testid="new-asset-name-taken">
                    {takenNameError}
                  </FieldError>
                ) : null}
              </Field>
            </FieldGroup>
            {type === "Water" ? (
              <FieldGroup>
                <Field><FieldLabel>Water Style</FieldLabel>
                  <ToggleGroup value={[waterStyle]} onValueChange={(values) => { const value = values[0]; if (value === "realistic" || value === "stylized") onWaterStyleChange?.(value); }} variant="outline" size="sm" aria-label="Water Style">
                    <ToggleGroupItem value="realistic">Realistic</ToggleGroupItem>
                    <ToggleGroupItem value="stylized">Stylized</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
                {waterStyle === "stylized" ? (
                  <Field><FieldLabel>Stylized Look</FieldLabel>
                    <ToggleGroup value={[waterStylizedLook]} onValueChange={(values) => { const value = values[0]; if (value === "painted" || value === "toon") onWaterStylizedLookChange?.(value); }} variant="outline" size="sm" aria-label="Stylized Look">
                      <ToggleGroupItem value="painted">Painted</ToggleGroupItem>
                      <ToggleGroupItem value="toon">Toon</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                ) : null}
              </FieldGroup>
            ) : null}
            {isData ? (
              <FieldGroup><Field><FieldLabel>Default Definition</FieldLabel>
                <AssetPickerControl value={definitionGuid}>
                  <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => setDefinitionPickerOpen(true)} data-testid="new-asset-definition" disabled={busy}>
                    {definitionAssets.find(asset => asset.guid === definitionGuid)?.name ?? "None"}
                  </Button>
                </AssetPickerControl>
                <AssetPicker open={definitionPickerOpen} onOpenChange={setDefinitionPickerOpen} assets={[...definitionAssets]} allowedTypes={["DataDefinition"]} allowNone title="Choose Default Definition" onPick={guid => { onDefinitionGuidChange?.(guid); setDefinitionPickerOpen(false); }} />
              </Field></FieldGroup>
            ) : null}
            {destinationFolder ? (
              <NewAssetLocation
                folder={destinationFolder}
                busy={busy}
                onChange={onDestinationFolderChange}
                folderTrees={folderTrees}
                isFolderDisabled={isFolderDisabled}
              />
            ) : null}
          </div>
          {type === "Class" ? (
            <div
              className={cn(
                "flex flex-col",
                phone ? "shrink-0" : "min-h-0 flex-1",
              )}
            >
              <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3">
                <FieldLabel>Parent Class</FieldLabel>
                <SearchInput
                  value={parentSearch}
                  onChange={setParentSearch}
                  placeholder="Search Classes"
                  aria-label="Search Parent Classes"
                  className={cn(
                    "min-h-[var(--chrome-row,28px)]",
                    touchSizing && "h-11",
                  )}
                  data-testid="new-asset-parent-search"
                />
              </div>
              <div className={cn("min-h-40 flex-1", phone && "h-72 shrink-0")}>
                <TreeView
                  data-testid="new-asset-parent"
                  aria-label="Parent Class"
                  selectedId={parentClass}
                  emptyLabel="No parent classes match the search."
                  nodes={parentRows.filter((row) => parentSearch || !walkAncestry(row.id, parentOf).slice(1).some((id) => collapsedParents.has(id))).map((row) => ({
                    id: row.id,
                    label: row.id,
                    depth: row.depth,
                    hasChildren: parentRows.some((child) => child.parentClassId === row.id),
                    expanded: Boolean(parentSearch) || !collapsedParents.has(row.id),
                    muted: !row.selectable,
                    icon: <TypeVisualIcon visual={resolveTypeVisual({ classId: row.id, parentClass: row.parentClassId, ancestry: walkAncestry(row.id, parentOf), family: "class" })} />,
                  }))}
                  onSelect={(id) => { if (parentRows.find((row) => row.id === id)?.selectable) onParentClassChange(id); }}
                  onToggleExpanded={(id) => setCollapsedParents((previous) => {
                    const next = new Set(previous);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                  })}
                />
              </div>
            </div>
          ) : null}
        </aside>
        {error ? <Alert variant="destructive"><AlertTitle>Could Not Create Asset</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex shrink-0 justify-end gap-2 border-t bg-muted/40 px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size={touchSizing ? "touch" : "default"}
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size={touchSizing ? "touch" : "default"}
            disabled={!canCreate}
            data-testid="content-browser-new-asset-create"
            onClick={() => onCreate()}
          >
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
