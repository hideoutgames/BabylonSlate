import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import {
  SearchInput,
  TypeVisualIcon,
  resolveTypeVisual,
  walkAncestry,
} from "@babylonslate/editor-kit";
import { MAX_CLASS_INHERITANCE_DEPTH } from "@babylonslate/object-model";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  CREATABLE_ASSET_TYPE_GROUPS,
  buildParentClassTreeRows,
  classParentLookup,
  creatableAssetTypeDescription,
  creatableAssetTypeLabel,
  filterCreatableAssetTypes,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import { usePhoneLayout } from "../shell/use-platform-layout";

export type NewAssetClassAssetRef = {
  path?: string;
  header: { type: string; name: string; parentClass?: string | null };
};

export interface ContentBrowserNewAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: CreatableAssetType;
  onTypeChange: (type: CreatableAssetType) => void;
  name: string;
  onNameChange: (name: string) => void;
  parentClass: string;
  onParentClassChange: (parentClass: string) => void;
  /** Project + enabled-plugin Class assets for the Parent Class tree. */
  classAssets?: readonly NewAssetClassAssetRef[];
  nameTaken: boolean;
  busy?: boolean;
  onCreate: () => void;
}

function navigateChoice(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  if (!choices.length) return;
  event.preventDefault();
  event.stopPropagation();
  const focused = choices.indexOf(document.activeElement as HTMLButtonElement);
  const current = focused >= 0 ? focused : choices.findIndex((choice) => choice.getAttribute("aria-checked") === "true");
  const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
  const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (current + direction + choices.length) % choices.length;
  choices[next]!.focus();
  choices[next]!.click();
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
  classAssets = [],
  nameTaken,
  busy = false,
  onCreate,
}: ContentBrowserNewAssetDialogProps) {
  const phone = usePhoneLayout();
  const [phoneStep, setPhoneStep] = useState<"type" | "details">("type");
  const [search, setSearch] = useState("");
  const [parentSearch, setParentSearch] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const selectedVisual = resolveTypeVisual({ assetType: type });
  const canCreate = !busy && !nameTaken && Boolean(name.trim());

  useEffect(() => {
    if (open) {
      setSearch("");
      setParentSearch("");
      setPhoneStep("type");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !phone) return;
    const target = phoneStep === "details" ? detailsRef.current : bodyRef.current;
    target?.focus({ preventScroll: true });
  }, [open, phone, phoneStep]);

  const visibleGroups = useMemo(() => {
    const allowed = new Set(filterCreatableAssetTypes(search));
    return CREATABLE_ASSET_TYPE_GROUPS.flatMap((group) => {
      const types = group.types.filter((item) => allowed.has(item));
      return types.length > 0 ? [{ ...group, types }] : [];
    });
  }, [search]);

  useEffect(() => {
    const visible = visibleGroups.flatMap((group) => group.types);
    if (visible.length === 0) return;
    if (visible.includes(type)) return;
    onTypeChange(visible[0]!);
  }, [onTypeChange, type, visibleGroups]);

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
        initialFocus={bodyRef}
        className={cn(
          "editor-dialog-large flex max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none",
        )}
      >
        <DialogHeader className="min-h-14 shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>New Asset</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          {!phone || phoneStep === "type" ? (
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-col",
                phone ? "flex-1" : "w-64 shrink-0",
              )}
            >
              <div className="shrink-0 border-b px-4 py-3">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Search Types"
                  aria-label="Search Asset Types"
                  className={cn(
                    "min-h-[var(--chrome-row,28px)]",
                    phone && "h-11",
                  )}
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
                onKeyDown={navigateChoice}
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
                  <div className="flex flex-col gap-4">
                    {visibleGroups.map((group) => (
                      <FieldSet key={group.id} className="gap-2">
                        <FieldLegend variant="label">{group.label}</FieldLegend>
                        {group.hint ? (
                          <FieldDescription
                            data-testid={`new-asset-group-hint-${group.id}`}
                          >
                            {group.hint}
                          </FieldDescription>
                        ) : null}
                        <div className="flex flex-col gap-1">
                          {group.types.map((item) => {
                            const selected = item === type;
                            const visual = resolveTypeVisual({
                              assetType: item,
                            });
                            return (
                              <Button
                                key={item}
                                type="button"
                                size="sm"
                                variant={selected ? "secondary" : "ghost"}
                                role="radio"
                                tabIndex={selected ? 0 : -1}
                                  aria-checked={selected}
                                  data-selected={selected ? "true" : "false"}
                                  data-testid={`new-asset-type-${item}`}
                                className={cn(
                                  "h-auto w-full justify-start border-l-2 py-2",
                                  selected
                                    ? "border-l-primary"
                                    : "border-l-transparent",
                                )}
                                  onClick={() => onTypeChange(item)}
                                >
                                <TypeVisualIcon visual={visual} />
                                <span className="whitespace-normal text-left">
                                      {creatableAssetTypeLabel(item)}
                                </span>
                              </Button>
                            );
                          })}
                        </div>
                      </FieldSet>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
          {!phone || phoneStep === "details" ? (
            <aside
              ref={detailsRef}
              tabIndex={-1}
              className={cn(
                "flex flex-col outline-none",
                phone
                  ? "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain"
                  : "min-h-0 min-w-0 flex-1 border-l",
              )}
            >
              <div className="flex shrink-0 flex-col gap-4 border-b p-4">
                <div className="flex items-start gap-3">
                  <TypeVisualIcon visual={selectedVisual} />
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
                      className="min-h-[var(--chrome-row,28px)]"
                      value={name}
                      aria-invalid={nameTaken || undefined}
                      aria-describedby={nameTaken ? "new-asset-name-error" : undefined}
                      onChange={(event) => onNameChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          if (canCreate) onCreate();
                        }
                      }}
                    />
                    {nameTaken ? (
                      <FieldError id="new-asset-name-error" data-testid="new-asset-name-taken">
                        An asset with this name already exists in the folder.
                      </FieldError>
                    ) : null}
                  </Field>
                </FieldGroup>
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
                        phone && "h-11",
                      )}
                      data-testid="new-asset-parent-search"
                    />
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Parent Class"
                    onKeyDown={navigateChoice}
                    data-testid="new-asset-parent"
                    className={cn(
                      "p-2",
                      !phone && "min-h-0 flex-1 overflow-y-auto",
                    )}
                  >
                    {parentRows.length === 0 ? (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>No Classes</EmptyTitle>
                          <EmptyDescription>
                            No parent classes match the search.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {parentRows.map((row) => {
                          const selected = parentClass === row.id;
                          return (
                            <Button
                              key={row.id}
                              type="button"
                              variant={selected ? "secondary" : "ghost"}
                              size={phone ? "touch" : "default"}
                              disabled={!row.selectable}
                              className={cn(
                                "h-auto w-full justify-start border-l-2",
                                phone
                                  ? "min-h-11"
                                  : "min-h-[var(--chrome-row,28px)]",
                                selected
                                  ? "border-l-primary"
                                  : "border-l-transparent",
                              )}
                              style={{ paddingLeft: 8 + row.depth * 12 }}
                              role="radio"
                              tabIndex={selected ? 0 : -1}
                              aria-checked={selected}
                              data-selected={selected ? "true" : "false"}
                              data-depth={row.depth}
                              data-group={row.group}
                              data-testid={`new-asset-parent-${row.id}`}
                              onClick={() => onParentClassChange(row.id)}
                            >
                              <TypeVisualIcon
                                visual={resolveTypeVisual({
                                  classId: row.id,
                                  parentClass: row.parentClassId,
                                  ancestry: walkAncestry(row.id, parentOf),
                                  family: "class",
                                })}
                              />
                              <span className="truncate">{row.id}</span>
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size={phone ? "touch" : "default"}
            disabled={busy}
            aria-label={
              phone && phoneStep === "details" ? "Back To Types" : "Cancel"
            }
            onClick={() => {
              if (phone && phoneStep === "details") setPhoneStep("type");
              else onOpenChange(false);
            }}
          >
            {phone && phoneStep === "details" ? (
              <ArrowLeftIcon data-icon="inline-start" />
            ) : null}
            {phone && phoneStep === "details" ? "Back" : "Cancel"}
          </Button>
          {phone && phoneStep === "type" ? (
            <Button
              type="button"
              size="touch"
              disabled={busy || visibleGroups.length === 0}
              onClick={() => setPhoneStep("details")}
            >
              Next
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          ) : (
            <Button
              type="button"
              size={phone ? "touch" : "default"}
              disabled={!canCreate}
              data-testid="content-browser-new-asset-create"
              onClick={() => onCreate()}
            >
              Create
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
