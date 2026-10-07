import {
  Camera,
  Color3,
  Color4,
  Engine,
  FreeCamera,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PBRMaterial,
  Scene,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
} from "@babylonjs/core";
import { createDefaultTilemapPayload, normalizeTilesetPayload, setTile } from "@babylonslate/assets";
import { normalizeRenderEffectsSettings } from "@babylonslate/core";
import {
  applyAlbedoTexture,
  applyTilemapAlbedoTextures,
  bindParticleMaterial,
  compileMaterialPlan,
  createAppWebGpuEngine,
  createBabylonParticleSystem,
  createSpriteQuad,
  createText2DMesh,
  createTilemapMeshes,
  ResourceCache,
  setSceneRenderSettings,
  worldTileSize,
  type Text2DAssetContext,
} from "@babylonslate/render";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@babylonslate/shader-graph";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { sceneRenderingSettings, setSceneEffectsAssets } from "@babylonslate/render/render-settings";

const WIDTH = 64;
const HEIGHT = 32;

/** A 16-slice strip (256x16): blue picks the slice, red across, green down. */
async function lutPng(map: (r: number, g: number, b: number) => [number, number, number]): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 16;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(256, 16);
  for (let b = 0; b < 16; b++)
    for (let g = 0; g < 16; g++)
      for (let r = 0; r < 16; r++) {
        const index = (g * 256 + b * 16 + r) * 4;
        const [x, y, z] = map(r / 15, g / 15, b / 15);
        image.data.set([Math.round(x * 255), Math.round(y * 255), Math.round(z * 255), 255], index);
      }
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("LUT encode failed"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

async function createProofEngine(backend: "webgl2" | "webgpu", width = WIDTH, height = HEIGHT) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(width, height);
  return { canvas, engine };
}

