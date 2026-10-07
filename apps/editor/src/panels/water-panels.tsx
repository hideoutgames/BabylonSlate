import { useEffect, useMemo, useRef, useState } from "react";
import { DirectionalLight, Vector3, type AbstractEngine, type Mesh, type Scene } from "@babylonjs/core";
import type { IDockviewPanelProps } from "dockview-react";
import { AssetPicker, PanelFrame, PropertyGrid, assetRowIdentity, humanizePropertyLabel, type PropertyRow } from "@babylonslate/editor-kit";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, type RenderProjectSettings, type WaterDefinition } from "@babylonslate/core";
import {
  createMaterialPreviewPresenter, createParticlePreviewScene, createWaterMesh, setSceneRenderSettings, setSceneWaterTime, updateWaterMeshDefinition,
  MaterialLibrary, installTextureBytes, acquireMaterialTexture, resourceCacheForEngine, type RenderShadingSettings,
} from "@babylonslate/render";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useOpenDocument,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalPlay } from "../context/play-context";
import { isMaterialAssetType } from "../lib/content-browser-helpers";
import { materialClosureRevision } from "../lib/material-closure-revision";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

/** Open tabs whose unsaved content a Custom Material's library load reads. */
const MATERIAL_CLOSURE_KINDS = ["material", "material-instance", "material-function"] as const;

type NumberKey = { [K in keyof WaterDefinition]: WaterDefinition[K] extends number ? K : never }[keyof WaterDefinition];
type NumberControl = readonly [key: NumberKey, min: number, max: number];
/** Numeric rows in Details order: look (then Object Reflections), waves (after Wave Model), then surface detail. */
const lookControls = [
  ["opacity", 0, 1], ["roughness", 0.02, 1], ["reflectionStrength", 0, 2], ["refraction", 0, 1], ["colorVariation", 0, 1],
  ["depthColorDistance", 0.01, 1000],
] as const satisfies readonly NumberControl[];
const waveControls = [
  ["waveHeight", 0, 20], ["waveLength", 0.1, 1000], ["waveSpeed", 0, 20], ["waveDirection", -360, 360], ["choppiness", 0, 1],
  ["steepness", 0, 1], ["waveSpread", 0, 1], ["peakSharpness", 1, 7], ["waveSeed", 0, 65535], ["detailWaves", 0, 1],
] as const satisfies readonly NumberControl[];
const surfaceControls = [
  ["rippleStrength", 0, 1], ["rippleScale", 0.1, 100], ["foamAmount", 0, 1], ["foamWidth", 0, 20], ["crestFoam", 0, 1], ["surfaceFoam", 0, 1],
  ["contactFoamWidth", 0, 8], ["subsurface", 0, 2], ["colorBands", 0, 12], ["sparkles", 0, 1], ["density", 1, 20000],
] as const satisfies readonly NumberControl[];
/** Ocean Spectrum inputs; Classic ignores them. */
const oceanOnly = new Set<NumberKey>(["peakSharpness", "waveSeed"]);
const descriptions: Partial<Record<NumberKey, string>> = {
  opacity: "Maximum opacity of deep water. Shallow water near banks stays clearer.",
  roughness: "Realistic: how far the sun glint and sky reflection spread. Stylized: width of the sun's streak and sparkle path.",
  reflectionStrength: "Realistic: strength of the sky reflection. Stylized Painted: strength of the soft painted sky reflection, strongest at grazing views. Stylized Toon: strength of object reflections only.",
  depthColorDistance: "Metres of water that absorb most light. Smaller values look deeper and darker sooner.",
  rippleScale: "Higher values make smaller wind ripples.",
  choppiness: "0 gives rounded swell; 1 gives sharp crests and flat troughs. Floating objects follow the same shape.",
  steepness: "Gerstner motion: water also moves back and forth, gathering under sharper crests. 0 moves it only up and down. The motion fades out toward the banks of finite water, so edges stay put. Floating objects and Sample Water Surface follow it.",
  peakSharpness: "Ocean Spectrum only: how tightly wave energy gathers around Wave Length (JONSWAP peak). Higher values give a more regular swell. Affects physics.",
  waveSeed: "Ocean Spectrum only: picks another repeatable arrangement of the same sea. Affects physics.",
  detailWaves: "Render only: strength of the fine FFT wave detail above the swell, for either Wave Model, drawn when the FFT Ocean Detail quality setting is on. Buoyancy and queries ignore it.",
  refraction: "Render only: how strongly the water bends the view of objects below it. 0 never samples the scene; needs the Water Refraction quality setting. Visible in scene viewports and Play, not in this preview.",
  colorVariation: "Render only: slow tint variation across open water.",
  waveSpread: "How far wave headings fan out from Wave Direction: 0 is one swell, 1 is a confused sea.",
  foamWidth: "Metres of shoreline foam measured from the bank or terrain shoreline.",
  crestFoam: "Whitecap coverage on the steepest, sharpest crests. Gentle swell and small lake waves stay clear.",
  surfaceFoam: "Open-water foam: wind streaks on Realistic water, drifting foam patches on Stylized water.",
  subsurface: "Sunlight glowing green through wave crests seen toward the sun; Stylized also lightens wave tops. Stylized's glow needs Medium Water Shading Detail or higher.",
  contactFoamWidth: "Metres of foam around objects and terrain that cross the surface.",
  colorBands: "Stylized depth bands. Zero or one keeps a smooth gradient.",
  sparkles: "Twinkling sun glints on the surface. Stylized: soft sparkles around the sun's path.",
  density: "Kilograms per cubic metre. Fresh water is approximately 1000.",
};

