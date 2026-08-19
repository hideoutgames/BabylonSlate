import {
  Field,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { PinTypePicker } from "./pin-type-picker";
import { ClassPicker, type ClassPickerEntry } from "./class-picker";
import { AssetPicker, type AssetPickerEntry } from "./asset-picker";
import { Button } from "@babylonslate/ui/components/button";
import {
  PickerIdentity,
  assetRowIdentity,
  classRowIdentity,
  selectedPickerIdentity,
} from "./picker-identity";
import { pinPickerKeepsTypeClassId } from "./pin-types";
import { useState } from "react";

export const VARIABLE_CONTAINERS = ["single", "array", "map"] as const;
export type VariableContainer = (typeof VARIABLE_CONTAINERS)[number];

export type VariableTypeFieldsValue = {
  typeId: string;
  typeClassId?: string;
  container: VariableContainer;
  keyTypeId?: string;
  keyTypeClassId?: string;
};

export type VariableTypeFieldsProps = {
  value: VariableTypeFieldsValue;
  onChange: (next: VariableTypeFieldsValue) => void;
  classEntries?: readonly ClassPickerEntry[];
  typeAssets?: readonly AssetPickerEntry[];
  "data-testid"?: string;
};

function needsClassType(typeId: string): boolean {
  return typeId === "object" || typeId === "actor" || typeId === "class";
}

function needsTypeAsset(typeId: string): boolean {
  return typeId === "struct" || typeId === "enum";
}

/** Type picker plus Single/Array/Map container (and Map key type). */
export function VariableTypeFields({
  value,
  onChange,
  classEntries = [],
  typeAssets = [],
  "data-testid": testId = "variable-type-fields",
}: VariableTypeFieldsProps) {
  const [keyClassOpen, setKeyClassOpen] = useState(false);
  const [keyAssetOpen, setKeyAssetOpen] = useState(false);
  const container = value.container === "array" || value.container === "map"
    ? value.container
    : "single";
  const keyTypeId = value.keyTypeId ?? "string";
  const keyClassId = value.keyTypeClassId?.trim() || (
    needsClassType(keyTypeId) ? "BObject" : ""
  );
  const keyAsset = typeAssets.find((asset) => asset.guid === keyClassId);

  const commit = (patch: Partial<VariableTypeFieldsValue>) => {
    const next: VariableTypeFieldsValue = { ...value, ...patch };
    next.container = patch.container ?? container;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <Field>
        <FieldLabel>Type</FieldLabel>
        <PinTypePicker
          value={value.typeId}
          onChange={(typeId) => {
            const keep = pinPickerKeepsTypeClassId(typeId);
            commit({
              typeId,
              typeClassId: keep ? value.typeClassId : undefined,
            });
          }}
          data-testid="inspector-member-type"
        />
      </Field>
      <Field>
        <FieldLabel>Container</FieldLabel>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          value={[container]}
          onValueChange={(next) => {
            const picked = next[0];
            if (picked !== "single" && picked !== "array" && picked !== "map") {
              return;
            }
            commit({
              container: picked,
              keyTypeId: picked === "map" ? (value.keyTypeId ?? "string") : undefined,
              keyTypeClassId: picked === "map" ? value.keyTypeClassId : undefined,
            });
          }}
          aria-label="Container"
          data-testid="inspector-member-container"
        >
          <ToggleGroupItem value="single" data-testid="inspector-member-container-single">
            Single
          </ToggleGroupItem>
          <ToggleGroupItem value="array" data-testid="inspector-member-container-array">
            Array
          </ToggleGroupItem>
          <ToggleGroupItem value="map" data-testid="inspector-member-container-map">
            Map
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {container === "map" ? (
        <>
          <Field>
            <FieldLabel>Key Type</FieldLabel>
            <PinTypePicker
              value={keyTypeId}
              onChange={(nextKey) => {
                const keep = pinPickerKeepsTypeClassId(nextKey);
                commit({
                  keyTypeId: nextKey,
                  keyTypeClassId: keep ? value.keyTypeClassId : undefined,
                });
              }}
              data-testid="inspector-member-key-type"
            />
          </Field>
          {needsClassType(keyTypeId) ? (
            <Field>
              <FieldLabel>Key Class Type</FieldLabel>
              <Button
                type="button"
                variant="outline"
                className="h-auto w-full justify-start"
                data-testid="inspector-member-key-class-type"
                onClick={() => setKeyClassOpen(true)}
              >
                {selectedPickerIdentity(
                  classRowIdentity(
                    classEntries.find((entry) => entry.id === keyClassId),
                    keyClassId,
                  ),
                )}
              </Button>
            </Field>
          ) : null}
          {needsTypeAsset(keyTypeId) ? (
            <Field>
              <FieldLabel>
                {keyTypeId === "enum" ? "Key Enum Type" : "Key Structure Type"}
              </FieldLabel>
              <Button
                type="button"
                variant="outline"
                className="h-auto w-full justify-start"
                data-testid="inspector-member-key-type-asset"
                onClick={() => setKeyAssetOpen(true)}
              >
                {selectedPickerIdentity(
                  assetRowIdentity(
                    keyAsset
                      ? { name: keyAsset.name, type: keyAsset.type }
                      : keyClassId
                        ? {
                            name: keyClassId,
                            type: keyTypeId === "enum" ? "Enum" : "Structure",
                          }
                        : undefined,
                  ),
                  keyClassId || "Pick type",
                )}
              </Button>
            </Field>
          ) : null}
          <ClassPicker
            open={keyClassOpen}
            onOpenChange={setKeyClassOpen}
            classes={classEntries}
            allowNone={false}
            title="Pick Key Class Type"
            onPick={(classId) => {
              if (!classId) return;
              commit({ keyTypeClassId: classId });
              setKeyClassOpen(false);
            }}
            data-testid="inspector-member-key-class-picker"
          />
          <AssetPicker
            open={keyAssetOpen}
            onOpenChange={setKeyAssetOpen}
            assets={typeAssets}
            allowedTypes={keyTypeId === "enum" ? ["Enum"] : ["Structure"]}
            allowNone
            title={keyTypeId === "enum" ? "Pick Key Enum Type" : "Pick Key Structure Type"}
            onPick={(guid) => {
              commit({ keyTypeClassId: guid ?? undefined });
              setKeyAssetOpen(false);
            }}
            data-testid="inspector-member-key-type-asset-picker"
          />
        </>
      ) : null}
    </div>
  );
}
