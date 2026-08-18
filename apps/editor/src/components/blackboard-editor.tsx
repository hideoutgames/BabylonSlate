import { useMemo, useState } from "react";
import {
  createDefaultBlackboard,
  parseBlackboardDocument,
  type BlackboardDocument,
  type BlackboardKey,
} from "@babylonslate/behaviour-tree";
import {
  AssetPicker,
  PanelFrame,
  PinTypePicker,
  PropertyGrid,
  assetRowIdentity,
  selectedPickerIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  defaultValueForMember,
  keepsTypeClassId,
  pinTypeForMember,
  typeClassIdFromPinType,
  typeIdFromPinType,
} from "@babylonslate/scripting";
import { useDocuments } from "../context/document-context";
import {
  collectEnumMemberNames,
  variableDefaultPropertyRows,
} from "../lib/graph-inspector";
import {
  collectGraphTypeAssets,
  typeAssetPickerEntries,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";

function asBoard(payload: Record<string, unknown>): BlackboardDocument {
  return parseBlackboardDocument(payload) ?? createDefaultBlackboard();
}

function uniqueKeyName(keys: readonly BlackboardKey[]): string {
  const used = new Set(keys.map((key) => key.name));
  if (!used.has("key")) return "key";
  let index = 2;
  while (used.has(`key${index}`)) index += 1;
  return `key${index}`;
}

export function BlackboardEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { openDocuments, assetRegistry } = useDocuments();
  const doc = useMemo(() => asBoard(payload), [payload]);
  const [selected, setSelected] = useState(0);
  const [typeAssetPickerOpen, setTypeAssetPickerOpen] = useState(false);
  const typeCatalog = collectGraphTypeAssets({
    assets: assetRegistry?.list() ?? [],
    openDocuments,
  });
  const typeSchemas = typeSchemasFromGraphAssets(typeCatalog);
  const typeAssets = typeAssetPickerEntries(typeCatalog);
  const enumMembers = collectEnumMemberNames(
    openDocuments,
    assetRegistry?.list() ?? [],
  );
  const commit = (next: BlackboardDocument) => {
    onChange(next as unknown as Record<string, unknown>);
  };
  const key = doc.keys[selected];
  const pickerTypeId = key ? typeIdFromPinType(key.type) : "bool";
  const typeClassId = key ? typeClassIdFromPinType(key.type) : undefined;
  const isStruct = pickerTypeId === "struct";
  const isEnum = pickerTypeId === "enum";
  const typeAsset = typeAssets.find((entry) => entry.guid === typeClassId);
  const typeAssetIdentity = assetRowIdentity(
    typeAsset
      ? { name: typeAsset.name, type: typeAsset.type }
      : typeClassId
        ? { name: typeClassId, type: isEnum ? "Enum" : "Structure" }
        : undefined,
  );
  const rows: PropertyRow[] = key
    ? [
        {
          id: "name",
          kind: "text",
          label: "Name",
          value: key.name,
          onChange: (name) =>
            commit({
              ...doc,
              keys: doc.keys.map((entry, index) =>
                index === selected ? { ...entry, name } : entry,
              ),
            }),
        },
        ...variableDefaultPropertyRows(
          pickerTypeId,
          key.defaultValue,
          (value) =>
            commit({
              ...doc,
              keys: doc.keys.map((entry, index) =>
                index === selected ? { ...entry, defaultValue: value } : entry,
              ),
            }),
          {
            typeClassId,
            schemas: typeSchemas,
            enumMembers,
          },
        ),
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1" data-testid="blackboard-editor">
      <PanelFrame className="w-72 shrink-0 border-r border-border" title="Keys">
        <div className="flex flex-col gap-1 p-2">
          {doc.keys.map((entry, index) => (
            <Button
              key={`${entry.name}-${index}`}
              type="button"
              variant="outline"
              className="min-h-11 w-full justify-start"
              aria-pressed={selected === index}
              data-testid={`blackboard-key-${entry.name}`}
              onClick={() => setSelected(index)}
            >
              {entry.name}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-fit"
            data-testid="blackboard-add-key"
            onClick={() => {
              const next: BlackboardKey = {
                name: uniqueKeyName(doc.keys),
                type: pinTypeForMember("bool"),
                defaultValue: false,
              };
              commit({ ...doc, keys: [...doc.keys, next] });
              setSelected(doc.keys.length);
            }}
          >
            Add Key
          </Button>
        </div>
      </PanelFrame>
      <PanelFrame className="flex-1" title="Details">
        {key ? (
          <div className="flex flex-col gap-3 p-2" data-testid="blackboard-details">
            <PropertyGrid rows={rows} />
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">Type</div>
              <PinTypePicker
                value={pickerTypeId}
                onChange={(typeId) =>
                  commit({
                    ...doc,
                    keys: doc.keys.map((entry, index) =>
                      index === selected
                        ? {
                            ...entry,
                            type: pinTypeForMember(
                              typeId,
                              keepsTypeClassId(typeId) ? typeClassId : undefined,
                            ),
                            defaultValue: defaultValueForMember(
                              typeId,
                              keepsTypeClassId(typeId) ? typeClassId : undefined,
                              typeSchemas,
                            ),
                          }
                        : entry,
                    ),
                  })
                }
                data-testid="blackboard-key-type"
              />
            </div>
            {isStruct || isEnum ? (
              <div className="flex flex-col gap-1">
                <div className="text-sm font-medium">
                  {isEnum ? "Enum Type" : "Structure Type"}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start"
                  data-testid="blackboard-key-type-asset"
                  onClick={() => setTypeAssetPickerOpen(true)}
                >
                  {selectedPickerIdentity(
                    typeAssetIdentity,
                    typeClassId || "Pick type",
                  )}
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-fit"
              data-testid="blackboard-delete-key"
              onClick={() => {
                const keys = doc.keys.filter((_, index) => index !== selected);
                commit({ ...doc, keys });
                setSelected(Math.max(0, selected - 1));
              }}
            >
              Delete Key
            </Button>
            <AssetPicker
              open={typeAssetPickerOpen}
              onOpenChange={setTypeAssetPickerOpen}
              assets={typeAssets}
              allowedTypes={isEnum ? ["Enum"] : ["Structure"]}
              allowNone
              title={isEnum ? "Pick Enum Type" : "Pick Structure Type"}
              onPick={(guid) => {
                commit({
                  ...doc,
                  keys: doc.keys.map((entry, index) =>
                    index === selected
                      ? {
                          ...entry,
                          type: pinTypeForMember(pickerTypeId, guid ?? undefined),
                          defaultValue: defaultValueForMember(
                            pickerTypeId,
                            guid ?? undefined,
                            typeSchemas,
                          ),
                        }
                      : entry,
                  ),
                });
                setTypeAssetPickerOpen(false);
              }}
              data-testid="blackboard-key-type-asset-picker"
            />
          </div>
        ) : (
          <p className="p-3 text-sm text-muted-foreground">Select a key</p>
        )}
      </PanelFrame>
    </div>
  );
}
