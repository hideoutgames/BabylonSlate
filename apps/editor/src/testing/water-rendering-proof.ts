import {
  AbstractMesh, Camera, Color3, Color4, DirectionalLight, Engine, FreeCamera, HemisphericLight, MeshBuilder, PBRMaterial, PointLight, Scene, StandardMaterial,
  Vector3, type AbstractEngine, type ArcRotateCamera, type Mesh,
} from "@babylonjs/core";
import {
  createDefaultWaterDefinition, DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality, normalizeWaterBody, qualityPresetPatch, sampleWaterSurface,
  WATER_SHADING_DETAILS, type QualityLevel, type WaterBodyProperties, type WaterDefinition, type WaterKind, type WaterQuality, type WaterShadingDetail,
} from "@babylonslate/core";
import {
  createAppWebGpuEngine, createParticlePreviewScene, createWaterMesh, setSceneRenderSettings, setSceneWaterTime, setWaterGpuWaves, updateSceneWater,
  waterPlanarReflectionDiagnostics, waterPlanarReflectionForCamera,
} from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { createLandscapeMesh } from "../../../../packages/render/src/landscape-mesh";
import { installPreviewEnvironment } from "../../../../packages/render/src/preview-environment";
import { RENDERING_GROUP } from "../../../../packages/render/src/sorting";
import { sceneRenderingSettings, updateSceneRenderingSettings } from "../../../../packages/render/src/render-settings";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Capture = () => Promise<{ pixels: number[]; png: string }>;

/** Side-on parity view: 1.6 m × 1 m over the 640 × 400 canvas (2.5 mm per pixel), 3 m from the slice. */
const PARITY_HALF_WIDTH = 0.8, PARITY_HALF_HEIGHT = 0.5, PARITY_DISTANCE = 3, PARITY_SLAB = 0.03;

/**
 * CPU-vs-GPU vertex parity. A side-on orthographic camera whose near and far planes keep only a 6 cm slab of depth
 * sees the displaced surface as a thin ribbon, so each pixel column's topmost water pixel is the surface height there.
 * Built-in water draws that profile from its vertex shader (GPU waves); `setWaterGpuWaves(mesh, false)` draws the same
 * water from CPU-displaced vertices (the Custom Material path). Cases: a steep Ocean Spectrum sea (eight components,
 * open water, Ultra mesh density) and a narrow Classic volume whose horizontal motion fades toward both banks.
 */
async function measureVertexParity(scene: Scene, camera: ArcRotateCamera, capture: Capture, backend: "webgl2" | "webgpu", canvas: HTMLCanvasElement, evidence: Record<string, string>) {
  const saved = {
    mode: camera.mode, alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone(), minZ: camera.minZ, maxZ: camera.maxZ,
    ortho: [camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom] as const, clear: scene.clearColor.clone(),
    quality: sceneRenderingSettings(scene).project.quality,
  };
  const shown = scene.meshes.filter((mesh) => mesh.isVisible);
  for (const mesh of shown) mesh.isVisible = false;
  scene.clearColor = new Color4(1, 0, 1, 1);
  updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("ultra")) });
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -PARITY_HALF_WIDTH; camera.orthoRight = PARITY_HALF_WIDTH; camera.orthoTop = PARITY_HALF_HEIGHT; camera.orthoBottom = -PARITY_HALF_HEIGHT;
  camera.setTarget(Vector3.Zero(), false, false, true);
  camera.alpha = -Math.PI / 2; camera.beta = Math.PI / 2; camera.radius = PARITY_DISTANCE;
  camera.minZ = PARITY_DISTANCE - PARITY_SLAB; camera.maxZ = PARITY_DISTANCE + PARITY_SLAB;
  const metresPerPixel = 2 * PARITY_HALF_HEIGHT / canvas.height;
  // Evidence from the read-back pixels themselves (a WebGPU canvas cannot be re-encoded after presenting).
  const png = (pixels: number[]) => {
    const out = document.createElement("canvas");
    out.width = canvas.width; out.height = canvas.height;
    const context = out.getContext("2d")!, image = context.createImageData(canvas.width, canvas.height), stride = canvas.width * 4;
    for (let row = 0; row < canvas.height; row++) {
      const source = (backend === "webgl2" ? canvas.height - 1 - row : row) * stride;
      for (let i = 0; i < stride; i++) image.data[row * stride + i] = pixels[source + i]!;
    }
    context.putImageData(image, 0, 0);
    return out.toDataURL("image/png");
  };
  // Height (pixel rows above the bottom of the view) of each column's topmost water pixel; null where it shows none.
  const profile = (pixels: number[]) => Array.from({ length: canvas.width }, (_, x) => {
    let top: number | null = null;
    for (let row = 0; row < canvas.height; row++) {
      const i = (row * canvas.width + x) * 4;
      if (Math.abs(pixels[i]! - 255) + pixels[i + 1]! + Math.abs(pixels[i + 2]! - 255) < 90) continue;
      const above = backend === "webgl2" ? row : canvas.height - 1 - row;
      top = top === null ? above : Math.max(top, above);
    }
    return top;
  });
  const compare = (a: (number | null)[], b: (number | null)[]) => {
    let sum = 0, max = 0, columns = 0;
    for (let x = 0; x < a.length; x++) {
      if (a[x] === null || b[x] === null) continue;
      const difference = Math.abs(a[x]! - b[x]!);
      sum += difference; max = Math.max(max, difference); columns++;
    }
    return { columns, meanPx: columns ? sum / columns : Infinity, maxPx: max };
  };
  const quiet = { opacity: 1, foamAmount: 0, crestFoam: 0, surfaceFoam: 0, sparkles: 0 };
  const cases: Record<"ocean" | "bank", { body: WaterBodyProperties; water: WaterDefinition }> = {
    ocean: {
      body: normalizeWaterBody({ resolution: 128 }, "global"),
      water: { ...createDefaultWaterDefinition("stylized"), ...quiet, waveModel: "ocean", waveSeed: 11, waveHeight: 0.4, waveLength: 6, steepness: 1, choppiness: 0.6 },
    },
    bank: {
      body: normalizeWaterBody({ width: 3, length: 6, resolution: 128 }, "ocean"),
      water: { ...createDefaultWaterDefinition("stylized"), ...quiet, waveHeight: 0.4, waveLength: 4, steepness: 1, choppiness: 0.5 },
    },
  };
  const results = {} as Record<"ocean" | "bank", { columns: number; meanPx: number; maxPx: number; meanMetres: number; maxMetres: number; reliefMetres: number; motionPx: number; queryMeanMetres: number }>;
  try {
    for (const name of ["ocean", "bank"] as const) {
      const { body, water } = cases[name];
      setSceneWaterTime(scene, 2.3);
      const mesh = createWaterMesh(scene, `parity-${name}`, body, water);
      const gpuShot = await capture();
      setWaterGpuWaves(mesh, false);
      const cpuShot = await capture();
      // Later on the GPU path only the clock changes: the waves must still move.
      setWaterGpuWaves(mesh, true);
      setSceneWaterTime(scene, 3);
      const laterShot = await capture();
      mesh.dispose();
      evidence[`vertex-parity-${name}-gpu`] = png(gpuShot.pixels); evidence[`vertex-parity-${name}-cpu`] = png(cpuShot.pixels);
      const gpu = profile(gpuShot.pixels), cpu = profile(cpuShot.pixels), later = profile(laterShot.pixels);
      const parity = compare(gpu, cpu), heights = gpu.filter((value): value is number => value !== null);
      // The GPU profile against the physics query along the slice (z = 0): slab thickness and pixels allow about 1.5 cm.
      let queryError = 0;
      for (let x = 0; x < gpu.length; x++) {
        if (gpu[x] === null) continue;
        const query = sampleWaterSurface(water, body, { x: -PARITY_HALF_WIDTH + (x + 0.5) * metresPerPixel, y: 0, z: 0 }, 2.3);
        queryError += Math.abs((gpu[x]! + 0.5) * metresPerPixel - PARITY_HALF_HEIGHT - query.height);
      }
      results[name] = {
        ...parity, meanMetres: parity.meanPx * metresPerPixel, maxMetres: parity.maxPx * metresPerPixel,
        reliefMetres: heights.length ? (Math.max(...heights) - Math.min(...heights)) * metresPerPixel : 0, motionPx: compare(gpu, later).meanPx,
        queryMeanMetres: heights.length ? queryError / heights.length : Infinity,
      };
    }
  } finally {
    camera.mode = saved.mode; camera.minZ = saved.minZ; camera.maxZ = saved.maxZ;
    [camera.orthoLeft, camera.orthoRight, camera.orthoTop, camera.orthoBottom] = saved.ortho;
    camera.setTarget(saved.target, false, false, true);
    camera.alpha = saved.alpha; camera.beta = saved.beta; camera.radius = saved.radius;
    scene.clearColor = saved.clear;
    updateSceneRenderingSettings(scene, { quality: saved.quality });
    for (const mesh of shown) mesh.isVisible = true;
  }
  return { metresPerPixel, width: canvas.width, ...results };
}