/** Prepare the graph, present two rendered frames and read back RGBA rows. */
async function presentPixels(
  engine: AbstractEngine,
  graph: ForwardSceneFrameGraph,
  camera: Camera,
  backend: "webgl2" | "webgpu",
  deadline: number,
): Promise<number[]> {
  await graph.prepare(camera);
  while (!graph.readiness(camera).ready) {
    if (performance.now() > deadline) throw new Error("Grading readiness timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  for (let presented = 0; presented < 2;) {
    engine.beginFrame();
    let rendered: boolean;
    try {
      rendered = graph.render(camera, false).rendered !== false;
    } finally {
      engine.endFrame();
    }
    if (rendered) presented++;
    else {
      if (performance.now() > deadline) throw new Error("Grading presentation timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      await graph.prepare(camera);
    }
  }
  const pixels = await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight());
  const result = Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  if (backend === "webgpu" &&
    (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm")
    for (let i = 0; i < result.length; i += 4) [result[i], result[i + 2]] = [result[i + 2]!, result[i]!];
  return result;
}

/** Release the graph and scene, then flush the engine's deferred work. */
async function disposeProofScene(engine: AbstractEngine, graph: ForwardSceneFrameGraph, scene: Scene) {
  graph.dispose();
  await graph.whenReleased();
  scene.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  engine.beginFrame();
  engine.endFrame();
}

/** Real LUT assets through the scene effects asset context. */
export async function runColorGradingProof(backend: "webgl2" | "webgpu") {
  const { canvas, engine } = await createProofEngine(backend);
  const textureBytes = new Map([
    ["identity", await lutPng((r, g, b) => [r, g, b])],
    ["invert", await lutPng((r, g, b) => [1 - r, 1 - g, 1 - b])],
  ]);
  const captures = [];
  try {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("Grading Camera", new Vector3(0, 0, -5), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    // Four unlit swatches across the frame cover each channel and a mid gray.
    [[0.9, 0.2, 0.1], [0.1, 0.8, 0.3], [0.2, 0.3, 0.9], [0.5, 0.5, 0.5]].forEach((rgb, i) => {
      const material = new PBRMaterial(`Swatch ${i}`, scene);
      material.unlit = true;
      material.albedoColor = new Color3(rgb[0]!, rgb[1]!, rgb[2]!);
      const swatch = MeshBuilder.CreatePlane(`Swatch ${i}`, { width: 2.2, height: 4 }, scene);
      swatch.position.x = -3.3 + i * 2.2;
      swatch.material = material;
    });
    setSceneEffectsAssets(scene, { textureBytes });
    const effects = normalizeRenderEffectsSettings(undefined);
    const settings = () => setSceneRenderSettings(scene, { mode: "pbr", effects });
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      settings();
      const deadline = performance.now() + 15_000;
      // The LUT publishes once loaded; only then does the plan grade.
      const wanted = effects.colorGrading.enabled && effects.colorGrading.lutTextureGuid;
      while (wanted && textureBytes.has(wanted) && !sceneRenderingSettings(scene).effectsPlan?.imageProcessing?.colorGrading) {
        if (performance.now() > deadline) throw new Error("LUT load timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      return presentPixels(engine, graph, camera, backend, deadline);
    };
    try {
      const off = await draw();
      effects.colorGrading = { enabled: true, lutTextureGuid: "identity" };
      const identity = await draw();
      effects.colorGrading = { enabled: true, lutTextureGuid: "invert" };
      const inverted = await draw();
      effects.colorPipeline.mode = "sceneLinear";
      const linearInverted = await draw();
      effects.colorPipeline.mode = "legacyDisplay";
      effects.colorGrading = { enabled: true, lutTextureGuid: "missing" };
      const missing = await draw();
      effects.colorGrading = { enabled: false, lutTextureGuid: "invert" };
      const disabled = await draw();
      captures.push({ off, identity, inverted, linearInverted, missing, disabled });
    } finally {
      await disposeProofScene(engine, graph, scene);
    }
    return { captures };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

const DISPLAY_WIDTH = 96;
const DISPLAY_HEIGHT = 48;
/** The orthographic display proof frame spans 24×12 world units. */
const DISPLAY_PIXELS_PER_UNIT = 4;

/** A solid-color PNG fixture. */
async function solidPng(size: number, rgb: [number, number, number]): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.fillStyle = `rgb(${rgb.join(",")})`;
  context.fillRect(0, 0, size, size);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encode failed"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Move a visual so its bounds are centered on (x, y). */
function centerVisual(root: AbstractMesh, x: number, y: number) {
  root.computeWorldMatrix(true);
  const { min, max } = root.getHierarchyBoundingVectors(true);
  root.position.x += x - (min.x + max.x) / 2;
  root.position.y += y - (min.y + max.y) / 2;
}

/**
 * Display-space colors from each kind of scene color writer under Legacy
 * Display and each Scene Linear tone mapping. The top row holds authored lit
 * and unlit surfaces and Babylon's own linear unlit surface (the control). The
 * bottom row holds a tilemap tile, a sprite, an MSDF 2D Text glyph, a particle
 * and a Text-domain Material glyph, each a display mid gray. The band between
 * the rows shows the clear color. `points` are bottom-up pixel centers.
 */
export async function runDisplayColorProof(backend: "webgl2" | "webgpu") {
  const { canvas, engine } = await createProofEngine(backend, DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const captures: Record<string, number[]> = {};
  const points: Record<string, [number, number]> = {};
  const halfWidth = DISPLAY_WIDTH / DISPLAY_PIXELS_PER_UNIT / 2;
  const halfHeight = DISPLAY_HEIGHT / DISPLAY_PIXELS_PER_UNIT / 2;
  const point = (name: string, x: number, y: number) => {
    points[name] = [Math.round((x + halfWidth) * DISPLAY_PIXELS_PER_UNIT), Math.round((y + halfHeight) * DISPLAY_PIXELS_PER_UNIT)];
  };
  const resourceCache = new ResourceCache();
  try {
    const scene = new Scene(engine);
    // Display-space mid gray, like every authored color below.
    scene.clearColor = new Color4(0.5, 0.5, 0.5, 1);
    point("clear", 0, 0);
    const camera = new FreeCamera("Display Camera", new Vector3(0, 0, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -halfWidth;
    camera.orthoRight = halfWidth;
    camera.orthoTop = halfHeight;
    camera.orthoBottom = -halfHeight;
    scene.activeCamera = camera;
    // Unit white light facing the swatches, without ground light or highlights.
    const light = new HemisphericLight("Display Light", new Vector3(0, 0, -1), scene);
    light.groundColor = new Color3(0, 0, 0);
    light.specular = new Color3(0, 0, 0);
    const compile = async (document: MaterialDocument) => {
      const lowered = lowerMaterialDocument(document);
      if (!lowered.ok) throw new Error(`${document.name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name: document.name });
      if (!compiled.ok || (await compiled.ready).some((diagnostic) => diagnostic.severity === "error"))
        throw new Error(`${document.name} did not compile`);
      return compiled.material;
    };
    const authored = (name: string, rgb: [number, number, number], shadingModel: "pbr" | "unlit") => {
      const document = createDefaultMaterialDocument(name);
      document.shadingModel = shadingModel;
      document.nodes.find((node) => node.id === "baseColor")!.properties.value = rgb;
      return compile(document);
    };
    // Babylon's own unlit PBR surface is the linear-pipeline control.
    const native = new PBRMaterial("Native Unlit Gray", scene);
    native.unlit = true;
    native.albedoColor = new Color3(0.5, 0.5, 0.5).toLinearSpace();
    const swatches = {
      litGray: await authored("Lit Gray", [0.5, 0.5, 0.5], "pbr"),
      litRed: await authored("Lit Red", [0.9, 0.2, 0.1], "pbr"),
      unlitGray: await authored("Unlit Gray", [0.5, 0.5, 0.5], "unlit"),
      nativeGray: native,
    };
    Object.entries(swatches).forEach(([name, material], i) => {
      const swatch = MeshBuilder.CreatePlane(`Display Swatch ${name}`, { width: 5.6, height: 4 }, scene);
      swatch.position.set(-9 + i * 6, 3, 0);
      swatch.material = material;
      point(name, swatch.position.x, swatch.position.y);
    });

    // Bottom row: four-unit writers whose authored colors are a display mid gray.
    const slot = (i: number): [number, number] => [-9.6 + i * 4.8, -3];
    const textMaterial = await compile(createDefaultMaterialDocument("Text Gray", "text"));
    const tilesets = new Map([["tileset", normalizeTilesetPayload({
      textureGuid: "gray", atlasWidth: 16, atlasHeight: 16, tileWidth: 16, tileHeight: 16,
    })]]);
    const assets: Text2DAssetContext = {
      resourceCache,
      pixelsPerUnit: DISPLAY_PIXELS_PER_UNIT,
      textureBytes: new Map([["gray", await solidPng(16, [128, 128, 128])]]),
      tilesets,
      // One solid MSDF cell: full coverage everywhere, so the glyph is a block.
      fontMsdfJson: new Map([["font", new TextEncoder().encode(JSON.stringify({
        info: { size: 16 }, common: { scaleW: 16, scaleH: 16 },
        chars: [{ id: 77, x: 0, y: 0, width: 16, height: 16, xoffset: 0, yoffset: 0, xadvance: 16 }],
      }))]]),
      fontMsdfPng: new Map([["font", await solidPng(16, [255, 255, 255])]]),
      resolveMaterial: (guid) => (guid === "text-gray" ? textMaterial : null),
    };
    const tilemap = setTile({
      ...createDefaultTilemapPayload(),
      tilesetGuid: "tileset",
      tilesets: [{ guid: "tileset", firstGid: 1, tileCount: 1 }],
    }, "layer-1", 0, 0, 1);
    const tileSize = worldTileSize(tilemap, DISPLAY_PIXELS_PER_UNIT);
    const tiles = createTilemapMeshes(scene, "Display Tilemap", tilemap, tilesets, tileSize.width, tileSize.height);
    applyTilemapAlbedoTextures(tiles, scene, assets);
    centerVisual(tiles, ...slot(0));
    point("tilemap", ...slot(0));

    const sprite = createSpriteQuad(scene, "Display Sprite", {
      name: "gray", u: 0, v: 0, uSize: 1, vSize: 1, durationMs: 100, pivot: { x: 0.5, y: 0.5 }, width: 16, height: 16,
    }, DISPLAY_PIXELS_PER_UNIT);
    applyAlbedoTexture(sprite, scene, "gray", assets);
    centerVisual(sprite, ...slot(1));
    point("sprite", ...slot(1));

    const text = { text: "M", size: 16, color: [0.5, 0.5, 0.5], renderer: "msdf", fontAssetGuid: "font" };
    centerVisual(createText2DMesh(scene, "Display MSDF Text", text, assets), ...slot(2));
    point("msdfText", ...slot(2));

    const emitter = new Mesh("Display Particle Emitter", scene);
    emitter.alwaysSelectAsActiveMesh = true;
    emitter.position.set(...slot(3), 0);
    const particles = createBabylonParticleSystem("Display Particle", scene, 1, false);
    particles.emitter = emitter;
    particles.createPointEmitter(Vector3.Zero(), Vector3.Zero());
    particles.minEmitPower = particles.maxEmitPower = 0;
    particles.minSize = particles.maxSize = 4;
    particles.minLifeTime = particles.maxLifeTime = 1e6;
    particles.emitRate = 1000;
    particles.gravity.setAll(0);
    particles.color1 = new Color4(0.5, 0.5, 0.5, 1);
    particles.color2 = new Color4(0.5, 0.5, 0.5, 1);
    particles.colorDead = new Color4(0.5, 0.5, 0.5, 1);
    particles.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    particles.preWarmCycles = 1;
    await bindParticleMaterial(particles, await compile(createDefaultMaterialDocument("Particle Gray", "particle")));
    particles.start();
    point("particle", ...slot(3));

    centerVisual(createText2DMesh(scene, "Display Text Material", { ...text, materialGuid: "text-gray" }, assets), ...slot(4));
    point("textMaterial", ...slot(4));

    const effects = normalizeRenderEffectsSettings(undefined);
    const graph = new ForwardSceneFrameGraph(scene);
    const draw = () => {
      setSceneRenderSettings(scene, { mode: "pbr", effects });
      return presentPixels(engine, graph, camera, backend, performance.now() + 15_000);
    };
    try {
      captures.legacy = await draw();
      effects.colorPipeline.mode = "sceneLinear";
      for (const toneMapping of ["none", "standard", "aces", "neutral"] as const) {
        effects.toneMapping = toneMapping;
        captures[toneMapping] = await draw();
      }
    } finally {
      await disposeProofScene(engine, graph, scene);
    }
    return { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, points, captures };
  } finally {
    resourceCache.dispose();
    engine.dispose();
    canvas.remove();
  }
}
