import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { normalizeTag } from "@babylonslate/core";
import { nextCopyName } from "@babylonslate/assets";
import { cn } from "@babylonslate/ui/lib/utils";
import { EditableName } from "./inline-rename";
import { TagPicker } from "./tag-picker";
import { VariableTypeFields, type VariableContainer } from "./variable-type-fields";
import { Button } from "@babylonslate/ui/components/button";
import { ListRowActions } from "./list-row-actions";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { NamedListEditor } from "./named-list-editor";
import { TypeColorMark } from "./type-color-mark";
import { PinTypeMenu, PinTypePicker } from "./pin-type-picker";
import { ClassPicker, type ClassPickerEntry } from "./class-picker";
import { AssetPicker, type AssetPickerEntry } from "./asset-picker";
import { AssetPickerControl } from "./asset-picker-control";
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
  container?: VariableContainer;
  keyTypeId?: string;
  keyTypeClassId?: string;
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
  showOptional?: boolean;
  showDefault?: boolean;
  showContainer?: boolean;
  /** Keep the list compact when another panel owns the selected row details. */
  showDetails?: boolean;
  addPosition?: "top" | "bottom";
  types?: readonly string[];
  classEntries?: readonly ClassPickerEntry[];
  typeAssets?: readonly AssetPickerEntry[];
  structAssetType?: "Structure" | "DataDefinition";
  itemLabel?: string;
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

function typeAssetAllowedTypes(type: string, structAssetType?: string): string[] {
  return type === "enum" ? ["Enum"] : structAssetType ? [structAssetType] : ["Structure", "DataDefinition"];
}