/**
 * Past a landscape's edge there is no terrain under the water, so Stylized water there must look like open water, not
 * a band of shore foam. Global Water around a hidden landscape whose border sits above the water (dry) or just under it
 * (wave troughs reach below it), seen from above with other foam off: the share of white pixels 2.5-7 m past the
 * edge, against 12-18 m past it, and how much the near band differs from the same view without water.
 */
async function measureLandscapeEdge(scene: Scene, camera: ArcRotateCamera, capture: Capture, canvas: HTMLCanvasElement, evidence: Record<string, string>) {
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -10; camera.orthoRight = 10; camera.orthoTop = 6.25; camera.orthoBottom = -6.25;
  camera.alpha = -Math.PI / 2; camera.beta = 0.01; camera.radius = 24;
  // The landscape spans x -10..10, so the view runs from its east edge to 20 m past it, world +X to the right.
  camera.setTarget(new Vector3(20, 0, 0), false, false, true);
  // Pixel columns between two world X positions.
  const columns = (fromX: number, toX: number) =>
    [fromX, toX].map((x) => Math.round((x - 20 - camera.orthoLeft!) / (camera.orthoRight! - camera.orthoLeft!) * canvas.width)) as [number, number];
  const measure = (pixels: number[], [from, to]: readonly [number, number], bare?: number[]) => {
    let white = 0, change = 0, count = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = from; x < to; x++) {
      const i = (y * canvas.width + x) * 4;
      if (Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > 200) white++;
      if (bare) for (let c = 0; c < 3; c++) change += Math.abs(pixels[i + c]! - bare[i + c]!) / 3;
      count++;
    }
    return { white: white / count, change: change / count };
  };
  const result = {} as Record<"dry" | "shallow", { near: number; far: number; water: number }>;
  setSceneWaterTime(scene, 1.7);
  // Dry: a basin whose rim stands 1 m above the water around a pool 2 m deep, so the water meets it. Shallow: a floor
  // 8 cm under the water, which the default waves' troughs reach below.
  const rim = (i: number) => i % 5 === 0 || i % 5 === 4 || i < 5 || i >= 20;
  for (const [name, height] of [["dry", (i: number) => (rim(i) ? 1 : -2)], ["shallow", () => -0.08]] as const) {
    const landscape = createLandscapeMesh(scene, `edge-${name}`, { width: 20, depth: 20, subdivisions: 4, heights: Array.from({ length: 25 }, (_, i) => height(i)) });
    for (const mesh of landscape.getChildMeshes()) mesh.isVisible = false;
    const bare = await capture();
    const sea = createWaterMesh(scene, `edge-${name}-water`, normalizeWaterBody({}, "global"),
      { ...createDefaultWaterDefinition("stylized"), crestFoam: 0, surfaceFoam: 0, sparkles: 0 });
    const shot = await capture();
    evidence[`stylized-landscape-edge-${name}`] = shot.png;
    const near = measure(shot.pixels, columns(12.5, 17), bare.pixels), far = measure(shot.pixels, columns(22, 28));
    result[name] = { near: near.white, far: far.white, water: near.change };
    sea.dispose(); landscape.dispose();
  }
  return result;
}

