import { useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { NamedListEditor } from "./named-list-editor";
import { TypeColorMark } from "./type-color-mark";
import { PinTypePicker } from "./pin-type-picker";
import { ClassPicker, type ClassPickerEntry } from "./class-picker";
import { AssetPicker, type AssetPickerEntry } from "./asset-picker";
import { SearchDropdown } from "./search-dropdown";
import {
  PickerIdentity,
  assetRowIdentity,
  classRowIdentity,
} from "./picker-identity";
import {
  ASSET_REF_PICKER_TYPES,
  pinPickerColorVar,
  pinPickerKeepsTypeClassId,
  type PinPickerType,
} from "./pin-types";

export type PinListRow = {
  id: string;
  name: string;
  type: PinPickerType | string;
  direction?: "in" | "out";
  optional?: boolean;
  defaultValue?: string;
  enumValues?: readonly string[];
  typeClassId?: string;
};

export type PinListEditorProps = {
  rows: PinListRow[];
  onChange: (rows: PinListRow[]) => void;
  title?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  showDirection?: boolean;
  types?: readonly string[];
  classEntries?: readonly ClassPickerEntry[];
  typeAssets?: readonly AssetPickerEntry[];
  testIdPrefix?: string;
  readOnly?: boolean;
  "data-testid"?: string;
};

function isReferencePinType(type: string): boolean {
  return type === "object" || type === "actor" || type === "class";
}

function isAssetPinType(type: string): boolean {
  return type === "asset";
}

function isTypeAssetPinType(type: string): boolean {
  return type === "struct" || type === "enum";
}

function typeAssetAllowedTypes(type: string): string[] {
  return type === "enum" ? ["Enum"] : ["Structure"];
}

function patchRow(
  rows: PinListRow[],
  id: string,
  patch: Partial<PinListRow>,
): PinListRow[] {
  return rows.map((row) => {
    if (row.id !== id) return row;
    const next = { ...row, ...patch };
    if ("type" in patch && !pinPickerKeepsTypeClassId(String(patch.type))) {
      delete next.typeClassId;
    }
    return next;
  });
}

function moveRow(
  rows: PinListRow[],
  index: number,
  delta: number,
): PinListRow[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= rows.length) return rows;
  const next = [...rows];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

function addPin(
  rows: PinListRow[],
  name: string,
  direction: "in" | "out" | undefined,
): PinListRow[] {
  return [
    ...rows,
    {
      id: `p_${Date.now()}`,
      name,
      type: "float",
      ...(direction ? { direction } : {}),
    },
  ];
}

/** Compact Unreal-like pin rows: color chip, name, type picker, move/remove. */
export function PinListEditor({
  rows,
  onChange,
  title,
  selectedId,
  onSelect,
  showDirection = false,
  types,
  classEntries = [],
  typeAssets,
  testIdPrefix = "pin",
  readOnly = false,
  "data-testid": testId = "pin-list-editor",
}: PinListEditorProps) {
  const [draftName, setDraftName] = useState("");
  const [classPickRowId, setClassPickRowId] = useState<string | null>(null);
  const [typeAssetPickRowId, setTypeAssetPickRowId] = useState<string | null>(
    null,
  );
  const hasTypeAssets = typeAssets !== undefined;
  const typeAssetList = typeAssets ?? [];

  const commitAdd = (direction?: "in" | "out") => {
    const name = draftName.trim();
    if (!name) return;
    onChange(addPin(rows, name, direction));
    setDraftName("");
  };

  const classPickRow = classPickRowId
    ? rows.find((row) => row.id === classPickRowId)
    : undefined;
  const typeAssetPickRow = typeAssetPickRowId
    ? rows.find((row) => row.id === typeAssetPickRowId)
    : undefined;

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {rows.map((row, index) => {
        const selected = selectedId === row.id;
        const classId = row.typeClassId?.trim() || "BObject";
        const classIdentity = classRowIdentity(
          classEntries.find((entry) => entry.id === classId),
          classId,
        );
        const typeAsset = typeAssetList.find(
          (asset) => asset.guid === row.typeClassId,
        );
        const typeAssetIdentity = assetRowIdentity(
          typeAsset
            ? { name: typeAsset.name, type: typeAsset.type }
            : row.typeClassId
              ? {
                  name: row.typeClassId,
                  type: row.type === "enum" ? "Enum" : "Structure",
                }
              : undefined,
        );
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div
              className={`flex min-h-[var(--chrome-row,28px)] items-center gap-1 rounded-md px-1 ${
                selected ? "bg-accent" : "hover:bg-accent/50"
              }`}
              data-testid={`${testIdPrefix}-row-${row.id}`}
              onClick={() => onSelect?.(row.id)}
            >
              <TypeColorMark colorVar={pinPickerColorVar(row.type)} />
              <Input
                className="h-7 min-h-7 min-w-0 flex-1"
                value={row.name}
                aria-label={`Pin ${index + 1} name`}
                data-testid={`${testIdPrefix}-${row.id}-name`}
                disabled={readOnly}
                onChange={(event) =>
                  onChange(patchRow(rows, row.id, { name: event.target.value }))
                }
              />
              <PinTypePicker
                value={row.type}
                types={types}
                onChange={(type) => {
                  if (readOnly) return;
                  onChange(patchRow(rows, row.id, { type }));
                }}
                data-testid={`${testIdPrefix}-${row.id}-type`}
              />
              {readOnly ? null : (
              <div className="flex shrink-0 items-center gap-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  aria-label={`Move ${row.name} up`}
                  data-testid={`${testIdPrefix}-${row.id}-move-up`}
                  disabled={index === 0}
                  onClick={() => onChange(moveRow(rows, index, -1))}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  aria-label={`Move ${row.name} down`}
                  data-testid={`${testIdPrefix}-${row.id}-move-down`}
                  disabled={index === rows.length - 1}
                  onClick={() => onChange(moveRow(rows, index, 1))}
                >
                  <ChevronDownIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  aria-label={`Remove ${row.name}`}
                  onClick={() =>
                    onChange(rows.filter((entry) => entry.id !== row.id))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
              )}
            </div>
            {selected && !readOnly ? (
              <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
                <Field orientation="horizontal">
                  <Checkbox
                    id={`${testIdPrefix}-${row.id}-optional`}
                    checked={row.optional === true}
                    onCheckedChange={(checked) =>
                      onChange(
                        patchRow(rows, row.id, { optional: checked === true }),
                      )
                    }
                    data-testid={`${testIdPrefix}-${row.id}-optional`}
                  />
                  <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-optional`}>
                    Optional
                  </FieldLabel>
                </Field>
                {isReferencePinType(row.type) ? (
                  <Field className="min-w-32 flex-1">
                    <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-class-type`}>
                      Class Type
                    </FieldLabel>
                    <Button
                      id={`${testIdPrefix}-${row.id}-class-type`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-7 justify-start"
                      data-testid={`${testIdPrefix}-${row.id}-class-type`}
                      onClick={() => setClassPickRowId(row.id)}
                    >
                      <PickerIdentity
                        label={classIdentity.displayLabel ?? classId}
                        description={classIdentity.displayType}
                        visual={classIdentity.visual}
                      />
                    </Button>
                  </Field>
                ) : isAssetPinType(row.type) ? (
                  <Field className="min-w-32 flex-1">
                    <FieldLabel>Asset Type</FieldLabel>
                    <SearchDropdown
                      title="Asset Type"
                      items={ASSET_REF_PICKER_TYPES.map((assetType) => ({
                        id: assetType,
                        label: assetType,
                        description: "Asset",
                      }))}
                      onSelect={(id) =>
                        onChange(patchRow(rows, row.id, { typeClassId: id }))
                      }
                      data-testid={`${testIdPrefix}-${row.id}-asset-type-picker`}
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto min-h-7 justify-start"
                        data-testid={`${testIdPrefix}-${row.id}-asset-type`}
                      >
                        {row.typeClassId?.trim()
                          ? row.typeClassId
                          : "Pick type"}
                      </Button>
                    </SearchDropdown>
                  </Field>
                ) : isTypeAssetPinType(row.type) && hasTypeAssets ? (
                  <Field className="min-w-32 flex-1">
                    <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-type-asset`}>
                      {row.type === "enum" ? "Enum Type" : "Structure Type"}
                    </FieldLabel>
                    <Button
                      id={`${testIdPrefix}-${row.id}-type-asset`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-7 justify-start"
                      data-testid={`${testIdPrefix}-${row.id}-type-asset`}
                      onClick={() => setTypeAssetPickRowId(row.id)}
                    >
                      <PickerIdentity
                        label={
                          typeAssetIdentity.displayLabel ??
                          row.typeClassId ??
                          "None"
                        }
                        description={typeAssetIdentity.displayType}
                        visual={typeAssetIdentity.visual}
                      />
                    </Button>
                  </Field>
                ) : (
                  <Field className="min-w-32 flex-1">
                    <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-default`}>
                      Default
                    </FieldLabel>
                    <Input
                      id={`${testIdPrefix}-${row.id}-default`}
                      className="h-7 min-h-7"
                      value={row.defaultValue ?? ""}
                      data-testid={`${testIdPrefix}-${row.id}-default`}
                      onChange={(event) =>
                        onChange(
                          patchRow(rows, row.id, {
                            defaultValue: event.target.value,
                          }),
                        )
                      }
                    />
                  </Field>
                )}
                {row.type === "enum" && !hasTypeAssets ? (
                  <NamedListEditor
                    values={[...(row.enumValues ?? [])]}
                    onChange={(enumValues) =>
                      onChange(patchRow(rows, row.id, { enumValues }))
                    }
                    title="Enum Values"
                    addPlaceholder="value"
                    addLabel="Add Value"
                    data-testid={`${testIdPrefix}-${row.id}-enum-values`}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {readOnly ? null : (
      <Field>
        <FieldLabel htmlFor="pin-add-name">Add Pin</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            id="pin-add-name"
            className="h-8 min-h-8 min-w-0 flex-1"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="name"
          />
          {showDirection ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`${testIdPrefix}-add-input`}
                onClick={() => commitAdd("in")}
              >
                Add Input
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`${testIdPrefix}-add-output`}
                onClick={() => commitAdd("out")}
              >
                Add Output
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`${testIdPrefix}-add`}
              onClick={() => commitAdd()}
            >
              Add
            </Button>
          )}
        </div>
      </Field>
      )}
      <ClassPicker
        open={classPickRowId !== null}
        onOpenChange={(open) => {
          if (!open) setClassPickRowId(null);
        }}
        classes={[...classEntries]}
        allowNone={false}
        title="Pick Class Type"
        onPick={(classId) => {
          if (classPickRow && classId) {
            onChange(patchRow(rows, classPickRow.id, { typeClassId: classId }));
          }
          setClassPickRowId(null);
        }}
        data-testid={`${testId}-class-picker`}
      />
      <AssetPicker
        open={typeAssetPickRowId !== null}
        onOpenChange={(open) => {
          if (!open) setTypeAssetPickRowId(null);
        }}
        assets={[...typeAssetList]}
        allowedTypes={
          typeAssetPickRow
            ? typeAssetAllowedTypes(String(typeAssetPickRow.type))
            : undefined
        }
        allowNone
        title={
          typeAssetPickRow?.type === "enum"
            ? "Pick Enum Type"
            : "Pick Structure Type"
        }
        onPick={(guid) => {
          if (typeAssetPickRow) {
            onChange(
              patchRow(rows, typeAssetPickRow.id, {
                typeClassId: guid ?? undefined,
              }),
            );
          }
          setTypeAssetPickRowId(null);
        }}
        data-testid={`${testId}-type-asset-picker`}
      />
    </div>
  );
}
