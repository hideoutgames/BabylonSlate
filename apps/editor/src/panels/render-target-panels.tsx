import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { normalizeRenderTargetPayload, normalizeRenderTargetTexturePayload, RENDER_TARGET_MODES, RENDER_TARGET_MODE_LABELS } from "@babylonslate/core";
import { AssetPicker, PanelFrame, PropertyGrid, assetRowIdentity, type PropertyRow } from "@babylonslate/editor-kit";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

export function RenderTargetDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange } = useDocuments();
  const target = normalizeRenderTargetPayload(openDocuments.find((entry) => entry.id === documentId)?.content);
  const commit = (patch: Record<string, unknown>) => {
    void applyAssetDocumentChange(documentId, { ...normalizeRenderTargetPayload({ ...target, ...patch }) });
  };
  const rows: PropertyRow[] = [
    {
      id: "render-target-mode", kind: "enum", label: "Render Mode", value: target.mode,
      options: RENDER_TARGET_MODES.map((mode) => ({ value: mode, label: RENDER_TARGET_MODE_LABELS[mode] })),
      description: "Captures only the selected pass. Depth Pass and World Normal skip scene lighting and post processing.",
      onChange: (mode) => commit({ mode }),
    },
    ...(["width", "height"] as const).map((key): PropertyRow => ({
      id: `render-target-${key}`, kind: "number", label: key === "width" ? "Width" : "Height", value: target[key],
      min: 1, max: 4096, step: 1, defaultValue: 512, unit: "px", onChange: (value) => commit({ [key]: value }),
    })),
  ];
  return <PanelFrame data-testid="render-target-details-panel"><div className="min-h-0 flex-1 overflow-auto p-2"><PropertyGrid rows={rows} /></div></PanelFrame>;
}

export function RenderTargetTextureDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } = useDocuments();
  const [picking, setPicking] = useState(false);
  const texture = normalizeRenderTargetTexturePayload(openDocuments.find((entry) => entry.id === documentId)?.content);
  const assets = (assetRegistry?.list() ?? []).filter((entry) => entry.header.type === "RenderTarget");
  const selected = assets.find((entry) => entry.header.guid === texture.renderTargetGuid);
  const commit = (renderTargetGuid: string | null) => {
    void applyAssetDocumentChange(documentId, { ...texture, renderTargetGuid });
  };
  return <PanelFrame data-testid="render-target-texture-details-panel">
    <div className="min-h-0 flex-1 overflow-auto p-2"><PropertyGrid rows={[{
      id: "render-target-texture-target", kind: "asset", label: "Render Target", value: texture.renderTargetGuid,
      description: "Sample this asset in a Material Texture Sample or Texture Parameter. A Render Target Capture actor produces its contents.",
      ...(selected ? assetRowIdentity({ name: selected.header.name, type: selected.header.type }) : {}),
      onPick: () => setPicking(true), onChange: commit,
    }]} /></div>
    <AssetPicker open={picking} onOpenChange={setPicking} allowedTypes={["RenderTarget"]} title="Pick Render Target" allowNone
      assets={assets.map((entry) => ({ guid: entry.header.guid, name: entry.header.name, type: entry.header.type, path: entry.path }))}
      onPick={(guid) => { commit(guid); setPicking(false); }} />
  </PanelFrame>;
}