/** Test-build-only captures of production water, including a fixed-world transform comparison. */
export async function runWaterRenderingProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 400;
  document.getElementById("root")!.append(canvas);
  // Match the app: large-world rendering makes shader positions eye-relative.
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  const host = createParticlePreviewScene(engine, { skybox: true });
  const { scene, camera } = host;
  const sun = new DirectionalLight("sun", new Vector3(-0.3, -1, 0.6), scene);
  sun.intensity = 1.4;
  camera.alpha = -Math.PI / 2; camera.beta = 1.03; camera.radius = 24;
  camera.maxZ = 1200;
  for (const mesh of scene.meshes) if (mesh.metadata?.skybox) mesh.infiniteDistance = true;
  const capture = async () => {
    await scene.whenReadyAsync();
    camera.getViewMatrix(true);
    updateSceneWater(scene);
    await scene.whenReadyAsync();
    engine.beginFrame();
    try {
      scene.render();
      const raw = await engine.readPixels(0, 0, canvas.width, canvas.height);
      if (!raw) throw new Error("Missing water pixels");
      const pixels = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      // Capture the rendered canvas directly; readback is separately used for the invariant check.
      return { pixels: Array.from(pixels), png: canvas.toDataURL("image/png") };
    } finally { engine.endFrame(); }
  };
  try {
    const evidence: Record<string, string> = {};
    const differences: Record<string, number> = {};
    const brightness: Record<string, number> = {};
    const crowded: Record<string, number> = {};
    const pan: Record<string, number> = {};
    const whitecaps: Record<string, { calm: number; breaking: number; calmChange: number }> = {};
    const surfaceFoam: Record<string, { clear: number; foamy: number }> = {};
    const gerstner: Record<string, { classic: number; ocean: number; change: number }> = {};
    const subsurface: Record<string, { off: number; on: number }> = {};
    // Mean brightness of the view centre.
    const centreLight = (pixels: number[]) => {
      let light = 0, samples = 0;
      for (let y = 150; y < 250; y++) for (let x = 220; x < 420; x++) {
        const i = (y * canvas.width + x) * 4;
        light += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3; samples++;
      }
      return light / samples;
    };
    // Rows of the lower two thirds of the view (water, not sky): WebGL reads pixels bottom-up, WebGPU top-down.
    const lowerRows = backend === "webgl2" ? [0, Math.ceil(canvas.height * 2 / 3)] : [Math.floor(canvas.height / 3), canvas.height];
    // Share of near-white pixels in the lower two thirds of the view.
    const whiteShare = (pixels: number[]) => {
      let white = 0, count = 0;
      for (let y = lowerRows[0]!; y < lowerRows[1]!; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > 200) white++;
        count++;
      }
      return white / count;
    };
    // Mean brightness of the lower two thirds, and its mean per-channel change from another capture.
    const waterLight = (pixels: number[]) => {
      let sum = 0, count = 0;
      for (let y = lowerRows[0]!; y < lowerRows[1]!; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        sum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3; count++;
      }
      return sum / count;
    };
    const waterChange = (a: number[], b: number[]) => {
      let sum = 0, count = 0;
      for (let y = lowerRows[0]!; y < lowerRows[1]!; y++) for (let x = 0; x < canvas.width; x++) for (let c = 0; c < 3; c++) {
        const i = (y * canvas.width + x) * 4 + c;
        sum += Math.abs(a[i]! - b[i]!); count++;
      }
      return sum / count;
    };
    for (const style of ["realistic", "stylized"] as const) {
      setSceneWaterTime(scene, 1.7);
      const water = createDefaultWaterDefinition(style);
      const stable = createWaterMesh(scene, "transform-check", normalizeWaterBody({ width: 80, length: 80, waveScale: 0 }, "ocean"), { ...water, foamAmount: 0, depthColorDistance: 0.1 });
      const before = await capture();
      stable.position.set(7, 0, -4); stable.scaling.set(2, 4, 1.5);
      updateSceneWater(scene);
      const after = await capture();
      let sum = 0, count = 0;
      for (let y = 120; y < 280; y++) for (let x = 200; x < 440; x++) for (let c = 0; c < 3; c++) {
        const i = (y * canvas.width + x) * 4 + c;
        sum += Math.abs(before.pixels[i]! - after.pixels[i]!); count++;
      }
      differences[style] = sum / count;
      stable.dispose();
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 28, length: 24, waveScale: 1 }), water);
      const lit = await capture();
      evidence[style + "-lake"] = lit.png;
      // Mean centre brightness: an oversized fragment shader can compile but render black under several lights.
      brightness[style] = centreLight(lit.pixels);
      // Scenes raise a lit material's light slots with their light count: seven lights must still shade it.
      const lamps = [-6, -2, 2, 6].map((x, i) => {
        const lamp = new PointLight(`crowd-${i}`, new Vector3(x, 3, -4), scene);
        lamp.intensity = 0.2;
        return lamp;
      });
      (lake.material as PBRMaterial).maxSimultaneousLights = 8;
      const busy = await capture();
      evidence[style + "-lake-seven-lights"] = busy.png;
      crowded[style] = centreLight(busy.pixels);
      for (const lamp of lamps) lamp.dispose();
      lake.dispose();
      camera.beta = 1.38; camera.radius = 16;
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 120, length: 120 }, "ocean"), water);
      evidence[style + "-ocean"] = (await capture()).png;
      ocean.dispose();
      const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"), water);
      camera.setTarget(new Vector3(4000, 0, -2000), false, false, true);
      evidence[style + "-global"] = (await capture()).png;
      global.dispose();
      // Steep, sharp waves break into whitecaps as Crest Foam rises; long gentle swell never does.
      camera.setTarget(Vector3.Zero(), false, false, true);
      camera.alpha = -Math.PI / 2 - 0.6; camera.beta = 1.2; camera.radius = 30;
      const rough = { ...water, waveHeight: 1.2, waveLength: 22, choppiness: 0.7, surfaceFoam: 0, sparkles: 0 };
      const ocean300 = normalizeWaterBody({ width: 300, length: 300 }, "ocean");
      const sea = (crestFoam: number, foamAmount = rough.foamAmount) => createWaterMesh(scene, "whitecaps", ocean300, { ...rough, crestFoam, foamAmount });
      const shoot = async (mesh: ReturnType<typeof createWaterMesh>) => { const shot = await capture(); mesh.dispose(); return shot; };
      // Crest Foam 0 must match the same sea with no foam at all: no dim caps or trailing flecks either.
      const foamless = await shoot(sea(0, 0));
      const calm = await shoot(sea(0));
      const breaking = await shoot(sea(0.8));
      evidence[style + "-whitecaps"] = breaking.png;
      whitecaps[style] = { calm: whiteShare(calm.pixels), breaking: whiteShare(breaking.pixels), calmChange: waterChange(calm.pixels, foamless.pixels) };
      // Steep Gerstner seas, Classic and Ocean Spectrum (eight components): the shader shades the swell at each
      // fragment's rest point with the geometry's own components, so both models compile and light like the sea.
      const steep = (waveModel: "classic" | "ocean") => createWaterMesh(scene, "gerstner", ocean300, { ...rough, steepness: 1, waveModel });
      const classicSea = await shoot(steep("classic"));
      const spectrumSea = await shoot(steep("ocean"));
      evidence[style + "-gerstner-classic"] = classicSea.png;
      evidence[style + "-gerstner-ocean-spectrum"] = spectrumSea.png;
      gerstner[style] = { classic: waterLight(classicSea.pixels), ocean: waterLight(spectrumSea.pixels), change: waterChange(classicSea.pixels, spectrumSea.pixels) };
      // Surface Foam adds open-water foam (Realistic wind streaks, Stylized drifting patches) to an otherwise clear sea.
      const open = (overrides: Partial<typeof water>) => createWaterMesh(scene, "open-sea", ocean300, { ...water, crestFoam: 0, sparkles: 0, ...overrides });
      const clearSea = await shoot(open({ surfaceFoam: 0 }));
      const foamySea = await shoot(open({ surfaceFoam: 1 }));
      evidence[style + "-surface-foam"] = foamySea.png;
      surfaceFoam[style] = { clear: waterLight(clearSea.pixels), foamy: waterLight(foamySea.pixels) };
      // Subsurface: looking toward a low sun, light through the waves (Realistic) or tinted wave tops (Stylized)
      // lighten the sea.
      const sunDirection = sun.direction.clone();
      sun.direction = new Vector3(-0.42, -0.17, -0.89);
      camera.alpha = -Math.PI / 2; camera.beta = 1.38; camera.radius = 30;
      const flatLight = await shoot(open({ surfaceFoam: 0, subsurface: 0 }));
      const throughLight = await shoot(open({ surfaceFoam: 0, subsurface: style === "realistic" ? 2 : 1 }));
      evidence[style + "-subsurface"] = throughLight.png;
      subsurface[style] = { off: waterLight(flatLight.pixels), on: waterLight(throughLight.pixels) };
      sun.direction = sunDirection;
      camera.setTarget(Vector3.Zero(), false, false, true); camera.alpha = -Math.PI / 2; camera.beta = 1.03; camera.radius = 24;
      // Moving the eye must reveal a different part of the world-anchored pattern. If shading used
      // large-world rendering's eye-relative positions, a pure camera translation would change nothing.
      const still = createWaterMesh(scene, "pan-check", normalizeWaterBody({ width: 300, length: 300, waveScale: 0 }, "ocean"), { ...water, foamAmount: 0, sparkles: 0 });
      camera.beta = 0.6; camera.radius = 14;
      const centre = (pixels: number[]) => {
        const values: number[] = [];
        for (let y = 150; y < 250; y++) for (let x = 220; x < 420; x++) for (let c = 0; c < 3; c++) values.push(pixels[(y * canvas.width + x) * 4 + c]!);
        return values;
      };
      const a = centre((await capture()).pixels);
      camera.setTarget(new Vector3(7.3, 0, 4.1), false, false, true);
      const b = centre((await capture()).pixels);
      pan[style] = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
      still.dispose();
      camera.setTarget(Vector3.Zero(), false, false, true);
      camera.alpha = -Math.PI / 2; camera.beta = 1.03; camera.radius = 24;
    }
    // Objects crossing the water: a post and a sloped cone, seen in perspective at two wave phases.
    const post = MeshBuilder.CreateBox("contact-post", { width: 1, height: 4, depth: 1 }, scene);
    const cone = MeshBuilder.CreateCylinder("contact-cone", { height: 3, diameterBottom: 3, diameterTop: 0.4, tessellation: 48 }, scene);
    // Radius (3 - y) / 2: its waterline shrinks as a crest rises and widens in a trough.
    const spire = MeshBuilder.CreateCylinder("contact-spire", { height: 6, diameterBottom: 6, diameterTop: 0, tessellation: 64 }, scene);
    const dark = new StandardMaterial("contact-dark", scene);
    dark.diffuseColor = new Color3(0.08, 0.07, 0.06); dark.specularColor = Color3.Black();
    post.material = cone.material = spire.material = dark;
    // Placement settles like a rendered frame would, before each surface builds its contacts.
    const place = (at: "perspective" | "post" | "spire") => {
      post.position.set(at === "post" ? 0 : -1.6, 0, at === "post" ? 0 : 0.4); cone.position.set(1.8, 0, -0.2);
      post.isVisible = at !== "spire"; cone.isVisible = at === "perspective"; spire.isVisible = at === "spire";
      for (const mesh of [post, cone, spire]) mesh.computeWorldMatrix(true);
    };
    const topDown = () => {
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -4; camera.orthoRight = 4; camera.orthoTop = 2.5; camera.orthoBottom = -2.5;
      camera.alpha = -Math.PI / 2; camera.beta = 0.01; camera.radius = 24;
      camera.setTarget(Vector3.Zero(), false, false, true);
    };
    // Mean brightness between two distances (metres, 80 pixels each) from the view centre.
    const band = (pixels: number[], from: number, to: number, square = false) => {
      let sum = 0, count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const dx = Math.abs(x + 0.5 - canvas.width / 2) / 80, dy = Math.abs(y + 0.5 - canvas.height / 2) / 80;
        const reach = square ? Math.max(dx, dy) : Math.hypot(dx, dy);
        if (reach <= from || reach >= to) continue;
        const i = (y * canvas.width + x) * 4;
        sum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3; count++;
      }
      return sum / count;
    };
    // Mean local contrast (brightness against its 9 x 9 pixel neighbourhood) between two square distances, in
    // metres at 40 pixels each, from the view centre.
    const contrast = (pixels: number[], from: number, to: number) => {
      const light = (x: number, y: number) => { const i = (y * canvas.width + x) * 4; return pixels[i]! + pixels[i + 1]! + pixels[i + 2]!; };
      let sum = 0, count = 0;
      for (let y = 4; y < canvas.height - 4; y++) for (let x = 4; x < canvas.width - 4; x++) {
        const reach = Math.max(Math.abs(x + 0.5 - canvas.width / 2), Math.abs(y + 0.5 - canvas.height / 2)) / 40;
        if (reach <= from || reach >= to) continue;
        let mean = 0;
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mean += light(x + dx, y + dy);
        sum += Math.abs(light(x, y) - mean / 81) / 3; count++;
      }
      return sum / count;
    };
    const contact: Record<string, { ring: number; open: number; crest: { inner: number; outer: number }; trough: { inner: number; outer: number } }> = {};
    const ripples: Record<string, { near: number; open: number }> = {};
    for (const style of ["realistic", "stylized"] as const) {
      const water = { ...createDefaultWaterDefinition(style), sparkles: 0 };
      const body = normalizeWaterBody({ width: 28, length: 24, waveScale: 1 });
      place("perspective");
      const lake = createWaterMesh(scene, "contact-lake", body, water);
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      camera.setTarget(Vector3.Zero(), false, false, true);
      camera.alpha = -Math.PI / 2 + 0.35; camera.beta = 1.05; camera.radius = 9;
      for (const [phase, time] of [["a", 2.2], ["b", 4.1]] as const) {
        setSceneWaterTime(scene, time);
        evidence[`${style}-contact-${phase}`] = (await capture()).png;
      }
      lake.dispose();
      // Top-down, the post's waterline ring must outshine open water beyond its foam and ripples.
      place("post");
      const flat = createWaterMesh(scene, "contact-top", body, water);
      topDown();
      setSceneWaterTime(scene, 2.2);
      const shot = await capture();
      evidence[`${style}-contact-top`] = shot.png;
      const ring = band(shot.pixels, 0.56, 0.7, true), open = band(shot.pixels, 2.2, 2.45, true);
      flat.dispose();
      // Small waves travel out from the post. Realistic, with its foam off: an overhead sun mirrored by a calm, flat
      // lake lights it evenly, and only the ripples break that reflection into rings near the post. Stylized draws
      // them as broken toon rings beyond the post's foam collar.
      const realistic = style === "realistic";
      const calmLake = createWaterMesh(scene, "contact-ripples", normalizeWaterBody({ width: 28, length: 24, waveScale: 0 }),
        realistic ? { ...water, foamAmount: 0, rippleStrength: 0 } : { ...water, surfaceFoam: 0 });
      const sunDirection = sun.direction.clone();
      if (realistic) sun.direction = new Vector3(0, -1, 0);
      // A distant eye keeps the view direction, and so the mirrored sun, the same across the view.
      const radiusLimit = camera.upperRadiusLimit;
      camera.upperRadiusLimit = null;
      camera.orthoLeft = -8; camera.orthoRight = 8; camera.orthoTop = 5; camera.orthoBottom = -5; camera.radius = 200;
      const rippled = await capture();
      camera.upperRadiusLimit = radiusLimit;
      evidence[`${style}-contact-ripples`] = rippled.png;
      const contactWidth = water.contactFoamWidth;
      ripples[style] = { near: contrast(rippled.pixels, 0.5 + contactWidth * (realistic ? 0.5 : 0.8), 0.5 + contactWidth * 1.5), open: contrast(rippled.pixels, 4.2, 4.9) };
      sun.direction = sunDirection;
      calmLake.dispose();
      topDown();
      // Long, tall swell lifts the water around the spire almost uniformly: its foam ring must follow
      // the rendered height inward at a crest and outward in a trough, without rebuilding contacts.
      place("spire");
      // Vertical-only swell (Steepness 0) isolates the waterline's height response.
      const swell = { ...water, waveHeight: 1.2, waveLength: 100, choppiness: 0, steepness: 0, crestFoam: 0 };
      const heights = Array.from({ length: 80 }, (_, i) => ({ time: i * 0.25, height: sampleWaterSurface(swell, body, { x: 0, y: 0, z: 0 }, i * 0.25).height }));
      const high = heights.reduce((a, b) => a.height > b.height ? a : b), low = heights.reduce((a, b) => a.height < b.height ? a : b);
      const rising = createWaterMesh(scene, "contact-swell", body, swell);
      const measure = async (time: number, name: string) => {
        setSceneWaterTime(scene, time);
        const frame = await capture();
        evidence[`${style}-spire-${name}`] = frame.png;
        const inner = (3 - high.height) / 2, outer = (3 - low.height) / 2;
        return { inner: band(frame.pixels, inner + 0.05, inner + 0.3), outer: band(frame.pixels, outer + 0.05, outer + 0.3) };
      };
      const crest = await measure(high.time, "crest"), trough = await measure(low.time, "trough");
      rising.dispose();
      contact[style] = { ring, open, crest, trough };
    }
    // Clear water still mirrors the sky: over a black floor, a clear realistic lake seen at a low angle
    // is lit by its reflection alone, which blending must not scale away with the water's low coverage.
    spire.isVisible = post.isVisible = cone.isVisible = false;
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.setTarget(Vector3.Zero(), false, false, true);
    camera.alpha = -Math.PI / 2; camera.beta = 1.32; camera.radius = 18;
    const floor = MeshBuilder.CreateGround("clear-floor", { width: 60, height: 60 }, scene);
    const black = new StandardMaterial("clear-floor", scene);
    black.diffuseColor = Color3.Black(); black.specularColor = Color3.Black(); black.disableLighting = true;
    floor.material = black; floor.position.y = -0.6;
    setSceneWaterTime(scene, 2.2);
    const bare = await capture();
    const clear = createWaterMesh(scene, "clear-lake", normalizeWaterBody({ width: 40, length: 40, waveScale: 0.3, depth: 0.6 }),
      { ...createDefaultWaterDefinition("realistic"), depthColorDistance: 1000, foamAmount: 0, sparkles: 0 });
    const mirrored = await capture();
    evidence["realistic-clear-reflection"] = mirrored.png;
    const clearReflection = { floor: centreLight(bare.pixels), water: centreLight(mirrored.pixels) };
    clear.dispose(); floor.dispose(); black.dispose();
    post.dispose(); cone.dispose(); spire.dispose(); dark.dispose();
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.setTarget(Vector3.Zero(), false, false, true);
    camera.alpha = -Math.PI / 2; camera.beta = 1.03; camera.radius = 24;
    // A hidden landscape still supplies the water field. The visible crest must
    // cross its elevated floor, while a trough reveals the unchanged background.
    for (const mesh of scene.meshes) mesh.isVisible = false;
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -4; camera.orthoRight = 4; camera.orthoTop = 2.5; camera.orthoBottom = -2.5;
    camera.beta = 0.01; camera.radius = 24;
    camera.setTarget(Vector3.Zero(), false, false, true);
    const terrain = createLandscapeMesh(scene, "wave-floor", { width: 20, depth: 20, subdivisions: 8, heights: Array(81).fill(0.6) });
    for (const mesh of terrain.getChildMeshes()) mesh.isVisible = false;
    const empty = await capture();
    const definition = { ...createDefaultWaterDefinition("stylized"), waveHeight: 4, waveLength: 100, choppiness: 0, steepness: 0,
      foamAmount: 0, sparkles: 0, reflectionStrength: 0, opacity: 1 };
    const body = normalizeWaterBody({ width: 20, length: 20 }, "ocean");
    const samples = Array.from({ length: 80 }, (_, i) => ({ time: i * 0.25,
      height: sampleWaterSurface(definition, body, { x: 0, y: 0, z: 0 }, i * 0.25).height }));
    const crest = samples.reduce((a, b) => a.height > b.height ? a : b);
    const trough = samples.reduce((a, b) => a.height < b.height ? a : b);
    const water = createWaterMesh(scene, "wave-terrain", body, definition);
    const difference = (pixels: number[]) => {
      let sum = 0;
      for (let y = 195; y < 205; y++) for (let x = 315; x < 325; x++) for (let c = 0; c < 3; c++) {
        const i = (y * canvas.width + x) * 4 + c;
        sum += Math.abs(pixels[i]! - empty.pixels[i]!);
      }
      return sum / 300;
    };
    setSceneWaterTime(scene, crest.time);
    const high = await capture();
    setSceneWaterTime(scene, trough.time);
    const low = await capture();
    evidence["terrain-crest"] = high.png; evidence["terrain-trough"] = low.png;
    const waveTerrain = { crestHeight: crest.height, troughHeight: trough.height,
      crestDifference: difference(high.pixels), troughDifference: difference(low.pixels) };
    water.dispose(); terrain.dispose();
    const landscapeEdge = await measureLandscapeEdge(scene, camera, capture, canvas, evidence);
    const vertexParity = await measureVertexParity(scene, camera, capture, backend, canvas, evidence);
    return { evidence, differences, brightness, crowded, pan, whitecaps, surfaceFoam, gerstner, subsurface, clearReflection, waveTerrain, contact, ripples, landscapeEdge, vertexParity };
  } finally {
    const device = (engine as { _device?: { queue: { onSubmittedWorkDone(): Promise<void> } } })._device;
    engine.flushFramebuffer(); await device?.queue.onSubmittedWorkDone();
    host.dispose(); await host.whenReleased(); engine.dispose(); canvas.remove();
  }
}

