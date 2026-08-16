import { useEffect, useMemo, useRef, useState } from "react";
import {
  SearchInput,
  TYPE_VISUAL_ICON_TILE_SIZE,
  TypeVisualIcon,
  resolveTypeVisual,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { typeColorThumbAccent } from "@babylonslate/ui/lib/data-types";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  CREATABLE_ASSET_TYPE_GROUPS,
  ENGINE_BASE_CLASSES,
  creatableAssetTypeDescription,
  creatableAssetTypeLabel,
  filterCreatableAssetTypes,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";

export interface ContentBrowserNewAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: CreatableAssetType;
  onTypeChange: (type: CreatableAssetType) => void;
  name: string;
  onNameChange: (name: string) => void;
  parentClass: string;
  onParentClassChange: (parentClass: string) => void;
  nameTaken: boolean;
  busy?: boolean;
  onCreate: () => void;
}

export function ContentBrowserNewAssetDialog({
  open,
  onOpenChange,
  type,
  onTypeChange,
  name,
  onNameChange,
  parentClass,
  onParentClassChange,
  nameTaken,
  busy = false,
  onCreate,
}: ContentBrowserNewAssetDialogProps) {
  const [search, setSearch] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectedVisual = resolveTypeVisual({ assetType: type });
  const canCreate = !busy && !nameTaken && Boolean(name.trim());

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  const visibleGroups = useMemo(() => {
    const allowed = new Set(filterCreatableAssetTypes(search));
    return CREATABLE_ASSET_TYPE_GROUPS.flatMap((group) => {
      const types = group.types.filter((item) => allowed.has(item));
      return types.length > 0 ? [{ ...group, types }] : [];
    });
  }, [search]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        data-testid="content-browser-new-asset-dialog"
        initialFocus={bodyRef}
        className="flex h-[min(85vh,40rem)] w-[min(96vw,56rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>New Asset</DialogTitle>
          <DialogDescription>
            Create a new asset in the selected folder.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b px-4 py-3">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search Types"
                className="min-h-[var(--chrome-row,28px)]"
                data-testid="new-asset-type-search"
              />
            </div>
            <div
              ref={bodyRef}
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-y-auto p-4 outline-none"
              data-testid="new-asset-type"
              role="radiogroup"
              aria-label="Asset Type"
            >
              {visibleGroups.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No Types</EmptyTitle>
                    <EmptyDescription>
                      No asset types match the search.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col gap-5">
                  {visibleGroups.map((group) => (
                    <FieldSet key={group.id} className="gap-2">
                      <FieldLegend variant="label">{group.label}</FieldLegend>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
                        {group.types.map((item) => {
                          const selected = item === type;
                          const visual = resolveTypeVisual({ assetType: item });
                          return (
                            <Card
                              key={item}
                              size="sm"
                              className={cn(
                                "gap-0 overflow-hidden py-0",
                                selected ? "border-primary ring-1 ring-primary" : "",
                              )}
                            >
                              <button
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                data-selected={selected ? "true" : "false"}
                                data-testid={`new-asset-type-${item}`}
                                className="flex min-h-[var(--touch-target,44px)] w-full flex-col text-left hover:bg-accent/50"
                                onClick={() => onTypeChange(item)}
                              >
                                <div className="aspect-square w-full overflow-hidden rounded-t-xl p-0.5">
                                  <div
                                    className="flex size-full items-center justify-center bg-card"
                                    style={typeColorThumbAccent(visual.colorVar)}
                                  >
                                    <TypeVisualIcon
                                      visual={visual}
                                      size={TYPE_VISUAL_ICON_TILE_SIZE}
                                    />
                                  </div>
                                </div>
                                <CardHeader className="gap-0.5 p-1.5">
                                  <CardTitle className="truncate text-xs font-medium">
                                    {creatableAssetTypeLabel(item)}
                                  </CardTitle>
                                  <CardDescription className="truncate text-[10px]">
                                    {item}
                                  </CardDescription>
                                </CardHeader>
                              </button>
                            </Card>
                          );
                        })}
                      </div>
                    </FieldSet>
                  ))}
                </div>
              )}
            </div>
          </div>
          <aside className="flex w-72 shrink-0 flex-col border-l">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-start gap-3">
                  <div
                    className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-card p-0.5"
                    style={typeColorThumbAccent(selectedVisual.colorVar)}
                  >
                    <TypeVisualIcon
                      visual={selectedVisual}
                      size={TYPE_VISUAL_ICON_TILE_SIZE}
                    />
                  </div>
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
                  <Field data-invalid={nameTaken || undefined}>
                    <FieldLabel htmlFor="new-asset-name">Name</FieldLabel>
                    <Input
                      id="new-asset-name"
                      data-testid="new-asset-name"
                      className="min-h-[var(--touch-target,44px)]"
                      value={name}
                      aria-invalid={nameTaken || undefined}
                      onChange={(event) => onNameChange(event.target.value)}
                    />
                    {nameTaken ? (
                      <FieldError data-testid="new-asset-name-taken">
                        An asset with this name already exists in the folder.
                      </FieldError>
                    ) : null}
                  </Field>
                  {type === "Class" ? (
                    <Field>
                      <FieldLabel>Parent Class</FieldLabel>
                      <div
                        role="radiogroup"
                        aria-label="Parent Class"
                        data-testid="new-asset-parent"
                        className="flex flex-col gap-1"
                      >
                        {ENGINE_BASE_CLASSES.map((base) => {
                          const selected = parentClass === base;
                          return (
                            <Button
                              key={base}
                              type="button"
                              variant={selected ? "secondary" : "outline"}
                              className={cn(
                                "h-auto min-h-[var(--chrome-row,28px)] w-full justify-start",
                                selected ? "ring-1 ring-primary" : "",
                              )}
                              role="radio"
                              aria-checked={selected}
                              data-selected={selected ? "true" : "false"}
                              data-testid={`new-asset-parent-${base}`}
                              onClick={() => onParentClassChange(base)}
                            >
                              <TypeVisualIcon
                                visual={resolveTypeVisual({
                                  classId: base,
                                  family: "class",
                                })}
                              />
                              {base}
                            </Button>
                          );
                        })}
                      </div>
                    </Field>
                  ) : null}
                </FieldGroup>
              </div>
            </div>
          </aside>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canCreate}
            data-testid="content-browser-new-asset-create"
            onClick={() => onCreate()}
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
