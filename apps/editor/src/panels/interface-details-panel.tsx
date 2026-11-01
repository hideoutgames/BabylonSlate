import { useMemo } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  CLASS_PIN_PICKER_TYPES,
  PanelFrame,
  PinListEditor,
  PropertyGrid,
  type PinListRow,
} from "@haptic/editor-kit";
import {
  useDocumentActions,
  useRegistryState,
  useOpenDocument,
} from "../context/document-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useTypeAssetEditing } from "../context/type-asset-editing-context";
import { patchScriptInterfaceMethod } from "../lib/asset-settings";
import { subclassClassEntries } from "../lib/component-property-rows";
import {
  collectClassGraphsForPalette,
  collectGraphTypeAssets,
  typeAssetPickerEntries,
} from "../lib/logic-graph-document";
import { delegateSignatureEntries } from "../lib/delegate-signatures";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  asScriptInterfaceAsset,
  parseMemberIndex,
  pinKey,
} from "../lib/type-asset-payload";

/** Open Structure, Enum and Data Definition tabs override their saved types. */
const TYPE_KINDS = ["structure", "enum", "data-definition"] as const;
const CLASS_KINDS = ["graph"] as const;

export function InterfaceDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const typeDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const { selectedMemberId, selectedPinId, setSelectedPinId } =
    useTypeAssetEditing();
  const doc = useOpenDocument(documentId);
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
      ...(pin.typeClassId ? { typeClassId: pin.typeClassId } : {}),
      ...(pin.typeId === "delegate" ? { signature: (pin.signature ?? []) as PinListRow["signature"] } : {}),
    }));
  }, [method, selectedIndex]);
  // Event Dispatchers of every Class, for a Delegate pin's Signature.
  const delegateSignatures = useMemo(() => {
    void registryEpoch;
    return delegateSignatureEntries(collectClassGraphsForPalette({
      assets: assetRegistry?.list() ?? [],
      openDocuments: classDocuments,
      classIdForPath: classIdForGraphPath,
    }));
  }, [assetRegistry, classDocuments, registryEpoch]);

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
          showOptional={false}
          showDefault={false}
          types={CLASS_PIN_PICKER_TYPES}
          delegateSignatures={delegateSignatures}
          classEntries={subclassClassEntries(
            "Object",
            assetRegistry?.list() ?? [],
          )}
          typeAssets={typeAssetPickerEntries(
            collectGraphTypeAssets({
              assets: assetRegistry?.list() ?? [],
              openDocuments: typeDocuments,
            }),
          )}
          onChange={(nextRows) => {
            const pins = nextRows.map((row) => ({
              name: row.name,
              typeId: String(row.type),
              direction: row.direction === "out" ? ("out" as const) : ("in" as const),
              ...(row.typeClassId?.trim()
                ? { typeClassId: row.typeClassId.trim() }
                : {}),
              ...(row.type === "delegate" ? { signature: [...(row.signature ?? [])] } : {}),
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