/** One captured view of built-in water: what the water is, what meets it and where the camera and sun are. */
export interface WaterTierView {
  name: string;
  style: "realistic" | "stylized";
  /** Asset overrides on the style's defaults. */
  water?: Partial<WaterDefinition>;
  kind?: WaterKind;
  body?: Record<string, unknown>;
  camera: { alpha: number; beta: number; radius: number; target?: [number, number, number] };
  /** Sun light direction (pointing from the sun); the proof's default sun otherwise. */
  sun?: [number, number, number];
  /** A 90 m landscape island whose edges lie 4 m under the water. */
  island?: boolean;
  /** Metres the island is raised: above 4 its edges stand above the water. */
  islandLift?: number;
  /** Keep the island in the water's terrain field but do not draw it, so only water shading shows its edge. */
  hideIsland?: boolean;
  /** Posts and a buoy crossing the surface. */
  objects?: boolean;
  /** Four extra point lights over the water (seven lights with the preview's own). */
  lamps?: boolean;
  time?: number;
}

/** Built-in water at every project Water Shading Detail: the CI views, unless `views` are given. */
const TIER_VIEWS: readonly WaterTierView[] = (["realistic", "stylized"] as const).flatMap((style) => [
  { name: `${style}-lake`, style, body: { width: 28, length: 24, waveScale: 1 }, camera: { alpha: -Math.PI / 2, beta: 1.03, radius: 24 } },
  { name: `${style}-lake-seven-lights`, style, body: { width: 28, length: 24, waveScale: 1 }, lamps: true, camera: { alpha: -Math.PI / 2, beta: 1.03, radius: 24 } },
  {
    name: `${style}-open-sea`, style, kind: "ocean" as const, body: { width: 300, length: 300 },
    water: { waveHeight: 1.2, waveLength: 22, choppiness: 0.7, crestFoam: 0.8, surfaceFoam: 1, sparkles: 0.4 },
    camera: { alpha: -Math.PI / 2 - 0.6, beta: 1.2, radius: 30 },
  },
]);

