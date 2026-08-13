import { useMemo } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  PanelFrame,
  PinListEditor,
  PropertyGrid,
  type PinListRow,
} from "@babylonslate/editor-kit";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useTypeAssetEditing } from "../context/type-asset-editing-context";
import { patchScriptInterfaceMethod } from "../lib/asset-settings";
import {
  asScriptInterfaceAsset,
  parseMemberIndex,
  pinKey,
} from "../lib/type-asset-payload";

export function InterfaceDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const { selectedMemberId, selectedPinId, setSelectedPinId } =
    useTypeAssetEditing();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const asset = asScriptInterfaceAsset(
    (doc?.content ?? {}) as Record<string, unknown>,
  );
  const selectedIndex = parseMemberIndex(selectedMemberId);
  const method =
    selectedIndex !== null ? asset.methods[selectedIndex] : undefined;

  const commit = (next: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, next);
  };

  const rows: PinListRow[] = useMemo(() => {
    if (!method || selectedIndex === null) return [];
    return method.pins.map((pin, pinIndex) => ({
      id: pinKey(selectedIndex, pinIndex),
      name: pin.name,
      type: pin.typeId,
      direction: pin.direction,
    }));
  }, [method, selectedIndex]);

  if (!method || selectedIndex === null) {
    return (
      <PanelFrame data-testid="interface-details-panel">
        <p className="p-3 text-sm text-muted-foreground">
          Select a method to edit pins.
        </p>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame data-testid="interface-details-panel">
      <div className="flex flex-col gap-3 p-2">
        <PropertyGrid
          rows={[
            {
              id: "method-name",
              kind: "text",
              label: "Name",
              value: method.name,
              onChange: (value) =>
                commit(
                  patchScriptInterfaceMethod(asset, selectedIndex, {
                    name: value,
                  }),
                ),
            },
          ]}
        />
        <PinListEditor
          title="Pins"
          rows={rows}
          selectedId={selectedPinId}
          onSelect={setSelectedPinId}
          showDirection
          onChange={(nextRows) => {
            const pins = nextRows.map((row) => ({
              name: row.name,
              typeId: String(row.type),
              direction: row.direction === "out" ? ("out" as const) : ("in" as const),
            }));
            commit(
              patchScriptInterfaceMethod(asset, selectedIndex, { pins }),
            );
          }}
        />
      </div>
    </PanelFrame>
  );
}
