import { useState } from "react";
import {
  carriesLoadingPolicy,
  normalizeClassMemberCategory,
  parseMapDefaultEntries,
  type GraphClassMember,
  type SerializedGraph,
} from "@haptic/core";
import {
  AssetLoadingField,
  AssetPicker,
  AssetPickerControl,
  ClassPicker,
  FUNCTION_PIN_PICKER_TYPES,
  EntryListEditor,
  PinListEditor,
  PropertyGrid,
  SearchDropdown,
  VariableTypeFields,
  assetRowIdentity,
  classRowIdentity,
  selectedPickerIdentity,
  ASSET_REF_PICKER_TYPES,
  type ClassPickerEntry,
  type PinListRow,
  type VariableTypeFieldsValue,
} from "@haptic/editor-kit";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Button } from "@haptic/ui/components/button";
import {
  variableAssetPickerAllowedTypes,
  variableDefaultPropertyRows,
} from "../lib/graph-inspector";
import { unitPatchForType, valueUnitRow } from "../lib/value-unit-row";
import { defaultValueForMember, keepsTypeClassId } from "@haptic/scripting";
import { patchClassMember } from "../lib/class-members";
import type { typeSchemasFromGraphAssets } from "../lib/logic-graph-document";
import {
  asArrayDefaults,
  committedPinRowIds,
  constrainedTypeClassId,
  defaultValueForVariableType,
  memberPinRows,
  memberPinsFromRows,
  pinRowIdsFor,
  seedVariableEntry,
  variableContainerOf,
  type CommittedPinRowIds,
} from "./inspector-member-rows";