/**
 * Pixels read back from either backend as a PNG data URL (a WebGPU canvas cannot be re-encoded after presenting).
 * WebGL reads rows bottom-up; a WebGPU canvas in its preferred BGRA format reads blue first.
 */
function pixelsToPng(pixels: ArrayLike<number>, width: number, height: number, backend: "webgl2" | "webgpu"): string {
  const out = document.createElement("canvas");
  out.width = width; out.height = height;
  const context = out.getContext("2d")!, image = context.createImageData(width, height), stride = width * 4;
  const gpu = (navigator as { gpu?: { getPreferredCanvasFormat?: () => string } }).gpu;
  const swap = backend === "webgpu" && gpu?.getPreferredCanvasFormat?.() === "bgra8unorm" ? [2, 0, -2, 0] : [0, 0, 0, 0];
  for (let row = 0; row < height; row++) {
    const source = (backend === "webgl2" ? height - 1 - row : row) * stride;
    for (let i = 0; i < stride; i++) image.data[row * stride + i] = pixels[source + i + swap[i % 4]!]!;
  }
  context.putImageData(image, 0, 0);
  return out.toDataURL("image/png");
}

/**
 * Captures built-in water at each project Water Shading Detail (`SLATE_WATER_QUALITY` 0-3) for every view: each tier
 * compiles its own shader variant, so a variant that fails to compile, or compiles but draws black, shows here on the
 * backend that runs it. Returns each capture's mean brightness over the lower two thirds (the water) and its evidence.
 */
export async function runWaterTierProof(backend: "webgl2" | "webgpu", options: { views?: readonly WaterTierView[]; tiers?: readonly WaterShadingDetail[]; width?: number; height?: number } = {}) {
  const width = options.width ?? 480, height = options.height ?? 300;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  const host = createParticlePreviewScene(engine, { skybox: true });
  const { scene, camera } = host;
  const sun = new DirectionalLight("sun", new Vector3(-0.3, -1, 0.6), scene);
  sun.intensity = 1.4;
  const defaultSun = sun.direction.clone();
  camera.maxZ = 2000;
  camera.upperRadiusLimit = null;
  for (const mesh of scene.meshes) if (mesh.metadata?.skybox) mesh.infiniteDistance = true;
  const capture = async () => {
    await scene.whenReadyAsync();
    camera.getViewMatrix(true);
    updateSceneWater(scene);
    await scene.whenReadyAsync();
    engine.beginFrame();
    try {
      scene.render();
      const raw = await engine.readPixels(0, 0, width, height);
      if (!raw) throw new Error("Missing water pixels");
      return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } finally { engine.endFrame(); }
  };
  // Mean brightness of the lower two thirds of the view: WebGL reads pixels bottom-up, WebGPU top-down.
  const rows = backend === "webgl2" ? [0, Math.ceil(height * 2 / 3)] : [Math.floor(height / 3), height];
  const waterLight = (pixels: Uint8Array) => {
    let sum = 0, count = 0;
    for (let y = rows[0]!; y < rows[1]!; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      sum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3; count++;
    }
    return sum / count;
  };
  const island = (() => {
    const side = 45, heights: number[] = [];
    for (let z = 0; z <= side; z++) for (let x = 0; x <= side; x++) {
      const u = x / side * 90 - 45, v = z / side * 90 - 45, r = Math.hypot(u * 1.1, v * 0.9);
      heights.push(7.5 * Math.exp(-((r / 24) ** 2)) - 4 + 0.6 * Math.sin(u * 0.21) * Math.cos(v * 0.17));
    }
    return { width: 90, depth: 90, subdivisions: side, heights };
  })();
  // Mean per-channel difference between two captures over the same lower two thirds.
  const change = (a: Uint8Array, b: Uint8Array) => {
    let sum = 0, count = 0;
    for (let y = rows[0]!; y < rows[1]!; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
      const i = (y * width + x) * 4 + c;
      sum += Math.abs(a[i]! - b[i]!); count++;
    }
    return sum / count;
  };
  const dark = new StandardMaterial("tier-objects", scene);
  dark.diffuseColor = new Color3(0.35, 0.28, 0.22);
  const quality = sceneRenderingSettings(scene).project.quality;
  const captures: Array<{ tier: WaterShadingDetail; view: string; light: number; water: number }> = [];
  // Per view, how much the Low capture differs from the High one.
  const lowToHigh: Record<string, number> = {};
  const evidence: Record<string, string> = {};
  try {
    for (const view of options.views ?? TIER_VIEWS) {
      const extras: Array<{ dispose(): void }> = [];
      if (view.island) {
        const landscape = createLandscapeMesh(scene, "tier-island", { ...island, heights: island.heights.map((h) => h + (view.islandLift ?? 0)) });
        if (view.hideIsland) for (const chunk of landscape.getChildMeshes()) chunk.isVisible = false;
        extras.push(landscape);
      }
      if (view.objects) {
        const posts = [[-3, 0, 2], [2.5, 0, -1], [6, 0, 4]].map(([x, y, z], i) => {
          const post = MeshBuilder.CreateBox(`tier-post-${i}`, { width: 0.8, height: 5, depth: 0.8 }, scene);
          post.position.set(x!, y!, z!); post.material = dark;
          return post;
        });
        const buoy = MeshBuilder.CreateSphere("tier-buoy", { diameter: 2.4, segments: 24 }, scene);
        buoy.position.set(-0.5, 0.2, -4); buoy.material = dark;
        extras.push(...posts, buoy);
      }
      if (view.lamps) {
        extras.push(...[-6, -2, 2, 6].map((x, i) => {
          const lamp = new PointLight(`tier-lamp-${i}`, new Vector3(x, 3, -4), scene);
          lamp.intensity = 0.2;
          return lamp;
        }));
      }
      // Placement settles before the water builds its contact field.
      for (const extra of extras) if (extra instanceof AbstractMesh) extra.computeWorldMatrix(true);
      sun.direction = view.sun ? new Vector3(...view.sun) : defaultSun.clone();
      camera.mode = Camera.PERSPECTIVE_CAMERA;
      camera.setTarget(new Vector3(...(view.camera.target ?? [0, 0, 0])), false, false, true);
      camera.alpha = view.camera.alpha; camera.beta = view.camera.beta; camera.radius = view.camera.radius;
      setSceneWaterTime(scene, view.time ?? 1.7);
      // Landscapes draw in the world rendering group; objects and water join it so depth sorts them together.
      for (const extra of extras) if (extra instanceof AbstractMesh) extra.renderingGroupId = RENDERING_GROUP.world;
      // The same view without water: every tier must draw water over it. Captures are copied, since a readback buffer
      // may be reused by the next one.
      const bare = (await capture()).slice();
      const definition = { ...createDefaultWaterDefinition(view.style), ...view.water };
      const water = createWaterMesh(scene, `tier-${view.name}`, normalizeWaterBody(view.body ?? {}, view.kind ?? "lake"), definition);
      water.renderingGroupId = RENDERING_GROUP.world;
      if (view.lamps) (water.material as PBRMaterial).maxSimultaneousLights = 8;
      const shots = new Map<WaterShadingDetail, Uint8Array>();
      for (const tier of options.tiers ?? WATER_SHADING_DETAILS) {
        updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(tier)) });
        const pixels = (await capture()).slice();
        shots.set(tier, pixels);
        captures.push({ tier, view: view.name, light: waterLight(pixels), water: change(pixels, bare) });
        evidence[`tier-${tier}-${view.name}`] = pixelsToPng(pixels, width, height, backend);
      }
      const low = shots.get("low"), high = shots.get("high");
      if (low && high) lowToHigh[view.name] = change(low, high);
      water.dispose();
      for (const extra of extras) extra.dispose();
    }
    return { captures, lowToHigh, evidence };
  } finally {
    updateSceneRenderingSettings(scene, { quality });
    const device = (engine as { _device?: { queue: { onSubmittedWorkDone(): Promise<void> } } })._device;
    engine.flushFramebuffer(); await device?.queue.onSubmittedWorkDone();
    host.dispose(); await host.whenReleased(); engine.dispose(); canvas.remove();
  }
}

