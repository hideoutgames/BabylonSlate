import { useEffect, useMemo, useRef, useState } from "react";
import { DirectionalLight, Vector3, type AbstractEngine, type Mesh, type Scene } from "@babylonjs/core";
import type { IDockviewPanelProps } from "dockview-react";
import { AssetPicker, PanelFrame, PropertyGrid, assetRowIdentity, humanizePropertyLabel, type PropertyRow } from "@haptic/editor-kit";
import {
  createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, type RenderProjectSettings, type WaterDefinition,
} from "@haptic/core";
import {
  attachMaterialPreviewGestures,
  createMaterialPreviewPresenter, createParticlePreviewScene, createWaterMesh, setSceneRenderSettings, setSceneWaterTime, updateWaterMeshDefinition,
  MaterialLibrary, installTextureBytes, acquireMaterialTexture, resourceCacheForEngine, type RenderShadingSettings,
} from "@haptic/render";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
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
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";

/** Open tabs whose unsaved content a Custom Material's library load reads. */
const MATERIAL_CLOSURE_KINDS = ["material", "material-instance", "material-function"] as const;

type NumberKey = { [K in keyof WaterDefinition]: WaterDefinition[K] extends number ? K : never }[keyof WaterDefinition];
type NumberControl = readonly [key: NumberKey, min: number, max: number];
/** Numeric rows in Details order: look (then Object Reflections), waves, then surface detail. */
const lookControls = [
  ["opacity", 0, 1], ["roughness", 0.02, 1], ["reflectionStrength", 0, 2], ["refraction", 0, 1], ["colorVariation", 0, 1],
  ["depthColorDistance", 0.01, 1000],
] as const satisfies readonly NumberControl[];
/** A wind sea and a swell: lengths and heights are independent, so a sea of any size takes any height. */
const waveControls = [
  ["waveHeight", 0, 20], ["waveLength", 0.1, 2000], ["waveDirection", -360, 360], ["waveSpread", 0, 1],
  ["swellHeight", 0, 20], ["swellLength", 0.5, 2000], ["swellDirection", -360, 360],
  ["waveSpeed", 0, 20], ["steepness", 0, 1], ["peakSharpness", 1, 7], ["waveSeed", 0, 65535], ["detailWaves", 0, 1],
] as const satisfies readonly NumberControl[];
const surfaceControls = [
  ["foamAmount", 0, 1], ["foamWidth", 0, 20], ["crestFoam", 0, 1], ["surfaceFoam", 0, 1],
  ["contactFoamWidth", 0, 8], ["subsurface", 0, 2], ["colorBands", 0, 12], ["sparkles", 0, 1], ["density", 1, 20000],
] as const satisfies readonly NumberControl[];
/** Painted-only rows; Realistic hides them. */
const paintedOnly = new Set<NumberKey>(["colorBands", "sparkles"]);
const descriptions: Partial<Record<NumberKey, string>> = {
  opacity: "Maximum opacity of deep water. Shallow water near banks stays clearer.",
  roughness: "Realistic: how far the sun glint and sky reflection spread. Painted: width of the sun's highlight.",
  reflectionStrength: "Realistic: strength of the sky reflection. Painted: strength of the soft painted sky reflection, strongest at grazing views.",
  depthColorDistance: "Metres of water that absorb most light. Smaller values look deeper and darker sooner.",
  refraction: "Render only: how strongly the water bends the view of objects below it. 0 never samples the scene; needs the Water Refraction quality setting. Visible in scene viewports and Play, not in this preview.",
  colorVariation: "Render only: slow tint variation across open water.",
  waveHeight: "Wind sea: about how high crests stand above the mean, in metres. Independent of Wave Length. Affects physics.",
  waveLength: "Wind sea: the most common distance between crests, in metres, from ripples on a puddle (under 1) to ocean waves (hundreds). Independent of Wave Height. Affects physics.",
  waveDirection: "Wind sea: the heading the waves travel, in degrees. Affects physics.",
  waveSpread: "How far wind-sea headings fan out from Wave Direction: 0 is long parallel crests, 1 is a confused sea. Affects physics.",
  swellHeight: "A second, longer swell under the wind sea: its crest height in metres. 0 turns it off. Affects physics.",
  swellLength: "The swell's distance between crests, in metres. Long values give long-spanning waves that roll in from afar. Affects physics.",
  swellDirection: "The heading the swell travels, in degrees. Affects physics.",
  waveSpeed: "Scales how fast the whole sea moves. 1 is natural speed for the wavelengths.",
  steepness: "How far water moves sideways under the crests: higher values give sharp, peaked waves that fold into whitecaps. 0 moves water only up and down. Affects physics.",
  peakSharpness: "How tightly the waves gather around their wavelengths. Higher values give a more regular sea. Affects physics.",
  waveSeed: "Picks another repeatable arrangement of the same sea. Affects physics.",
  detailWaves: "Strength of the short waves riding the big ones. 0 leaves only the long waves. Affects physics.",
  foamWidth: "Metres of shoreline foam measured from the bank or terrain shoreline.",
  crestFoam: "Whitecaps where crests fold over; their foam lingers and fades behind them. Gentle seas stay clear.",
  surfaceFoam: "Thin foam left lingering behind breaking crests.",
  subsurface: "Sunlight glowing through the crests of the waves.",
  contactFoamWidth: "Metres of foam around objects and terrain that cross the surface.",
  colorBands: "Painted: light steps painted across each wave. 0 or 1 shades smoothly.",
  sparkles: "Painted: twinkling sun glints on the waves.",
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
  const defaults = createDefaultWaterDefinition(water.style);
  /** `field` names the per-field merge key: one scrub or color drag is one undo step. */
  const commit = (next: WaterDefinition, field?: string) => { void applyAssetDocumentChange(documentId, normalizeWaterDefinition(next) as unknown as Record<string, unknown>, field ? `water:${field}` : undefined); };
  // Surface Materials change with the registry, not with edits of this Water.
  const assets = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).filter((asset) => isMaterialAssetType(asset.header.type) && (!asset.header.payload?.domain || asset.header.payload.domain === "surface"));
  }, [assetRegistry, registryEpoch]);
  const pickerAssets = useMemo(() => assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path })), [assets]);
  const selected = assets.find((asset) => asset.header.guid === water.materialGuid);
  const numberRow = ([key, min, max]: NumberControl): PropertyRow => {
    const description = descriptions[key];
    return {
      id: `water-${key}`, kind: "number", label: key === "steepness" ? "Choppiness" : humanizePropertyLabel(key), value: water[key],
      defaultValue: defaults[key], min, max, ...(key === "waveSeed" ? { precision: 0 } : {}),
      ...(description ? { description } : {}), onChange: (value) => commit({ ...water, [key]: value }, key),
    };
  };
  const rows: PropertyRow[] = [
    { id: "water-style", kind: "enum", label: "Style", value: water.style, options: [{ value: "realistic", label: "Realistic" }, { value: "stylized", label: "Painted" }], description: "Realistic is lit, physically shaded water. Painted is soft, hand-painted-looking water with stepped light and clean foam. Your colors and wave settings are retained.", onChange: (style) => commit({ ...water, style: style === "stylized" ? "stylized" : "realistic" }) },
    ...(["shallowColor", "deepColor", "foamColor"] as const).map((key): PropertyRow => ({ id: `water-${key}`, kind: "color", label: humanizePropertyLabel(key), value: water[key], defaultValue: defaults[key], onChange: (value) => commit({ ...water, [key]: [value[0], value[1], value[2]] }, key) })),
    ...lookControls.map(numberRow),
    { id: "water-objectReflections", kind: "boolean", label: "Object Reflections", value: water.objectReflections, defaultValue: defaults.objectReflections, description: "Render only: also reflect scene objects (screen-space or planar, per the Water Reflections quality setting). Off reflects only the sky. Visible in scene viewports and Play, not in this preview.", onChange: (objectReflections) => commit({ ...water, objectReflections }) },
    ...waveControls.map(numberRow),
    ...surfaceControls.filter(([key]) => water.style === "stylized" || !paintedOnly.has(key)).map(numberRow),
    { id: "water-material", kind: "asset", label: "Custom Material", value: water.materialGuid, placeholder: "Built-In Water", description: "Optional Surface Material that replaces the built-in shading. Buoyancy keeps working; add a Water Waves node to displace the surface with the full waves.", ...(selected ? assetRowIdentity({ name: selected.header.name, type: selected.header.type }) : {}), onPick: () => setPicking(true), onChange: (materialGuid) => commit({ ...water, materialGuid }) },
  ];
  return <PanelFrame data-testid="water-details-panel"><div className="min-h-0 flex-1 overflow-auto p-2"><PropertyGrid rows={rows} /></div>
    <AssetPicker open={picking} onOpenChange={setPicking} allowedTypes={["Material", "MaterialInstance"]} assets={pickerAssets} createTypes={["Material"]} createOptions={{ waterMaterial: water.style === "stylized" ? "painted" : "realistic" }} onPick={(materialGuid) => { commit({ ...water, materialGuid }); setPicking(false); }} />
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
    // Orbit pivots on the lake's centre, above or below its surface.
    host.camera.target = Vector3.Zero();
    const presenter = createMaterialPreviewPresenter(host, canvas, { onError: setError });
    // Drag orbits about the centre, pinch and wheel zoom; the running loop redraws.
    const gestures = attachMaterialPreviewGestures(canvas, host.camera);
    let materials: MaterialLibrary | null = null;
    let cancelled = false;
    let frame = 0;
    let animating = false;
    const start = performance.now();
    setError(null);
    const shown = () =>
      document.visibilityState !== "hidden" && !editorQuiet() && canvas.clientWidth > 0 && canvas.clientHeight > 0;
    // A hidden page, a game covering the editor or a zero-size canvas ends the loop; a resize,
    // visibility change or the editor coming back starts it again.
    const tick = (now: number) => {
      frame = 0;
      if (!shown()) return;
      try {
        setSceneWaterTime(host.scene, (now - start) / 1000);
        presenter.present();
        frame = requestAnimationFrame(tick);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Water preview could not render."); }
    };
    const resume = () => {
      if (animating && frame === 0 && shown()) frame = requestAnimationFrame(tick);
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resume);
    resizeObserver?.observe(canvas);
    document.addEventListener("visibilitychange", resume);
    const stopQuietWatch = subscribeEditorQuiet(resume);
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
      animating = true;
      frame = requestAnimationFrame(tick);
    })().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Water preview could not load."); });
    return () => {
      cancelled = true; sceneRef.current = null; meshRef.current = null;
      resizeObserver?.disconnect(); document.removeEventListener("visibilitychange", resume); stopQuietWatch();
      cancelAnimationFrame(frame); gestures.dispose(); presenter.dispose(); host.dispose(); materials?.dispose();
    };
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
