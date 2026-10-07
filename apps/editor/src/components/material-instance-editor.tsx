import { useCallback, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  PropertySectionTitle,
  assetRowIdentity,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { FieldDescription } from "@babylonslate/ui/components/field";
import {
  normalizeMaterialInstanceDocument,
  parseMaterialDomain,
  type MaterialInstanceDocument,
} from "@babylonslate/shader-graph";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useMaterialEditing } from "../context/material-editing-context";
import { isMaterialSamplerTextureAsset } from "../lib/content-browser-helpers";
import {
  materialInstanceParameterRows,
  setMaterialInstanceOverride,
  unusedMaterialInstanceOverrides,
} from "../lib/material-instance-rows";
import { MaterialPreviewSurface } from "./material-editor";

function useMaterialInstanceDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const document = useMemo(
    () => normalizeMaterialInstanceDocument(doc?.content ?? {}),
    [doc?.content],
  );
  const commit = useCallback(
    (next: MaterialInstanceDocument, mergeKey?: string) => {
      void applyAssetDocumentChange(documentId, next as unknown as Record<string, unknown>, mergeKey);
    },
    [applyAssetDocumentChange, documentId],
  );
  return { document, commit, path: doc?.ref.path };
}

export function MaterialInstancePreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, commit } = useMaterialInstanceDocument();
  const editing = useMaterialEditing();
  return (
    <PanelFrame className="flex-1" data-testid="material-instance-preview-panel">
      <MaterialPreviewSurface
        preview={document.preview}
        domain={editing.previewDomain}
        onPreviewChange={(preview) => commit({ ...document, preview })}
      />
    </PanelFrame>
  );
}

/** Parent Material plus one row per parameter; editing a value overrides it. */
export function MaterialInstanceDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, commit, path } = useMaterialInstanceDocument();
  const { assetRegistry } = useRegistryState();
  const { instance } = useMaterialEditing();
  const [pickParent, setPickParent] = useState(false);
  const [pickTexture, setPickTexture] = useState<string | null>(null);
  const assets = assetRegistry?.list() ?? [];
  const parent = assets.find((asset) => asset.header.guid === document.parentGuid);
  const parentIdentity = parent
    ? assetRowIdentity({ name: parent.header.name, type: parent.header.type })
    : {};
  const parameters = instance?.parameters ?? [];
  const unused = unusedMaterialInstanceOverrides(document, parameters);
  const textureIdentity = (guid: string) => {
    const header = assetRegistry?.getByGuid(guid)?.header;
    return assetRowIdentity(header ? { name: header.name, type: header.type } : { name: guid, type: "Texture" });
  };

  return (
    <PanelFrame data-testid="material-instance-details-panel">
      <div className="flex flex-col">
        <PropertyGrid
          rows={[{
            id: "parentGuid",
            kind: "asset",
            label: "Parent",
            value: document.parentGuid,
            placeholder: "None",
            description: "A Material or another Material Instance. The shader is compiled once for the root Material.",
            ...parentIdentity,
            onPick: () => setPickParent(true),
            onChange: (parentGuid) => commit({ ...document, parentGuid }),
          }]}
        />
        <PropertySectionTitle>Parameters</PropertySectionTitle>
        {instance?.status === "ready" && parameters.length > 0 ? (
          <PropertyGrid
            rows={materialInstanceParameterRows(document, parameters, {
              commit,
              textureIdentity,
              onPickTexture: setPickTexture,
            })}
            data-testid="material-instance-parameters"
          />
        ) : (
          <FieldDescription className="px-2 py-1" data-testid="material-instance-parameters-empty">
            {instance?.status === "error" ? instance.error
              : instance?.status === "ready" ? "The parent Material has no parameters. Add Float, Color, or Texture Parameters to it."
                : "Loading parent parameters…"}
          </FieldDescription>
        )}
        {unused.length > 0 && instance?.status === "ready" ? (
          <div className="flex items-center gap-2 px-2 py-1">
            <FieldDescription className="min-w-0 flex-1">
              {`Unused overrides: ${unused.join(", ")}`}
            </FieldDescription>
            <Button
              size="sm"
              variant="outline"
              onClick={() => commit({
                ...document,
                overrides: Object.fromEntries(Object.entries(document.overrides).filter(([name]) => !unused.includes(name))),
              })}
              data-testid="material-instance-remove-unused"
            >
              Remove Unused
            </Button>
          </div>
        ) : null}
      </div>
      <AssetPicker
        open={pickParent}
        onOpenChange={setPickParent}
        assets={assets
          .filter((asset) => (asset.header.type === "Material" || asset.header.type === "MaterialInstance") && asset.path !== path)
          .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))}
        allowedTypes={["Material", "MaterialInstance"]}
        title="Pick Parent Material"
        allowNone
        onPick={(parentGuid) => {
          const picked = parentGuid ? assetRegistry?.getByGuid(parentGuid)?.header : undefined;
          commit({
            ...document,
            parentGuid,
            domain: picked ? parseMaterialDomain(picked.payload?.domain) : document.domain,
          });
          setPickParent(false);
        }}
        data-testid="material-instance-parent-picker"
      />
      <AssetPicker
        open={pickTexture !== null}
        onOpenChange={(open) => { if (!open) setPickTexture(null); }}
        assets={assets
          .filter((asset) => isMaterialSamplerTextureAsset(asset.header))
          .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))}
        title="Pick Texture"
        allowNone
        onPick={(textureAssetGuid) => {
          const name = pickTexture;
          const parameter = parameters.find((entry) => entry.name === name);
          setPickTexture(null);
          if (!name || !parameter) return;
          commit(setMaterialInstanceOverride(document, name, { kind: "texture", textureAssetGuid }, parameter.inherited));
        }}
        data-testid="material-instance-texture-picker"
      />
    </PanelFrame>
  );
}
