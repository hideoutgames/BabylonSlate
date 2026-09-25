import { useEffect, useRef, useState } from "react";
import { DirectionalLight, Vector3 } from "@babylonjs/core";
import type { IDockviewPanelProps } from "dockview-react";
import { AssetPicker, PanelFrame, PropertyGrid, assetRowIdentity, humanizePropertyLabel, type PropertyRow } from "@babylonslate/editor-kit";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, type WaterDefinition } from "@babylonslate/core";
import { createMaterialPreviewPresenter, createParticlePreviewScene, createWaterMesh, setSceneWaterTime, MaterialLibrary, installTextureBytes, acquireMaterialTexture, resourceCacheForEngine } from "@babylonslate/render";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalPlay } from "../context/play-context";

const controls = [
  ["opacity", 0, 1], ["roughness", 0.02, 1], ["reflectionStrength", 0, 2],
  ["depthColorDistance", 0.01, 1000], ["waveHeight", 0, 20], ["waveLength", 0.1, 1000],
  ["waveSpeed", 0, 20], ["waveDirection", -360, 360], ["rippleStrength", 0, 1],
  ["rippleScale", 0.1, 100], ["foamAmount", 0, 1], ["foamWidth", 0, 20], ["colorBands", 0, 12], ["sparkles", 0, 1], ["density", 1, 20000],
] as const;
const descriptions: Partial<Record<(typeof controls)[number][0], string>> = {
  opacity: "Maximum opacity of deep water. Shallow water near banks stays clearer.",
  depthColorDistance: "Metres of water that absorb most light. Smaller values look deeper and darker sooner.",
  rippleScale: "Higher values make smaller wind ripples.",
  foamWidth: "Metres of shoreline foam measured from the bank.",
  colorBands: "Stylized depth bands. Zero or one keeps a smooth gradient.",
  sparkles: "Twinkling sun glints on the surface.",
  density: "Kilograms per cubic metre. Fresh water is approximately 1000.",
};

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
    ...controls.map(([key, min, max]): PropertyRow => ({ id: `water-${key}`, kind: "number", label: humanizePropertyLabel(key), value: water[key], defaultValue: defaults[key], min, max, ...(descriptions[key] ? { description: descriptions[key] } : {}), onChange: (value) => commit({ ...water, [key]: value }) })),
    { id: "water-material", kind: "asset", label: "Custom Material", value: water.materialGuid, placeholder: "Built-In Water", description: "Optional Surface Material. Wave displacement and buoyancy remain active.", ...(selected ? assetRowIdentity({ name: selected.header.name, type: selected.header.type }) : {}), onPick: () => setPicking(true), onChange: (materialGuid) => commit({ ...water, materialGuid }) },
  ];
  return <PanelFrame data-testid="water-details-panel"><div className="min-h-0 flex-1 overflow-auto p-2"><PropertyGrid rows={rows} /></div>
    <AssetPicker open={picking} onOpenChange={setPicking} allowedTypes={["Material"]} assets={assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))} onPick={(materialGuid) => { commit({ ...water, materialGuid }); setPicking(false); }} />
  </PanelFrame>;
}

export function WaterPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, collectPlayMaterialLibrary, collectPlayTextureBytes } = useDocuments();
  const play = useOptionalPlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(normalizeWaterDefinition(openDocuments.find((entry) => entry.id === documentId)?.content));
  useEffect(() => {
    const canvas = canvasRef.current, engine = play?.ensureSharedEngine();
    if (!canvas || !engine) return;
    const host = createParticlePreviewScene(engine, { skybox: true });
    const sun = new DirectionalLight("water-preview-sun", new Vector3(-0.3, -1, 0.6), host.scene);
    sun.intensity = 1.4;
    const water = JSON.parse(key) as WaterDefinition;
    host.camera.radius = 28;
    host.camera.lowerRadiusLimit = 8;
    host.camera.upperRadiusLimit = 80;
    const presenter = createMaterialPreviewPresenter(host, canvas, { onError: setError });
    let materials: MaterialLibrary | null = null;
    let cancelled = false;
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
    void (async () => {
      let customMaterial = null;
      if (water.materialGuid) {
        const library = await collectPlayMaterialLibrary(undefined, [], [water.materialGuid]);
        const bytes = await collectPlayTextureBytes(new Map(), new Map(), library.textureGuids);
        if (cancelled) return;
        const sources = installTextureBytes(bytes);
        const cache = resourceCacheForEngine(engine);
        materials = new MaterialLibrary({
          functions: () => Object.fromEntries(library.functions),
          acquireTexture: (guid) => {
            const source = sources?.get(guid);
            return source ? acquireMaterialTexture(cache, guid, engine, source, { hasAlpha: true }) : null;
          },
        });
        const document = library.documents.get(water.materialGuid);
        if (!document) throw new Error("The selected Water material is unavailable.");
        const acquired = materials.acquire(host.scene, water.materialGuid, document);
        if (acquired.ok === false) throw new Error(acquired.diagnostics.map((entry) => entry.message).join("\n"));
        const diagnostics = await acquired.ready;
        if (cancelled) return;
        if (diagnostics.length) throw new Error(diagnostics.map((entry) => entry.message).join("\n"));
        customMaterial = acquired.material;
      }
      if (cancelled) return;
      createWaterMesh(host.scene, "water-preview", normalizeWaterBody({ width: 24, length: 24, waveScale: 1, depth: 5 }), water, customMaterial);
      frame = requestAnimationFrame(tick);
    })().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Water preview could not load."); });
    return () => { cancelled = true; cancelAnimationFrame(frame); presenter.dispose(); host.dispose(); materials?.dispose(); };
  }, [key, play, collectPlayMaterialLibrary, collectPlayTextureBytes]);
  return <PanelFrame data-testid="water-preview-panel">
    <canvas ref={canvasRef} className="min-h-0 h-full w-full touch-none" aria-label="Water Preview" data-testid="water-preview-canvas" />
    {error ? <Alert variant="destructive"><AlertTitle>Preview Failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
  </PanelFrame>;
}