/** Where an eye sees `point` mirrored in the plane y = planeY: the eye-to-reflected-point ray meets the plane. */
function mirroredOnPlane(eye: Vector3, point: Vector3, planeY: number): Vector3 {
  const reflected = new Vector3(point.x, 2 * planeY - point.y, point.z);
  return Vector3.Lerp(eye, reflected, (eye.y - planeY) / (eye.y - reflected.y));
}

/** Quality for a preset, optionally with some Water fields overridden (a custom Water selection). */
function waterQualityPatch(level: QualityLevel, water: Partial<WaterQuality> = {}) {
  const quality = normalizeRenderingQuality(qualityPresetPatch(level));
  return Object.keys(water).length ? { ...quality, water: { ...quality.water, ...water, preset: "custom" as const } } : quality;
}

/**
 * Built-in water drawn the way views draw it: through SceneRenderCoordinator (Forward FrameGraph, the scene copy and
 * planar reflections), on an app-like engine (large-world rendering, exact sRGB) with the default sky. Proves:
 * - Refraction: a coloured box under the surface, in the lower part of the view, shows through refracted water where
 *   it lies and not at the vertically mirrored rows (a flipped copy lookup would swap them), and the refracted floor
 *   moves with the waves' normals (it does not with Refraction 0), also in a distant orthographic view.
 * - Screen-space reflections: a bright beacon above calm water appears at its mirrored screen position with Screen
 *   Space reflections and Object Reflections on, and not with Sky Only. Its reflection covers the rows of the
 *   beacon's mirrored front face, and every other row the planar mirror fills either reflects the beacon or keeps the
 *   sky: no seam of background colour.
 * - Planar reflections at Ultra: the same known hit, and a beacon above the top of the view (which no screen-space
 *   march can find) still reflects.
 * - Every Water Shading Detail in both styles still draws lit water with its copy and reflection features on, and
 *   Ultra Realistic's largest variant (refraction, march and planar mirror) compiles and lights with seven lights.
 * - Scene Linear: refraction over a background brighter than 1 blends through the shore fade like Refraction 0
 *   does, with no dark contour.
 * Pixels are top-down RGBA; evidence PNGs are the captures.
 */
