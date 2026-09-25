import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { AssetPicker, PanelFrame, PropertyGrid, assetRowIdentity, humanizePropertyLabel, type PropertyRow } from "@babylonslate/editor-kit";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, type WaterDefinition } from "@babylonslate/core";
import { createMaterialPreviewPresenter, createParticlePreviewScene, createWaterMesh, setSceneWaterTime } from "@babylonslate/render";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalPlay } from "../context/play-context";

const controls = [
  ["opacity", 0, 1], ["roughness", 0.02, 1], ["reflectionStrength", 0, 2],
  ["depthColorDistance", 0.01, 1000], ["waveHeight", 0, 20], ["waveLength", 0.1, 1000],
  ["waveSpeed", 0, 20], ["waveDirection", -360, 360], ["rippleStrength", 0, 1],
  ["rippleScale", 0.1, 100], ["foamAmount", 0, 1], ["foamWidth", 0, 20], ["colorBands", 0, 12], ["density", 1, 20000],
] as const;

export function WaterDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyAssetDocumentChange, assetRegistry } = useDocuments();
  const [picking, setPicking] = useState(false);
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const water = normalizeWaterDefinition(doc?.content);
  const defaults = createDefaultWaterDefinition(water.style);
  const commit = (next: WaterDefinition) => { void applyAssetDocumentChange(documentId, normalizeWaterDefinition(next) as unknown as Record<string, unknown>); };
  const assets = (assetRegistry?.list() ?? []).filter((asset) => asset.header.type === "Material" && (!asset.header.payload?.domain || asset.header.payload.domain === "surface"));
  const selected = assets.find((asset) => asset.header.guid === water.materialGuid);
  const rows: PropertyRow[] = [
    { id: "water-style", kind: "enum", label: "Style", value: water.style, options: [{ value: "realistic", label: "Realistic" }, { value: "stylized", label: "Stylized" }], description: "Changes shading style. Your colors and wave settings are retained.", onChange: (style) => commit({ ...water, style: style === "stylized" ? "stylized" : "realistic" }) },
    ...(["shallowColor", "deepColor", "foamColor"] as const).map((key): PropertyRow => ({ id: `water-${key}`, kind: "color", label: humanizePropertyLabel(key), value: water[key], defaultValue: defaults[key], onChange: (value) => commit({ ...water, [key]: [value[0], value[1], value[2]] }) })),
    ...controls.map(([key, min, max]): PropertyRow => ({ id: `water-${key}`, kind: "number", label: humanizePropertyLabel(key), value: water[key], defaultValue: defaults[key], min, max, ...(key === "density" ? { description: "Kilograms per cubic metre. Fresh water is approximately 1000." } : {}), onChange: (value) => commit({ ...water, [key]: value }) })),
    { id: "water-material", kind: "asset", label: "Custom Material", value: water.materialGuid, placeholder: "Built-In Water", description: "Optional Surface Material. Wave displacement and buoyancy remain active.", ...(selected ? assetRowIdentity({ name: selected.header.name, type: selected.header.type }) : {}), onPick: () => setPicking(true), onChange: (materialGuid) => commit({ ...water, materialGuid }) },
  ];
  return <PanelFrame data-testid="water-details-panel"><div className="min-h-0 flex-1 overflow-auto p-2"><PropertyGrid rows={rows} /></div>
    <AssetPicker open={picking} onOpenChange={setPicking} allowedTypes={["Material"]} assets={assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))} onPick={(materialGuid) => { commit({ ...water, materialGuid }); setPicking(false); }} />
  </PanelFrame>;
}

export function WaterPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const play = useOptionalPlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(normalizeWaterDefinition(openDocuments.find((entry) => entry.id === documentId)?.content));
  useEffect(() => {
    const canvas = canvasRef.current, engine = play?.ensureSharedEngine();
    if (!canvas || !engine) return;
    const host = createParticlePreviewScene(engine, { skybox: true });
    const water = JSON.parse(key) as WaterDefinition;
    createWaterMesh(host.scene, "water-preview", normalizeWaterBody({ width: 24, length: 24, waveScale: 1, depth: 5 }), water);
    host.camera.radius = 28;
    host.camera.lowerRadiusLimit = 8;
    host.camera.upperRadiusLimit = 80;
    const presenter = createMaterialPreviewPresenter(host, canvas);
    let frame = 0;
    const start = performance.now();
    setError(null);
    const tick = (now: number) => {
      try {
        if (document.visibilityState !== "hidden" && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
          setSceneWaterTime(host.scene, (now - start) / 1000);
          presenter.present();
        }
        frame = requestAnimationFrame(tick);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Water preview could not render."); }
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); presenter.dispose(); host.dispose(); };
  }, [key, play]);
  return <PanelFrame data-testid="water-preview-panel">
    <canvas ref={canvasRef} className="min-h-0 h-full w-full touch-none" aria-label="Water Preview" data-testid="water-preview-canvas" />
    {error ? <Alert variant="destructive"><AlertTitle>Preview Failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
  </PanelFrame>;
}