export function ClassMemberDetails({
  graph,
  member,
  interfaceAssets,
  classEntries,
  typeAssets,
  pickerAssets,
  schemas,
  enumMembers,
  classId,
  onChange,
}: {
  graph: SerializedGraph;
  member: GraphClassMember;
  interfaceAssets: Array<{ guid: string; name: string; type: string }>;
  classEntries: ClassPickerEntry[];
  typeAssets: Array<{ guid: string; name: string; type: string }>;
  pickerAssets: Array<{
    guid: string;
    name: string;
    type: string;
    path?: string;
  }>;
  schemas: ReturnType<typeof typeSchemasFromGraphAssets>;
  enumMembers: Record<string, string[]>;
  /** This document's class id, so renames and signature edits reach only its own Calls. */
  classId?: string;
  onChange: (next: SerializedGraph) => void;
}) {
  const [interfacePickerOpen, setInterfacePickerOpen] = useState(false);
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  const [typeAssetPickerOpen, setTypeAssetPickerOpen] = useState(false);
  /** The Default row the asset picker fills: the whole value or one Structure field. */
  const [defaultAssetPick, setDefaultAssetPick] = useState<{
    rowId: string;
    assetType: string;
  } | null>(null);
  const [entryPick, setEntryPick] = useState<{
    index: number;
    field: "value" | "key";
  } | null>(null);
  const [pinRowIds, setPinRowIds] = useState<CommittedPinRowIds | null>(null);
  const commit = (patch: Partial<GraphClassMember>) => {
    onChange(patchClassMember(graph, member.id, patch, classId));
  };
  const categoryRow = {
    id: "category",
    kind: "text" as const,
    label: "Category",
    value: member.category ?? "",
    onChange: () => {},
    onCommit: (category: string) => {
      if ((normalizeClassMemberCategory(category) ?? "") === (member.category ?? "")) return;
      commit({ category });
    },
  };

  if (member.kind === "variable") {
    const typeId = member.typeId ?? "float";
    const container = variableContainerOf(member);
    const isObject = typeId === "object";
    const isClass = typeId === "class";
    const isStruct = typeId === "struct";
    const isEnum = typeId === "enum";
    const isAsset = typeId === "asset";
    const typeClassId =
      member.typeClassId?.trim() ||
      (isObject || isClass ? "Object" : "");
    const typeAsset = typeAssets.find((asset) => asset.guid === typeClassId);
    const typeAssetIdentity = assetRowIdentity(
      typeAsset
        ? { name: typeAsset.name, type: typeAsset.type }
        : typeClassId
          ? { name: typeClassId, type: isEnum ? "Enum" : "Record" }
          : undefined,
    );
    const assetEntries = pickerAssets.map((asset) => ({
      id: asset.guid,
      name: asset.name,
      type: asset.type,
    }));
    const commitTypeFields = (next: VariableTypeFieldsValue) => {
      const nextContainer =
        next.container === "array" || next.container === "map"
          ? next.container
          : "single";
      const keepParam = keepsTypeClassId(next.typeId);
      const nextClassId = keepParam
        ? constrainedTypeClassId(next.typeId, next.typeClassId)
        : undefined;
      const typeChanged = next.typeId !== typeId;
      const containerChanged = nextContainer !== container;
      const keyChanged =
        (next.keyTypeId ?? "string") !== (member.keyTypeId ?? "string") ||
        (next.keyTypeClassId ?? "") !== (member.keyTypeClassId ?? "");
      const classChanged = (nextClassId ?? "") !== (typeClassId || "");
      const patch: Partial<GraphClassMember> = {
        typeId: next.typeId,
        container: nextContainer === "single" ? undefined : nextContainer,
        keyTypeId:
          nextContainer === "map" ? (next.keyTypeId ?? "string") : undefined,
        keyTypeClassId:
          nextContainer === "map" ? next.keyTypeClassId : undefined,
        typeClassId: nextClassId,
      };
      // Loading only applies to asset and Class references.
      if (member.loading && !carriesLoadingPolicy(patch)) patch.loading = undefined;
      if (member.unit) Object.assign(patch, unitPatchForType(next.typeId));
      if (
        typeChanged ||
        containerChanged ||
        (classChanged && (next.typeId === "struct" || next.typeId === "enum")) ||
        (nextContainer !== "single" && (keyChanged || classChanged))
      ) {
        patch.defaultValue = defaultValueForVariableType(
          {
            typeId: next.typeId,
            typeClassId: nextClassId,
            container: nextContainer,
          },
          schemas,
        );
      }
      commit(patch);
    };
    const singleDefaultRows = variableDefaultPropertyRows(
      typeId,
      member.defaultValue,
      (value) => commit({ defaultValue: value }),
      {
        typeClassId: member.typeClassId,
        schemas,
        enumMembers,
        container,
        assetEntries,
        onPickAsset: (rowId, assetType) => setDefaultAssetPick({ rowId, assetType }),
        unit: member.unit,
      },
    );
    const unitRow = valueUnitRow("unit", typeId, member.unit, (unit) => commit({ unit }));
    return (
      <div
        className="flex flex-col gap-3 p-3"
        data-testid="inspector-member-variable"
      >
        <div className="text-sm font-medium">{member.name}</div>
        <PropertyGrid
          rows={[
            {
              id: "name",
              kind: "text",
              label: "Name",
              value: member.name,
              onChange: (name) => commit({ name }),
            },
            categoryRow,
          ]}
        />
        <VariableTypeFields
          value={{
            typeId,
            typeClassId: member.typeClassId,
            container,
            keyTypeId: member.keyTypeId,
            keyTypeClassId: member.keyTypeClassId,
          }}
          onChange={commitTypeFields}
          classEntries={classEntries}
          typeAssets={typeAssets}
        />
        {isObject || isClass ? (
          <Field>
            <FieldLabel>Class Type</FieldLabel>
            <Button
              type="button"
              variant="outline"
              className="h-auto w-full justify-start"
              data-testid="inspector-member-class-type"
              onClick={() => setClassPickerOpen(true)}
            >
              {selectedPickerIdentity(
                classRowIdentity(
                  classEntries.find((entry) => entry.id === typeClassId),
                  typeClassId,
                ),
              )}
            </Button>
          </Field>
        ) : isStruct || isEnum ? (
          <Field>
            <FieldLabel>{isEnum ? "Enum Type" : "Record Type"}</FieldLabel>
            <AssetPickerControl value={typeClassId}>
              <Button
                type="button"
                variant="outline"
                className="h-auto w-full justify-start"
                data-testid="inspector-member-type-asset"
                onClick={() => setTypeAssetPickerOpen(true)}
              >
                {selectedPickerIdentity(
                  typeAssetIdentity,
                  typeClassId || "Pick type",
                )}
              </Button>
            </AssetPickerControl>
          </Field>
        ) : isAsset ? (
          <Field>
            <FieldLabel>Asset Type</FieldLabel>
            <SearchDropdown
              title="Asset Type"
              items={ASSET_REF_PICKER_TYPES.map((assetType) => ({
                id: assetType,
                label: assetType,
                description: "Asset",
              }))}
              onSelect={(id) => {
                const allowed = new Set(variableAssetPickerAllowedTypes(id));
                const guid =
                  typeof member.defaultValue === "string"
                    ? member.defaultValue.trim()
                    : "";
                const listed = guid
                  ? pickerAssets.find((asset) => asset.guid === guid)
                  : undefined;
                const keep =
                  container !== "single"
                    ? []
                    : listed && allowed.has(listed.type)
                      ? member.defaultValue
                      : "";
                commit({ typeClassId: id, defaultValue: keep });
              }}
              data-testid="inspector-member-asset-type-picker"
            >
              <Button
                type="button"
                variant="outline"
                className="h-auto w-full justify-start"
                data-testid="inspector-member-asset-type"
              >
                {selectedPickerIdentity(
                  typeClassId
                    ? { displayLabel: typeClassId, displayType: "Asset" }
                    : { displayLabel: undefined },
                  "Pick type",
                )}
              </Button>
            </SearchDropdown>
          </Field>
        ) : null}
        {!member.functionId &&
        carriesLoadingPolicy({ typeId, container, keyTypeId: member.keyTypeId }) ? (
          <AssetLoadingField
            value={member.loading}
            onChange={(policy) =>
              commit({ loading: policy === "hard" ? "hard" : undefined })
            }
            data-testid="inspector-member-loading"
          />
        ) : null}
        {unitRow ? <PropertyGrid rows={[unitRow]} /> : null}
        {singleDefaultRows.length > 0 ? (
          <PropertyGrid rows={singleDefaultRows} />
        ) : null}
        {container === "array" ? (
          <EntryListEditor
            items={asArrayDefaults(member.defaultValue)}
            onChange={(defaultValue) => commit({ defaultValue })}
            onCreate={() =>
              seedVariableEntry(typeId, member.typeClassId, schemas)
            }
            addLabel="Add Item"
            data-testid="inspector-member-defaults"
            renderItem={({ item, index, onChange: changeItem }) => (
              <PropertyGrid
                orientation="horizontal"
                hideLabels
                density="compact"
                rows={variableDefaultPropertyRows(typeId, item, changeItem, {
                  typeClassId: member.typeClassId,
                  schemas,
                  enumMembers,
                  assetEntries,
                  onPickAsset: () => setEntryPick({ index, field: "value" }),
                  classEntries,
                  onPickClass: () => setEntryPick({ index, field: "value" }),
                  label: `Item ${index + 1}`,
                  pinId: `item-${index}`,
                  unit: member.unit,
                })}
              />
            )}
          />
        ) : null}
        {container === "map" ? (
          <EntryListEditor
            items={parseMapDefaultEntries(member.defaultValue)}
            onChange={(defaultValue) => commit({ defaultValue })}
            onCreate={() => ({
              key: seedVariableEntry(
                member.keyTypeId ?? "string",
                member.keyTypeClassId,
                schemas,
              ),
              value: seedVariableEntry(typeId, member.typeClassId, schemas),
            })}
            addLabel="Add Entry"
            countNoun={{ one: "entry", other: "entries" }}
            data-testid="inspector-member-defaults"
            renderItem={({ item, index, onChange: changeItem }) => (
              <div className="flex flex-col gap-1">
                <PropertyGrid
                  orientation="horizontal"
                  density="compact"
                  rows={variableDefaultPropertyRows(
                    member.keyTypeId ?? "string",
                    item.key,
                    (key) => changeItem({ ...item, key }),
                    {
                      typeClassId: member.keyTypeClassId,
                      schemas,
                      enumMembers,
                      assetEntries,
                      onPickAsset: () => setEntryPick({ index, field: "key" }),
                      classEntries,
                      onPickClass: () => setEntryPick({ index, field: "key" }),
                      label: "Key",
                      pinId: `key-${index}`,
                    },
                  )}
                />
                <PropertyGrid
                  orientation="horizontal"
                  density="compact"
                  rows={variableDefaultPropertyRows(
                    typeId,
                    item.value,
                    (value) => changeItem({ ...item, value }),
                    {
                      typeClassId: member.typeClassId,
                      schemas,
                      enumMembers,
                      assetEntries,
                      onPickAsset: () =>
                        setEntryPick({ index, field: "value" }),
                      classEntries,
                      onPickClass: () =>
                        setEntryPick({ index, field: "value" }),
                      label: "Value",
                      unit: member.unit,
                      pinId: `value-${index}`,
                    },
                  )}
                />
              </div>
            )}
          />
        ) : null}
        <ClassPicker
          open={classPickerOpen}
          onOpenChange={setClassPickerOpen}
          classes={classEntries}
          allowNone={false}
          title="Pick Class Type"
          onPick={(classId) => {
            if (!classId) return;
            const patch: Partial<GraphClassMember> = { typeClassId: classId };
            if (container !== "single") patch.defaultValue = [];
            else if (isClass) patch.defaultValue = classId;
            commit(patch);
            setClassPickerOpen(false);
          }}
          data-testid="inspector-member-class-picker"
        />
        <AssetPicker
          open={typeAssetPickerOpen}
          onOpenChange={setTypeAssetPickerOpen}
          assets={typeAssets}
          allowedTypes={isEnum ? ["Enum"] : ["Structure", "DataDefinition"]}
          allowNone
          title={isEnum ? "Pick Enum Type" : "Pick Record Type"}
          onPick={(guid) => {
            commit({
              typeClassId: guid ?? undefined,
              defaultValue:
                container === "single"
                  ? defaultValueForMember(typeId, guid ?? undefined, schemas)
                  : [],
            });
            setTypeAssetPickerOpen(false);
          }}
          data-testid="inspector-member-type-asset-picker"
        />
        <AssetPicker
          open={defaultAssetPick !== null}
          onOpenChange={(open) => {
            if (!open) setDefaultAssetPick(null);
          }}
          assets={pickerAssets}
          allowedTypes={variableAssetPickerAllowedTypes(defaultAssetPick?.assetType)}
          allowNone
          title="Pick Asset"
          onPick={(guid) => {
            // The picked row writes its own value, so a Structure field keeps
            // the rest of the Structure default.
            const row = singleDefaultRows.find((entry) => entry.id === defaultAssetPick?.rowId);
            if (row?.kind === "asset") row.onChange(guid ?? "");
            setDefaultAssetPick(null);
          }}
          data-testid="inspector-member-default-asset-picker"
        />
        <AssetPicker
          open={
            entryPick !== null &&
            (entryPick.field === "key" ? member.keyTypeId === "asset" : isAsset)
          }
          onOpenChange={(open) => {
            if (!open) setEntryPick(null);
          }}
          assets={pickerAssets}
          allowedTypes={variableAssetPickerAllowedTypes(
            entryPick?.field === "key"
              ? member.keyTypeClassId
              : member.typeClassId,
          )}
          allowNone
          title="Pick Asset"
          onPick={(guid) => {
            if (!entryPick) return;
            const nextValue = guid ?? "";
            if (container === "array") {
              const items = asArrayDefaults(member.defaultValue);
              items[entryPick.index] = nextValue;
              commit({ defaultValue: items });
            } else {
              const entries = parseMapDefaultEntries(member.defaultValue);
              const current = entries[entryPick.index];
              if (current) {
                entries[entryPick.index] =
                  entryPick.field === "key"
                    ? { ...current, key: nextValue }
                    : { ...current, value: nextValue };
                commit({ defaultValue: entries });
              }
            }
            setEntryPick(null);
          }}
          data-testid="inspector-member-entry-asset-picker"
        />
        <ClassPicker
          open={
            entryPick !== null &&
            (entryPick.field === "key" ? member.keyTypeId === "class" : isClass)
          }
          onOpenChange={(open) => {
            if (!open) setEntryPick(null);
          }}
          classes={classEntries}
          allowNone={false}
          createBaseClass={
            (entryPick?.field === "key"
              ? member.keyTypeClassId
              : member.typeClassId
            )?.trim() || "Object"
          }
          title="Pick Class"
          onPick={(classId) => {
            if (!entryPick || !classId) return;
            if (container === "array") {
              const items = asArrayDefaults(member.defaultValue);
              items[entryPick.index] = classId;
              commit({ defaultValue: items });
            } else {
              const entries = parseMapDefaultEntries(member.defaultValue);
              const current = entries[entryPick.index];
              if (current) {
                entries[entryPick.index] =
                  entryPick.field === "key"
                    ? { ...current, key: classId }
                    : { ...current, value: classId };
                commit({ defaultValue: entries });
              }
            }
            setEntryPick(null);
          }}
          data-testid="inspector-member-entry-class-picker"
        />
      </div>
    );
  }

  if (member.kind === "function") {
    const inputRows = memberPinRows(member.pins, member.id, "in",
      pinRowIdsFor(pinRowIds, member.id, member.pins, "in"));
    const outputRows = memberPinRows(member.pins, member.id, "out",
      pinRowIdsFor(pinRowIds, member.id, member.pins, "out"));
    const commitPins = (
      nextInputs: PinListRow[],
      nextOutputs: PinListRow[],
    ) => {
      const pins = memberPinsFromRows(nextInputs, nextOutputs);
      setPinRowIds(committedPinRowIds(member.id, pins, nextInputs, nextOutputs));
      commit({ pins });
    };
    const interfaceImpl = member.implementsInterface;
    const lockSignature = Boolean(interfaceImpl);
    return (
      <div
        className="flex flex-col gap-3 p-3"
        data-testid="inspector-member-function"
      >
        <div className="text-sm font-medium">{member.name}</div>
        {interfaceImpl ? (
          <div
            className="text-xs text-muted-foreground"
            data-testid="inspector-member-interface-impl"
          >
            Interface Implementation
          </div>
        ) : null}
        <PropertyGrid
          rows={[
            {
              id: "name",
              kind: "text",
              label: "Name",
              value: member.name,
              disabled: lockSignature,
              onChange: (name) => commit({ name }),
            },
            ...(lockSignature
              ? []
              : [
                  {
                    id: "overridable",
                    kind: "boolean" as const,
                    label: "Overridable",
                    value: member.overridable === true,
                    onChange: (overridable: boolean) =>
                      commit({ overridable: overridable ? true : undefined }),
                  },
                ]),
            categoryRow,
          ]}
        />
        <PinListEditor
          title="Inputs"
          rows={inputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          classEntries={classEntries}
          typeAssets={typeAssets}
          itemLabel="Input"
          testIdPrefix="class-fn-in"
          data-testid="inspector-member-inputs"
          showOptional={false}
          showDefault={false}
          showUnit
          readOnly={lockSignature}
          onChange={(nextRows) => commitPins(nextRows, outputRows)}
        />
        <PinListEditor
          title="Outputs"
          rows={outputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          classEntries={classEntries}
          typeAssets={typeAssets}
          itemLabel="Output"
          testIdPrefix="class-fn-out"
          data-testid="inspector-member-outputs"
          showOptional={false}
          showDefault={false}
          readOnly={lockSignature}
          onChange={(nextRows) => commitPins(inputRows, nextRows)}
        />
      </div>
    );
  }

  if (member.kind === "interface") {
    const picked =
      interfaceAssets.find((asset) => asset.guid === member.assetGuid)?.name ??
      member.name;
    return (
      <div
        className="flex flex-col gap-3 p-3"
        data-testid="inspector-member-interface"
      >
        <div className="text-sm font-medium">{member.name}</div>
        <PropertyGrid
          rows={[
            {
              id: "name",
              kind: "text",
              label: "Name",
              value: member.name,
              onChange: (name) => commit({ name }),
            },
          ]}
        />
        <AssetPickerControl value={member.assetGuid}>
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start"
            data-testid="inspector-member-interface-pick"
            onClick={() => setInterfacePickerOpen(true)}
          >
            {selectedPickerIdentity(
              assetRowIdentity(
                interfaceAssets.find(
                  (asset) => asset.guid === member.assetGuid,
                ),
              ),
              picked || "Pick Script Interface",
            )}
          </Button>
        </AssetPickerControl>
        <AssetPicker
          open={interfacePickerOpen}
          onOpenChange={setInterfacePickerOpen}
          assets={interfaceAssets}
          allowedTypes={["ScriptInterface"]}
          allowNone={false}
          title="Pick Script Interface"
          onPick={(guid) => {
            if (!guid) return;
            const named =
              interfaceAssets.find((asset) => asset.guid === guid)?.name ??
              member.name;
            commit({ assetGuid: guid, name: named });
          }}
          data-testid="inspector-interface-picker"
        />
      </div>
    );
  }

  return null;
}
