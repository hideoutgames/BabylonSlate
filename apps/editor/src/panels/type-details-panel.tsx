import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  AssetPickerControl,
  PanelFrame,
  PinTypePicker,
  PropertyGrid,
  assetRowIdentity,
  selectedPickerIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { defaultValueForMember, keepsTypeClassId } from "@babylonslate/scripting";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useTypeAssetEditing } from "../context/type-asset-editing-context";
import { patchEnumMember, patchStructureField } from "../lib/asset-settings";
import {
  collectEnumMemberNames,
  variableAssetPickerAllowedTypes,
  variableDefaultPropertyRows,
} from "../lib/graph-inspector";
import {
  collectGraphTypeAssets,
  typeAssetPickerEntries,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";
import {
  asEnumAsset,
  asStructureAsset,
  parseMemberIndex,
} from "../lib/type-asset-payload";

export function TypeDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } = useDocuments();
  const { selectedMemberId } = useTypeAssetEditing();
  const [typeAssetPickerOpen, setTypeAssetPickerOpen] = useState(false);
  const [defaultAssetPickerOpen, setDefaultAssetPickerOpen] = useState(false);
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  const kind = doc?.ref.kind;
  const selectedIndex = parseMemberIndex(selectedMemberId);
  const typeCatalog = collectGraphTypeAssets({
    assets: assetRegistry?.list() ?? [],
    openDocuments,
  });
  const typeSchemas = typeSchemasFromGraphAssets(typeCatalog);
  const typeAssets = typeAssetPickerEntries(typeCatalog);
  const pickerAssets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const enumMembers = collectEnumMemberNames(
    openDocuments,
    assetRegistry?.list() ?? [],
  );

  /** `mergeKey` groups one scrub's edits into one undo entry. */
  const commit = (next: Record<string, unknown>, mergeKey?: string) => {
    void (mergeKey
      ? applyAssetDocumentChange(documentId, next, mergeKey)
      : applyAssetDocumentChange(documentId, next));
  };

  if (kind === "enum") {
    const asset = asEnumAsset(payload);
    const member =
      selectedIndex !== null ? asset.members[selectedIndex] : undefined;
    if (!member || selectedIndex === null) {
      return (
        <PanelFrame data-testid="enum-details-panel">
          <p className="p-3 text-sm text-muted-foreground">
            Select a member to edit details.
          </p>
        </PanelFrame>
      );
    }
    const rows: PropertyRow[] = [
      {
        id: "name",
        kind: "text",
        label: "Name",
        value: member.name,
        onChange: (value) =>
          commit(patchEnumMember(asset, selectedIndex, { name: value })),
      },
      {
        id: "value",
        kind: "number",
        label: "Value",
        value: member.value,
        onChange: (value) =>
          commit(
            patchEnumMember(asset, selectedIndex, { value }),
            `enum:member:${selectedIndex}:value`,
          ),
      },
    ];
    return (
      <PanelFrame data-testid="enum-details-panel">
        <div className="p-2">
          <PropertyGrid rows={rows} />
        </div>
      </PanelFrame>
    );
  }

  if (kind === "structure") {
    const asset = asStructureAsset(payload);
    const field =
      selectedIndex !== null ? asset.fields[selectedIndex] : undefined;
    if (!field || selectedIndex === null) {
      return (
        <PanelFrame data-testid="structure-details-panel">
          <p className="p-3 text-sm text-muted-foreground">
            Select a field to edit details.
          </p>
        </PanelFrame>
      );
    }
    const isStruct = field.typeId === "struct";
    const isEnum = field.typeId === "enum";
    const typeClassId = field.typeClassId?.trim() ?? "";
    const typeAsset = typeAssets.find((entry) => entry.guid === typeClassId);
    const typeAssetIdentity = assetRowIdentity(
      typeAsset
        ? { name: typeAsset.name, type: typeAsset.type }
        : typeClassId
          ? { name: typeClassId, type: isEnum ? "Enum" : "Record" }
          : undefined,
    );
    const defaultRows = variableDefaultPropertyRows(
      field.typeId,
      field.defaultValue,
      (value) =>
        commit(
          patchStructureField(asset, selectedIndex, { defaultValue: value }),
          // Default editors scrub numbers, vectors and colors continuously.
          `structure:field:${selectedIndex}:defaultValue`,
        ),
      {
        typeClassId: field.typeClassId,
        schemas: typeSchemas,
        enumMembers,
        assetEntries: pickerAssets.map((entry) => ({
          id: entry.guid,
          name: entry.name,
          type: entry.type,
        })),
        onPickAsset: () => setDefaultAssetPickerOpen(true),
      },
    );
    return (
      <PanelFrame data-testid="structure-details-panel">
        <div className="flex flex-col gap-3 p-2">
          <PropertyGrid
            rows={[
              {
                id: "name",
                kind: "text",
                label: "Name",
                value: field.name,
                onChange: (value) =>
                  commit(
                    patchStructureField(asset, selectedIndex, { name: value }),
                  ),
              },
            ]}
          />
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium">Type</div>
            <PinTypePicker
              labels={{ struct: "Structure / Data Definition" }}
              value={isStruct && typeClassId === "engine:TagContainer" ? "tagContainer" : field.typeId}
              onChange={(selectedType) => {
                const typeId = selectedType === "tagContainer" ? "struct" : selectedType;
                const keep = keepsTypeClassId(typeId);
                const nextTypeClassId = selectedType === "tagContainer"
                  ? "engine:TagContainer" : keep ? field.typeClassId : undefined;
                commit(
                  patchStructureField(asset, selectedIndex, {
                    typeId,
                    typeClassId: nextTypeClassId,
                    defaultValue: defaultValueForMember(
                      typeId,
                      nextTypeClassId,
                      typeSchemas,
                    ),
                  }),
                );
              }}
              data-testid="structure-field-type"
            />
          </div>
          {isStruct || isEnum ? (
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">
                {isEnum ? "Enum Type" : "Record Type"}
              </div>
              <AssetPickerControl value={typeClassId}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start"
                  data-testid="structure-field-type-asset"
                  onClick={() => setTypeAssetPickerOpen(true)}
                >
                  {selectedPickerIdentity(
                    typeAssetIdentity,
                    typeClassId || "Pick type",
                  )}
                </Button>
              </AssetPickerControl>
            </div>
          ) : null}
          {defaultRows.length > 0 ? <PropertyGrid rows={defaultRows} /> : null}
          <AssetPicker
            open={typeAssetPickerOpen}
            onOpenChange={setTypeAssetPickerOpen}
            assets={typeAssets}
            allowedTypes={isEnum ? ["Enum"] : ["Structure", "DataDefinition"]}
            allowNone
            title={isEnum ? "Pick Enum Type" : "Pick Record Type"}
            onPick={(guid) => {
              commit(
                patchStructureField(asset, selectedIndex, {
                  typeClassId: guid ?? undefined,
                  defaultValue: defaultValueForMember(
                    field.typeId,
                    guid ?? undefined,
                    typeSchemas,
                  ),
                }),
              );
              setTypeAssetPickerOpen(false);
            }}
            data-testid="structure-field-type-asset-picker"
          />
          <AssetPicker
            open={defaultAssetPickerOpen}
            onOpenChange={setDefaultAssetPickerOpen}
            assets={pickerAssets}
            allowedTypes={variableAssetPickerAllowedTypes(field.typeClassId)}
            allowNone
            title="Pick Asset"
            onPick={(guid) => {
              commit(
                patchStructureField(asset, selectedIndex, {
                  defaultValue: guid ?? "",
                }),
              );
              setDefaultAssetPickerOpen(false);
            }}
            data-testid="structure-field-default-asset-picker"
          />
        </div>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame data-testid="type-details-panel">
      <p className="p-3 text-sm text-muted-foreground">Select a member.</p>
    </PanelFrame>
  );
}
