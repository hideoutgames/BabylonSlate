import type { IDockviewPanelProps } from "dockview-react";
import {
  PanelFrame,
  PinTypePicker,
  PropertyGrid,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useTypeAssetEditing } from "../context/type-asset-editing-context";
import { patchEnumMember, patchStructureField } from "../lib/asset-settings";
import {
  asEnumAsset,
  asStructureAsset,
  parseMemberIndex,
} from "../lib/type-asset-payload";

export function TypeDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const { selectedMemberId } = useTypeAssetEditing();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = (doc?.content ?? {}) as Record<string, unknown>;
  const kind = doc?.ref.kind;
  const selectedIndex = parseMemberIndex(selectedMemberId);

  const commit = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
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
          commit(patchEnumMember(asset, selectedIndex, { value })),
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
    const defaultText =
      field.defaultValue === undefined || field.defaultValue === null
        ? ""
        : String(field.defaultValue);
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
              {
                id: "default",
                kind: "text",
                label: "Default",
                value: defaultText,
                onChange: (value) =>
                  commit(
                    patchStructureField(asset, selectedIndex, {
                      defaultValue: value,
                    }),
                  ),
              },
            ]}
          />
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium">Type</div>
            <PinTypePicker
              value={field.typeId}
              onChange={(typeId) =>
                commit(patchStructureField(asset, selectedIndex, { typeId }))
              }
              data-testid="structure-field-type"
            />
          </div>
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