function patchRow(
  rows: PinListRow[],
  id: string,
  patch: Partial<PinListRow>,
): PinListRow[] {
  return rows.map((row) => {
    if (row.id !== id) return row;
    const resolved = patch.type === "tagContainer" ? { ...patch, type: "struct", typeClassId: "engine:TagContainer" } : patch;
    const next = { ...row, ...resolved };
    if ("type" in resolved && (!pinPickerKeepsTypeClassId(String(resolved.type)) || (row.typeClassId === "engine:TagContainer" && patch.type !== "tagContainer" && patch.typeClassId === undefined))) {
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

/** `NewField`, then `NewField_1`, … so new rows never collide with existing names. */
export function nextPinRowName(rows: readonly PinListRow[], itemLabel: string): string {
  return nextCopyName(`New${itemLabel.replace(/\s+/g, "")}`, rows.map((row) => row.name));
}

function addPin(
  rows: PinListRow[],
  id: string,
  name: string,
  type: string,
  direction: "in" | "out" | undefined,
): PinListRow[] {
  const row: PinListRow = { id, name, type: "float", ...(direction ? { direction } : {}) };
  return patchRow([...rows, row], id, { type });
}

/** Compact Unreal-like pin rows: color chip, renameable name, type picker, move/remove. Add picks a type first. */
export function PinListEditor({
  rows,
  onChange,
  title,
  selectedId,
  onSelect,
  showDirection = false,
  showOptional = true,
  showDefault = true,
  showContainer = false,
  showDetails = true,
  addPosition = "bottom",
  types,
  classEntries = [],
  typeAssets,
  structAssetType,
  itemLabel = "Pin",
  testIdPrefix = "pin",
  readOnly = false,
  "data-testid": testId = "pin-list-editor",
}: PinListEditorProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const effectiveSelectedId = selectedId === undefined ? localSelectedId : selectedId;
  const structLabel = structAssetType === "DataDefinition" ? "Data Definition" : structAssetType ?? "Structure / Data Definition";
  const [classPickRowId, setClassPickRowId] = useState<string | null>(null);
  const [typeAssetPickRowId, setTypeAssetPickRowId] = useState<string | null>(
    null,
  );
  const hasTypeAssets = typeAssets !== undefined;
  const typeAssetList = typeAssets ?? [];

  const select = (id: string) => {
    if (selectedId === undefined) setLocalSelectedId(id);
    onSelect?.(id);
  };
  const commitAdd = (type: string, direction?: "in" | "out") => {
    const id = `p_${crypto.randomUUID()}`;
    onChange(addPin(rows, id, nextPinRowName(rows, itemLabel), type, direction));
    select(id);
    setRenamingId(id);
  };

  const classPickRow = classPickRowId
    ? rows.find((row) => row.id === classPickRowId)
    : undefined;
  const typeAssetPickRow = typeAssetPickRowId
    ? rows.find((row) => row.id === typeAssetPickRowId)
    : undefined;

  const addButton = (label: string, testSuffix: string, direction?: "in" | "out") => (
    <PinTypeMenu
      key={testSuffix}
      title={`${label} Type`}
      types={types}
      labels={{ struct: structLabel }}
      onSelect={(type) => commitAdd(type, direction)}
      data-testid={`${testIdPrefix}-${testSuffix}-menu`}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:min-h-11"
        data-testid={`${testIdPrefix}-${testSuffix}`}
      >
        <PlusIcon data-icon="inline-start" />
        {label}
      </Button>
    </PinTypeMenu>
  );
  const addField = readOnly ? null : (
    <div className="flex flex-wrap items-center gap-1">
      {showDirection
        ? [addButton("Add Input", "add-input", "in"), addButton("Add Output", "add-output", "out")]
        : addButton(`Add ${itemLabel}`, "add")}
    </div>
  );

  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {addPosition === "top" ? addField : null}
      {rows.map((row, index) => {
        const selected = effectiveSelectedId === row.id;
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
                  type: row.type === "enum" ? "Enum" : structAssetType ?? "Record",
                }
              : undefined,
        );
        const showClassType = isReferencePinType(row.type);
        const showAssetType = isAssetPinType(row.type);
        const showTypeAsset = isTypeAssetPinType(row.type) && hasTypeAssets;
        const showDefaultField =
          showDefault && !showClassType && !showAssetType && !showTypeAsset;
        const showEnumValues = row.type === "enum" && !hasTypeAssets;
        const showExtras =
          selected &&
          showDetails &&
          !readOnly &&
          (showContainer || showOptional ||
            showDefaultField ||
            showClassType ||
            showAssetType ||
            showTypeAsset ||
            showEnumValues);
        return (
          <div
            key={row.id}
            className="group/pin-row flex flex-nowrap items-center gap-1"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div
              className={cn(
                "flex min-h-[var(--chrome-row,28px)] items-center gap-1.5 rounded-sm pl-2 pr-0.5 transition-colors motion-reduce:transition-none pointer-coarse:min-h-11",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
              data-testid={`${testIdPrefix}-row-${row.id}`}
              onClick={() => select(row.id)}
              onFocus={() => select(row.id)}
            >
              <TypeColorMark colorVar={pinPickerColorVar(row.type === "struct" && row.typeClassId === "engine:TagContainer" ? "tagContainer" : row.type)} />
              <EditableName
                value={row.name}
                aria-label={`${itemLabel} ${index + 1} name`}
                data-testid={`${testIdPrefix}-${row.id}-name`}
                disabled={readOnly}
                editing={renamingId === row.id}
                onEditingChange={(editing) => setRenamingId(editing ? row.id : null)}
                onRename={(name) => onChange(patchRow(rows, row.id, { name }))}
                className={selected ? "font-medium" : undefined}
              />
              <PinTypePicker
                compact
                disabled={readOnly}
                labels={{ struct: structLabel }}
                value={row.type === "struct" && row.typeClassId === "engine:TagContainer" ? "tagContainer" : row.type}
                types={types}
                onChange={(type) => {
                  if (readOnly) return;
                  onChange(patchRow(rows, row.id, { type }));
                }}
                data-testid={`${testIdPrefix}-${row.id}-type`}
              />
            </div>
            {showExtras ? (
              <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
                {showContainer ? (
                  <VariableTypeFields
                    showType={false}
                    value={{ ...row, typeId: row.type, container: row.container ?? "single" }}
                    classEntries={classEntries}
                    typeAssets={typeAssets}
                    structAssetType={structAssetType}
                    types={types}
                    onChange={({ typeId, ...next }) => onChange(patchRow(rows, row.id, { ...next, type: typeId }))}
                  />
                ) : null}
                {showOptional ? (
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
                ) : null}
                {showClassType ? (
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
                ) : showAssetType ? (
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
                ) : showTypeAsset ? (
                  <Field className="min-w-32 flex-1">
                    <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-type-asset`}>
                      {row.type === "enum" ? "Enum Type" : `${structLabel} Type`}
                    </FieldLabel>
                    <AssetPickerControl value={row.typeClassId}>
                      <Button
                        id={`${testIdPrefix}-${row.id}-type-asset`}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto min-h-7 justify-start w-full"
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
                    </AssetPickerControl>
                  </Field>
                ) : showDefaultField ? (
                  <Field className="min-w-32 flex-1">
                    <FieldLabel htmlFor={`${testIdPrefix}-${row.id}-default`}>
                      Default
                    </FieldLabel>
                    {row.type === "tag" ? <TagPicker
                      mode="single"
                      id={`${testIdPrefix}-${row.id}-default`}
                      value={normalizeTag(Number(row.defaultValue ?? 0))}
                      onChange={(tag) => onChange(patchRow(rows, row.id, { defaultValue: String(tag) }))}
                      data-testid={`${testIdPrefix}-${row.id}-default`}
                    /> : <Input
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
                    />}
                  </Field>
                ) : null}
                {showEnumValues ? (
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
            {readOnly ? null : (
              <ListRowActions
                className={cn("transition-opacity motion-reduce:transition-none pointer-coarse:opacity-100", selected ? "opacity-100" : "opacity-0 group-hover/pin-row:opacity-100 group-focus-within/pin-row:opacity-100")}
                index={index}
                count={rows.length}
                name={row.name}
                testIdPrefix={testIdPrefix}
                rowId={row.id}
                onMove={(delta) => onChange(moveRow(rows, index, delta))}
                onRemove={() =>
                  onChange(rows.filter((entry) => entry.id !== row.id))
                }
              />
            )}
          </div>
        );
      })}
      {addPosition === "bottom" ? addField : null}
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
            ? typeAssetAllowedTypes(String(typeAssetPickRow.type), structAssetType)
            : undefined
        }
        allowNone
        title={
          typeAssetPickRow?.type === "enum"
            ? "Pick Enum Type"
            : `Pick ${structLabel} Type`
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