export function WaterDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const [picking, setPicking] = useState(false);
  const doc = useOpenDocument(documentId);
  const water = normalizeWaterDefinition(doc?.content);
  const defaults = createDefaultWaterDefinition(water.style, water.stylizedLook);
  /** `field` names the per-field merge key: one scrub or color drag is one undo step. */
  const commit = (next: WaterDefinition, field?: string) => { void applyAssetDocumentChange(documentId, normalizeWaterDefinition(next) as unknown as Record<string, unknown>, field ? `water:${field}` : undefined); };
  // Surface Materials change with the registry, not with edits of this Water.
  const assets = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).filter((asset) => isMaterialAssetType(asset.header.type) && (!asset.header.payload?.domain || asset.header.payload.domain === "surface"));
  }, [assetRegistry, registryEpoch]);
  const pickerAssets = useMemo(() => assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path })), [assets]);
  const selected = assets.find((asset) => asset.header.guid === water.materialGuid);
  const numberRow = ([key, min, max]: NumberControl): PropertyRow => ({
    id: `water-${key}`, kind: "number", label: humanizePropertyLabel(key), value: water[key], defaultValue: defaults[key], min, max,
    ...(key === "waveSeed" ? { precision: 0 } : {}), ...(oceanOnly.has(key) && water.waveModel !== "ocean" ? { disabled: true } : {}),
    ...(descriptions[key] ? { description: descriptions[key] } : {}), onChange: (value) => commit({ ...water, [key]: value }, key),
  });
  const stylizedLookRow: PropertyRow = {
    id: "water-stylizedLook", kind: "enum", label: "Stylized Look", value: water.stylizedLook,
    options: [{ value: "painted", label: "Painted" }, { value: "toon", label: "Toon" }],
    description: "Painted is soft, lit-looking water with a painted sky reflection. Toon is flat color bands with white line work and opaque foam. Your colors and wave settings are retained.",
    onChange: (look) => commit({ ...water, stylizedLook: look === "toon" ? "toon" : "painted" }),
  };
  const rows: PropertyRow[] = [
    { id: "water-style", kind: "enum", label: "Style", value: water.style, options: [{ value: "realistic", label: "Realistic" }, { value: "stylized", label: "Stylized" }], description: "Changes shading style. Your colors and wave settings are retained.", onChange: (style) => commit({ ...water, style: style === "stylized" ? "stylized" : "realistic" }) },
    // Stylized only; Realistic keeps the stored look for a later switch back.
    ...(water.style === "stylized" ? [stylizedLookRow] : []),
    ...(["shallowColor", "deepColor", "foamColor"] as const).map((key): PropertyRow => ({ id: `water-${key}`, kind: "color", label: humanizePropertyLabel(key), value: water[key], defaultValue: defaults[key], onChange: (value) => commit({ ...water, [key]: [value[0], value[1], value[2]] }, key) })),
    ...lookControls.map(numberRow),
    { id: "water-objectReflections", kind: "boolean", label: "Object Reflections", value: water.objectReflections, defaultValue: defaults.objectReflections, description: "Render only: also reflect scene objects (screen-space or planar, per the Water Reflections quality setting). Off reflects only the sky. Visible in scene viewports and Play, not in this preview.", onChange: (objectReflections) => commit({ ...water, objectReflections }) },
    { id: "water-waveModel", kind: "enum", label: "Wave Model", value: water.waveModel, defaultValue: defaults.waveModel, options: [{ value: "classic", label: "Classic" }, { value: "ocean", label: "Ocean Spectrum" }], description: "Classic is eight fixed swell waves spread around Wave Length. Ocean Spectrum draws eight waves from a sea spectrum peaking at Wave Length, with the same overall height. Affects physics.", onChange: (waveModel) => commit({ ...water, waveModel: waveModel === "ocean" ? "ocean" : "classic" }) },
    ...waveControls.map(numberRow),
    ...surfaceControls.map(numberRow),
    { id: "water-material", kind: "asset", label: "Custom Material", value: water.materialGuid, placeholder: "Built-In Water", description: "Optional Surface Material. Wave displacement and buoyancy remain active.", ...(selected ? assetRowIdentity({ name: selected.header.name, type: selected.header.type }) : {}), onPick: () => setPicking(true), onChange: (materialGuid) => commit({ ...water, materialGuid }) },
  ];
  return <PanelFrame data-testid="water-details-panel"><div className="min-h-0 flex-1 overflow-auto p-2"><PropertyGrid rows={rows} /></div>
    <AssetPicker open={picking} onOpenChange={setPicking} allowedTypes={["Material", "MaterialInstance"]} assets={pickerAssets} onPick={(materialGuid) => { commit({ ...water, materialGuid }); setPicking(false); }} />
  </PanelFrame>;
}