export async function runWaterObjectProof(backend: "webgl2" | "webgpu", options: { tiers?: readonly WaterShadingDetail[] } = {}) {
  const width = 480, height = 300;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true, useExactSrgbConversions: true,
  });
  const scene = new Scene(engine);
  let coordinator: SceneRenderCoordinator | undefined;
  const evidence: Record<string, string> = {};
  try {
    // Play and the editor share one depth buffer across rendering groups (the scene copy requires it).
    for (let group = 0; group < 4; group += 1) scene.setRenderingAutoClearDepthStencil(group, false);
    scene.clearColor = new Color4(0.3, 0.55, 0.85, 1);
    installPreviewEnvironment(scene);
    const sky = new HemisphericLight("sky", Vector3.Up(), scene);
    sky.intensity = 0.7;
    const sun = new DirectionalLight("sun", new Vector3(-0.3, -1, 0.6), scene);
    sun.intensity = 1.2;
    const camera = new FreeCamera("camera", new Vector3(0, 7, -9), scene);
    camera.minZ = 0.1; camera.maxZ = 600;
    scene.activeCamera = camera;
    const unlit = (name: string, color: Color3) => {
      const material = new StandardMaterial(name, scene);
      material.disableLighting = true;
      material.emissiveColor = color;
      return material;
    };
    // A striped floor 1.2 m under the water, and a green box whose top lies 0.3 m under the surface.
    const floor: Mesh[] = [];
    const light = unlit("strip-light", new Color3(0.85, 0.8, 0.7)), dark = unlit("strip-dark", new Color3(0.12, 0.16, 0.26));
    for (let i = 0; i < 24; i += 1) {
      const strip = MeshBuilder.CreateGround(`strip-${i}`, { width: 1, height: 40 }, scene);
      strip.position.set(-12 + i + 0.5, -1.2, 6);
      strip.material = i % 2 ? dark : light;
      floor.push(strip);
    }
    const box = MeshBuilder.CreateBox("submerged", { width: 2.5, height: 0.6, depth: 2.5 }, scene);
    box.position.set(2.5, -0.6, -0.5);
    box.material = unlit("submerged", new Color3(0.1, 0.85, 0.2));
    // A bright beacon above the water.
    const beaconSize = 2.4;
    const beacon = MeshBuilder.CreateBox("beacon", { size: beaconSize }, scene);
    beacon.material = unlit("beacon", new Color3(1, 0.85, 0.05));
    beacon.isVisible = false;
    coordinator = new SceneRenderCoordinator(scene);
    const view = coordinator;
    const order = readbackChannelOrder(engine.isWebGPU);
    const sleep = () => new Promise((resolve) => setTimeout(resolve, 16));
    /** Renders through the coordinator until `frames` graph frames have drawn, then reads the last one top-down. */
    const capture = async (name?: string, frames = 6) => {
      let drawn = 0;
      const results: unknown[] = [];
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        if (!view.isReady()) { await sleep(); continue; }
        engine.beginFrame();
        let result: ReturnType<SceneRenderCoordinator["render"]>;
        try { result = view.render(); } finally { engine.endFrame(); }
        results.push({ path: result.path, rendered: result.rendered });
        if (result.rendered && result.path === "frameGraph" && ++drawn >= frames) {
          // Read this frame before a later frame replaces WebGPU's canvas texture.
          const raw = await engine.readPixels(0, 0, width, height);
          const rgba = toRgbaPixels(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), order);
          const pixels = new Array<number>(rgba.length), stride = width * 4;
          for (let row = 0; row < height; row++) {
            const source = (engine.isWebGPU ? row : height - 1 - row) * stride;
            for (let i = 0; i < stride; i++) pixels[row * stride + i] = rgba[source + i]!;
          }
          if (name) {
            const out = document.createElement("canvas");
            out.width = width; out.height = height;
            const context = out.getContext("2d")!, image = context.createImageData(width, height);
            image.data.set(pixels);
            context.putImageData(image, 0, 0);
            evidence[name] = out.toDataURL("image/png");
          }
          return pixels;
        }
        await sleep();
      }
      throw new Error(`The coordinated water view never drew: ${JSON.stringify(results.slice(-4))}`);
    };
    /** Mean RGB over a square of `radius` pixels around a top-down pixel position. */
    const around = (pixels: number[], x: number, y: number, radius = 3) => {
      const sum = [0, 0, 0];
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const px = Math.round(x) + dx, py = Math.round(y) + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const i = (py * width + px) * 4;
        for (let c = 0; c < 3; c++) sum[c] += pixels[i + c]!;
        count++;
      }
      return sum.map((value) => value / Math.max(1, count)) as [number, number, number];
    };
    /** Top-down pixel of a world point in the current camera. */
    const pixelOf = (point: Vector3) => {
      camera.getViewMatrix(true);
      const ndc = Vector3.TransformCoordinates(point, camera.getViewMatrix().multiply(camera.getProjectionMatrix()));
      return { x: (0.5 + 0.5 * ndc.x) * width, y: (0.5 - 0.5 * ndc.y) * height, ndcY: ndc.y };
    };
    /** Mean per-channel difference over a rectangle of rows and columns (fractions of the view). */
    const change = (a: number[], b: number[], [x0, x1, y0, y1] = [0, 1, 0, 1]) => {
      let sum = 0, count = 0;
      for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
        for (let c = 0; c < 3; c++) { const i = (y * width + x) * 4 + c; sum += Math.abs(a[i]! - b[i]!); count++; }
      }
      return sum / Math.max(1, count);
    };
    const meanLight = (pixels: number[], [y0, y1] = [0.4, 1]) => {
      let sum = 0, count = 0;
      for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        sum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3; count++;
      }
      return sum / count;
    };
    const yellow = ([r, g, b]: readonly number[]) => (r! + g!) / 2 - b!;
    const green = ([r, g, b]: readonly number[]) => g! - (r! + b!) / 2;
    /** Effect defines of every variant `mesh` compiled (one per render pass that drew it). */
    const variants = (mesh: AbstractMesh) => (mesh.subMeshes[0] as unknown as { _drawWrappers: Array<{ effect?: { defines?: string } | null } | undefined> })
      ._drawWrappers.map((wrapper) => wrapper?.effect?.defines ?? "").filter(Boolean);
    const compiles = (mesh: AbstractMesh, ...defines: string[]) => variants(mesh).some((source) => defines.every((define) => source.includes(`#define ${define}\n`)));
    const quiet = { foamAmount: 0, crestFoam: 0, surfaceFoam: 0, sparkles: 0 };
    const lakeBody = (waveScale: number) => normalizeWaterBody({ width: 24, length: 24, depth: 1.5, waveScale });
    const graphTasks: Record<string, string[]> = {};

    // Refraction (High): the box and the floor under clear water, Refraction on and 0 (the blended surface).
    setSceneRenderSettings(scene, { quality: waterQualityPatch("high") });
    camera.position.set(0, 7, -9); camera.setTarget(new Vector3(0, -0.6, 4));
    const clear = { ...createDefaultWaterDefinition("realistic"), ...quiet, depthColorDistance: 8, objectReflections: false };
    const bare = await capture("refraction-bare");
    // The box lies in the lower part of the view; the rows mirrored about the view's centre show only the floor.
    const boxPixel = pixelOf(new Vector3(box.position.x, 0, box.position.z));
    const flipped = { x: boxPixel.x, y: height - boxPixel.y };
    const refraction = {} as Record<"on" | "off", {
      calm: number; calmNoBox: number; flipped: number; flippedNoBox: number; boxGreen: number; motion: number; compiled: boolean;
    }>;
    const motion = (first: number[], second: number[]) => change(first, second, [0.15, 0.85, 0.45, 0.95]);
    for (const mode of ["on", "off"] as const) {
      const definition = { ...clear, refraction: mode === "on" ? 0.35 : 0 };
      const calmLake = createWaterMesh(scene, `refraction-${mode}-calm`, lakeBody(0), { ...definition, rippleStrength: 0 });
      setSceneWaterTime(scene, 1);
      const calm = await capture(`refraction-${mode}-calm`);
      graphTasks[`refraction-${mode}`] = view.taskNames();
      const compiled = compiles(calmLake, "SLATE_WATER_REFRACTION");
      box.isVisible = false;
      const calmNoBox = await capture();
      box.isVisible = true;
      calmLake.dispose();
      const wavy = createWaterMesh(scene, `refraction-${mode}-waves`, lakeBody(1), definition);
      setSceneWaterTime(scene, 1);
      const first = await capture(`refraction-${mode}-waves-a`);
      setSceneWaterTime(scene, 1.7);
      const second = await capture(`refraction-${mode}-waves-b`);
      wavy.dispose();
      refraction[mode] = {
        calm: green(around(calm, boxPixel.x, boxPixel.y, 6)), calmNoBox: green(around(calmNoBox, boxPixel.x, boxPixel.y, 6)),
        flipped: green(around(calm, flipped.x, flipped.y, 6)), flippedNoBox: green(around(calmNoBox, flipped.x, flipped.y, 6)),
        boxGreen: green(around(bare, boxPixel.x, boxPixel.y, 6)),
        // How much the water over the floor changes between two wave phases (rows of the lake).
        motion: motion(first, second), compiled,
      };
    }

    // Refraction in a distant orthographic view (an isometric-style camera 60 m away): the bend is the same
    // view-space amount at every distance, so the floor still moves with the waves.
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -8; camera.orthoRight = 8; camera.orthoBottom = -5; camera.orthoTop = 5;
    const isoTarget = new Vector3(0, -0.6, 3), pitch = 35 * Math.PI / 180;
    camera.position.copyFrom(isoTarget.add(new Vector3(0, Math.sin(pitch), -Math.cos(pitch)).scale(60)));
    camera.setTarget(isoTarget);
    const orthographic = {} as Record<"on" | "off", { motion: number; compiled: boolean }>;
    for (const mode of ["on", "off"] as const) {
      const wavy = createWaterMesh(scene, `ortho-${mode}`, lakeBody(1), { ...clear, refraction: mode === "on" ? 0.35 : 0 });
      setSceneWaterTime(scene, 1);
      const first = await capture(`refraction-ortho-${mode}-a`);
      setSceneWaterTime(scene, 1.7);
      const second = await capture(`refraction-ortho-${mode}-b`);
      orthographic[mode] = { motion: motion(first, second), compiled: compiles(wavy, "SLATE_WATER_REFRACTION") };
      wavy.dispose();
    }
    camera.mode = Camera.PERSPECTIVE_CAMERA;

    // Reflections: calm, dark water in front of a beacon standing above it.
    beacon.isVisible = true;
    for (const mesh of [...floor, box]) mesh.isVisible = false;
    const mirror = { ...createDefaultWaterDefinition("realistic"), ...quiet, rippleStrength: 0, depthColorDistance: 0.5, objectReflections: true, reflectionStrength: 1 };
    const reflectionLake = createWaterMesh(scene, "reflection-lake", normalizeWaterBody({ width: 60, length: 60, depth: 4, waveScale: 0 }), mirror);
    setSceneWaterTime(scene, 1);
    /** Rows (from `top` down) of the longest run where the column around `x` reads as the beacon. */
    const beaconRun = (pixels: number[], x: number, top: number) => {
      let best: [number, number] | null = null, start = -1;
      for (let y = Math.max(0, Math.ceil(top)); y <= height; y++) {
        const on = y < height && yellow(around(pixels, x, y, 0)) > 20 && yellow(around(pixels, x - 2, y, 0)) > 20 && yellow(around(pixels, x + 2, y, 0)) > 20;
        if (on && start < 0) start = y;
        if (!on && start >= 0) {
          if (!best || y - 1 - start > best[1] - best[0]) best = [start, y - 1];
          start = -1;
        }
      }
      return best;
    };
    const reflectionCase = async (name: string, beaconAt: Vector3, eye: Vector3, target: Vector3) => {
      beacon.position.copyFrom(beaconAt);
      beacon.computeWorldMatrix(true);
      camera.position.copyFrom(eye); camera.setTarget(target);
      const hit = pixelOf(mirroredOnPlane(eye, beaconAt, 0)), direct = pixelOf(beaconAt);
      // The beacon's front face (the one the view sees) mirrored in the water: its lower edge reflects nearest the
      // horizon, its upper edge lowest on screen.
      const half = beaconSize / 2, face = beaconAt.z - half;
      // Reflections lie below the beacon's own lower edge on screen.
      const below = pixelOf(new Vector3(beaconAt.x, beaconAt.y - half, face)).y + 1;
      const front = [mirroredOnPlane(eye, new Vector3(beaconAt.x, beaconAt.y - half, face), 0), mirroredOnPlane(eye, new Vector3(beaconAt.x, beaconAt.y + half, face), 0)]
        .map((point) => pixelOf(point).y);
      const shots: Record<string, number> = {}, pixels: Record<string, number[]> = {};
      for (const [mode, patch] of [
        ["sky", waterQualityPatch("high", { reflections: "sky" })], ["screenSpace", waterQualityPatch("high")], ["planar", waterQualityPatch("ultra")],
      ] as const) {
        setSceneRenderSettings(scene, { quality: patch });
        pixels[mode] = await capture(`${name}-${mode}`);
        graphTasks[`${name}-${mode}`] = view.taskNames();
        shots[mode] = yellow(around(pixels[mode], hit.x, hit.y));
      }
      // Row extent at the beacon's column: how much of the mirrored front face the march reflects, and how many rows
      // the planar mirror fills where the march shows neither the beacon nor the Sky Only colour (a seam).
      const screenSpace = beaconRun(pixels.screenSpace!, hit.x, below), planar = beaconRun(pixels.planar!, hit.x, below);
      const [faceTop, faceBottom] = [Math.ceil(front[0]!), Math.floor(front[1]!)];
      let covered = 0, seam = 0;
      for (let y = faceTop; y <= faceBottom; y++) if (yellow(around(pixels.screenSpace!, hit.x, y, 0)) > 20) covered++;
      if (planar) for (let y = Math.max(0, planar[0] - 3); y <= Math.min(height - 1, planar[1] + 3); y++) {
        const marched = around(pixels.screenSpace!, hit.x, y, 0), sky = around(pixels.sky!, hit.x, y, 0);
        if (yellow(marched) <= 20 && Math.max(...marched.map((value, c) => Math.abs(value - sky[c]!))) > 30) seam++;
      }
      return {
        ...shots, hit: [hit.x, hit.y], direct: [direct.x, direct.y], directNdcY: direct.ndcY, planarDiagnostics: waterPlanarReflectionDiagnostics(scene),
        extent: { front, screenSpace, planar, coverage: covered / Math.max(1, faceBottom - faceTop + 1), seam },
      };
    };
    // On screen: the march finds the beacon in the scene copy; the planar mirror draws it too.
    const onScreen = await reflectionCase("reflection-on-screen", new Vector3(0, 2.2, 10), new Vector3(0, 2.2, -10), new Vector3(0, 0.6, 8));
    // Above the top of a low view: only the planar mirror can reflect it.
    const offScreen = await reflectionCase("reflection-off-screen", new Vector3(0, 6, 14), new Vector3(0, 1, -6), new Vector3(0, -2.75, 8));
    reflectionLake.dispose();
    // At Ultra, a small flat pond that is not the view's dominant body (a large lake filling the lower left of the
    // view is) marches instead.
    const pond = createWaterMesh(scene, "reflection-pond", normalizeWaterBody({ width: 4, length: 4, depth: 4, waveScale: 0 }), mirror);
    const dominant = createWaterMesh(scene, "reflection-dominant", normalizeWaterBody({ width: 50, length: 50, depth: 4, waveScale: 0 }), mirror);
    dominant.position.set(-30, 0, 0);
    const nonDominant = await reflectionCase("reflection-non-dominant", new Vector3(0, 2.2, 10), new Vector3(0, 2.2, -10), new Vector3(0, 0.6, 8));
    // The body the view's planar reflection mirrored in the last render.
    const planarBody = waterPlanarReflectionForCamera(scene, camera)?.mesh.name ?? null;
    pond.dispose(); dominant.dispose();
    beacon.isVisible = false;

    // Every Water Shading Detail, both styles, with the copy and reflection features each tier runs.
    for (const mesh of [...floor, box]) mesh.isVisible = true;
    beacon.isVisible = true;
    beacon.position.set(-4, 1.6, 9);
    camera.position.set(0, 6, -11); camera.setTarget(new Vector3(0, -0.4, 5));
    const tiers: Array<{ tier: WaterShadingDetail; style: string; light: number; water: number; tasks: string[] }> = [];
    let sevenLights = { lights: 0, largestVariant: false, light: 0, water: 0, lamps: 0 };
    for (const style of ["realistic", "stylized"] as const) {
      setSceneRenderSettings(scene, { quality: waterQualityPatch("high") });
      const without = await capture();
      const lake = createWaterMesh(scene, `tier-${style}`, lakeBody(1), { ...createDefaultWaterDefinition(style), objectReflections: true });
      setSceneWaterTime(scene, 1.3);
      let ultra: number[] | null = null;
      for (const tier of options.tiers ?? WATER_SHADING_DETAILS) {
        setSceneRenderSettings(scene, { quality: waterQualityPatch(tier) });
        const pixels = await capture(`tier-${tier}-${style}`);
        if (tier === "ultra") ultra = pixels;
        tiers.push({ tier, style, light: meanLight(pixels), water: change(pixels, without, [0, 1, 0.4, 1]), tasks: view.taskNames() });
      }
      if (style === "realistic") {
        // The largest variant: Ultra's refraction, march and planar mirror under seven scene lights (the sky, the sun
        // and five lamps over the lake).
        const lamps = [-8, -4, 0, 4, 8].map((x, i) => {
          const lamp = new PointLight(`object-lamp-${i}`, new Vector3(x, 1.2, 0), scene);
          lamp.intensity = 12;
          lamp.diffuse = new Color3(1, 0.55, 0.3);
          return lamp;
        });
        (lake.material as PBRMaterial).maxSimultaneousLights = 8;
        setSceneRenderSettings(scene, { quality: waterQualityPatch("ultra") });
        const pixels = await capture("tier-ultra-realistic-seven-lights");
        sevenLights = {
          lights: scene.lights.length,
          // One compiled variant carries the seventh light slot together with every copy and reflection feature.
          largestVariant: compiles(lake, "LIGHT6", "SLATE_WATER_REFRACTION", "SLATE_WATER_SSR", "SLATE_WATER_PLANAR"),
          light: meanLight(pixels), water: change(pixels, without, [0, 1, 0.4, 1]),
          // The lamps light the water: the capture differs from Ultra without them.
          lamps: ultra ? change(pixels, ultra, [0, 1, 0.4, 1]) : 0,
        };
        for (const lamp of lamps) lamp.dispose();
      }
      lake.dispose();
    }

    // Scene Linear: a floor far brighter than 1 (linear 3, shown at exposure 0.3) under clear, calm water, seen across
    // the lake's edge. The shore fade must blend the refracted floor into the bare floor beyond the edge without a
    // dark contour, as the blended surface (Refraction 0) does. (Standard materials clamp emissive light at 1.)
    for (const mesh of [...floor, box, beacon]) mesh.isVisible = false;
    const bright = MeshBuilder.CreateGround("bright-floor", { width: 60, height: 60 }, scene);
    bright.position.set(0, -0.3, 0);
    const glow = new PBRMaterial("bright-floor", scene);
    glow.unlit = true;
    glow.albedoColor = Color3.Black();
    glow.emissiveColor = Color3.White();
    glow.emissiveIntensity = 3;
    bright.material = glow;
    setSceneRenderSettings(scene, {
      mode: "pbr", quality: waterQualityPatch("high"),
      effects: { ...DEFAULT_RENDER_EFFECTS, colorPipeline: { version: 1, mode: "sceneLinear" }, exposure: 0.3 },
    });
    camera.position.set(12, 2.5, 1.5); camera.setTarget(new Vector3(12, -0.3, 6));
    const glass = { ...clear, opacity: 0, depthColorDistance: 50, reflectionStrength: 0.2 };
    /** Per row of the lower view, how far the darkest pixel across the edge falls below the row's median. */
    const contour = (pixels: number[]) => {
      const dips: number[] = [];
      for (let y = Math.floor(0.55 * height); y < Math.floor(0.95 * height); y++) {
        const row: number[] = [];
        for (let x = Math.floor(0.2 * width); x < Math.floor(0.8 * width); x++) {
          const i = (y * width + x) * 4;
          row.push((pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3);
        }
        row.sort((a, b) => a - b);
        dips.push(row[row.length >> 1]! - row[0]!);
      }
      dips.sort((a, b) => a - b);
      return dips[dips.length >> 1]!;
    };
    const sceneLinear = {} as Record<"on" | "off", { contour: number; compiled: boolean; tasks: string[] }>;
    // The same view in scene fog: the floor seen through refracting water carries its own fog once, as blending
    // (Refraction 0) leaves it, so the two views match.
    const fogged = {} as Record<"on" | "off", { pixels: number[]; compiled: boolean }>;
    for (const mode of ["on", "off"] as const) {
      const lake = createWaterMesh(scene, `scene-linear-${mode}`, lakeBody(0), { ...glass, rippleStrength: 0, refraction: mode === "on" ? 0.35 : 0 });
      setSceneWaterTime(scene, 1);
      const pixels = await capture(`scene-linear-edge-${mode}`);
      sceneLinear[mode] = { contour: contour(pixels), compiled: compiles(lake, "SLATE_WATER_REFRACTION", "IMAGEPROCESSINGPOSTPROCESS"), tasks: view.taskNames() };
      scene.fogMode = Scene.FOGMODE_EXP2;
      scene.fogDensity = 0.08;
      scene.fogColor = new Color3(0.35, 0.45, 0.6);
      fogged[mode] = { pixels: await capture(`scene-linear-fog-${mode}`), compiled: compiles(lake, "SLATE_WATER_REFRACTION", "FOG") };
      scene.fogMode = Scene.FOGMODE_NONE;
      lake.dispose();
    }
    const fog = {
      compiled: fogged.on.compiled,
      // Mean difference over the lake (the left of the lower view), refraction against the blended surface.
      difference: change(fogged.on.pixels, fogged.off.pixels, [0, 0.3, 0.5, 1]),
    };
    bright.dispose();
    return { refraction, orthographic, onScreen, offScreen, nonDominant, planarBody, tiers, sevenLights, sceneLinear, fog, graphTasks, evidence };
  } finally {
    coordinator?.dispose();
    const device = (engine as { _device?: { queue: { onSubmittedWorkDone(): Promise<void> } } })._device;
    engine.flushFramebuffer(); await device?.queue.onSubmittedWorkDone();
    scene.dispose(); engine.dispose(); canvas.remove();
  }
}
