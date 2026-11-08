import type { IDockviewPanelProps } from "dockview-react";
import { resolveExtensionFieldValues } from "@haptic/assets";
import { PanelFrame, PropertySectionTitle } from "@haptic/editor-kit";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { useDocumentActions, useOpenDocument, useRegistryState } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { asRecord } from "../lib/as-record";
import { findExtensionAssetType } from "../lib/extension-asset-types";
import { ExtensionFieldList } from "./extension-fields";
import { useExtensionAssetTypes } from "./use-extension-asset-types";

/**
 * The Inspector of an asset whose type an extension declares: the type's
 * sections, editing the payload field by field. Without its enabled extension
 * the asset is left untouched.
 */
export function ExtensionAssetDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const doc = useOpenDocument(documentId);
  const headerType = doc ? assetRegistry?.getByPath(doc.ref.path)?.header.type ?? "" : "";
  const type = findExtensionAssetType(useExtensionAssetTypes(), headerType);
  if (!type) {
    return <PanelFrame data-testid="extension-asset-details-panel">
      <Empty data-testid="extension-asset-unavailable">
        <EmptyHeader>
          <EmptyTitle>Extension Unavailable</EmptyTitle>
          <EmptyDescription>Enable the extension that adds this asset type to edit it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PanelFrame>;
  }
  const values = resolveExtensionFieldValues(type.fields, asRecord(doc?.content));
  return <PanelFrame data-testid="extension-asset-details-panel">
    <div className="flex min-w-0 flex-col">
      {type.sections.map((section) => <section key={section.id} className="flex min-w-0 flex-col" aria-label={section.title}>
        <PropertySectionTitle>{section.title}</PropertySectionTitle>
        <div className="flex min-w-0 flex-col gap-2 p-2">
          <ExtensionFieldList
            fields={section.fields}
            values={values}
            idPrefix={`extension-asset-${type.id}`}
            onChange={(fieldId, value) => void applyAssetDocumentChange(documentId, { ...values, [fieldId]: value }, `extension-asset:${fieldId}`)}
          />
        </div>
      </section>)}
    </div>
  </PanelFrame>;
}