/** The preview draws without a post-process chain, so Scene Linear effects must not move display output there. */
function previewRenderSettings(render: RenderProjectSettings | undefined): RenderShadingSettings {
  if (!render) return {};
  const { effects: _effects, ...settings } = render;
  void _effects;
  return settings;
}

/** A finite Lake: its layout depends only on the body, never on the orbiting preview camera. */
const PREVIEW_BODY = { width: 24, length: 24, waveScale: 1, depth: 5 };

/**
 * Live preview of the open Water asset. The scene and mesh are built once per engine, Style, Custom Material and
 * revision of everything that material reaches; other edits, such as each step of a Details scrub, apply to the
 * existing mesh, so the wave clock keeps running. Project render settings (Water quality included) also apply to the
 * existing scene.
 */
export function WaterPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { collectPlayMaterialLibrary, collectPlayTextureBytes } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { projectDocument } = useProjectState();
  const play = useOptionalPlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<AbstractEngine | null>(null);
  // The Play context changes identity on every document edit; only its shared engine matters here.
  useEffect(() => { setEngine(play?.ensureSharedEngine() ?? null); }, [play]);
  const definition = normalizeWaterDefinition(useOpenDocument(documentId)?.content);
  const definitionKey = JSON.stringify(definition);
  /** The latest definition, for a mesh whose Custom Material finishes loading after later edits. */
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const { style, materialGuid } = definition;
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_CLOSURE_KINDS);
  const closureKey = useMemo(() => {
    void registryEpoch; // Registry contents change without replacing its instance.
    return materialGuid ? materialClosureRevision(materialGuid, assetRegistry, materialDocuments) : "";
  }, [materialGuid, assetRegistry, registryEpoch, materialDocuments]);
  const loadersRef = useRef({ collectPlayMaterialLibrary, collectPlayTextureBytes });
  loadersRef.current = { collectPlayMaterialLibrary, collectPlayTextureBytes };
  const meshRef = useRef<Mesh | null>(null);
  // The preview resolves the project's Water quality (and render mode) like the viewports.
  const renderSettings = projectDocument?.settings.render;
  const renderSettingsRef = useRef(renderSettings);
  renderSettingsRef.current = renderSettings;
  useEffect(() => {
    if (sceneRef.current) setSceneRenderSettings(sceneRef.current, previewRenderSettings(renderSettings));
  }, [renderSettings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    // Style compiles into the water shader; the Custom Material reloads when it or anything it reaches changes.
    void style; void closureKey;
    const host = createParticlePreviewScene(engine, { skybox: true });
    setSceneRenderSettings(host.scene, previewRenderSettings(renderSettingsRef.current));
    sceneRef.current = host.scene;
    const sun = new DirectionalLight("water-preview-sun", new Vector3(-0.3, -1, 0.6), host.scene);
    sun.intensity = 1.4;
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
      if (materialGuid) {
        const { collectPlayMaterialLibrary: collectLibrary, collectPlayTextureBytes: collectTextures } = loadersRef.current;
        const library = await collectLibrary(undefined, [], [materialGuid]);
        const bytes = await collectTextures(new Map(), new Map(), library.textureGuids);
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
        const document = library.documents.get(materialGuid);
        if (!document) throw new Error("The selected Water material is unavailable.");
        const acquired = materials.acquire(host.scene, materialGuid, document);
        if (acquired.ok === false) throw new Error(acquired.diagnostics.map((entry) => entry.message).join("\n"));
        const diagnostics = await acquired.ready;
        if (cancelled) return;
        if (diagnostics.length) throw new Error(diagnostics.map((entry) => entry.message).join("\n"));
        customMaterial = acquired.material;
      }
      if (cancelled) return;
      meshRef.current = createWaterMesh(host.scene, "water-preview", normalizeWaterBody(PREVIEW_BODY), definitionRef.current, customMaterial);
      frame = requestAnimationFrame(tick);
    })().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Water preview could not load."); });
    return () => { cancelled = true; sceneRef.current = null; meshRef.current = null; cancelAnimationFrame(frame); presenter.dispose(); host.dispose(); materials?.dispose(); };
  }, [engine, style, materialGuid, closureKey]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh) updateWaterMeshDefinition(mesh, JSON.parse(definitionKey));
  }, [definitionKey]);

  return <PanelFrame data-testid="water-preview-panel">
    <canvas ref={canvasRef} className="min-h-0 h-full w-full touch-none" aria-label="Water Preview" data-testid="water-preview-canvas" />
    {error ? <Alert variant="destructive"><AlertTitle>Preview Failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
  </PanelFrame>;
}
