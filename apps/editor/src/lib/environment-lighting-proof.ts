import {
  Camera,
  Color3,
  Color4,
  Engine,
  EngineStore,
  Constants,
  FreeCamera,
  MeshBuilder,
  PBRMaterial,
  Scene,
  Vector3,
  Viewport,
  type Mesh,
  type NodeMaterial,
} from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
} from "@babylonslate/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  lowerMaterialDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import {
  ResourceCache,
  setSceneRenderSettings,
  compileMaterialPlan,
} from "@babylonslate/render";
import {
  applyEnvironmentLighting,
  isEnvironmentLightingReady,
} from "../../../../packages/render/src/environment-lighting";
import { isSceneFrameReady } from "../../../../packages/render/src/scene-perf";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

async function numericEnv(
  options: {
    width?: number;
    lodGenerationScale?: number;
    irradiance?: Record<string, number[]>;
    color?: (level: number, face: number) => readonly number[];
  } = {},
): Promise<Uint8Array> {
  const faces: Uint8Array[] = [];
  const width = options.width ?? 2;
  for (let size = width, level = 0; size >= 1; size /= 2, level++) {
    for (let face = 0; face < 6; face++) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d")!;
      const color = options.color?.(level, face) ?? [0, 255, 0];
      context.fillStyle = `rgb(${color.join(",")})`;
      context.fillRect(0, 0, size, size);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) =>
          value
            ? resolve(value)
            : reject(new Error("Numeric ENV PNG encoding failed.")),
        ),
      );
      const png = new Uint8Array(await blob.arrayBuffer());
      faces.push(png);
    }
  }
  let position = 0;
  const mipmaps = faces.map((face) => {
    const entry = { position, length: face.length };
    position += face.length;
    return entry;
  });
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      width,
      imageType: "image/png",
      irradiance: options.irradiance,
      specular: {
        mipmaps,
        lodGenerationScale: options.lodGenerationScale ?? 0.8,
      },
    }),
  );
  const bytes = new Uint8Array(9 + header.length + position);
  bytes.set([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]);
  bytes.set(header, 8);
  faces.forEach((face, index) =>
    bytes.set(face, 9 + header.length + mipmaps[index]!.position),
  );
  return bytes;
}

/** Test-build-only numerical raster proof. No production engine selection or UI. */
export async function runEnvironmentLightingProof() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const engine = new Engine(canvas, false, {
    preserveDrawingBuffer: true,
    useExactSrgbConversions: true,
  });
  const cache = new ResourceCache();
  const scenes: Scene[] = [];
  const compiled: Array<{ dispose(): void }> = [];
  const captures: Record<string, { pixel: number[]; png: string }> = {};
  let sharedUpload = false;
  let distinctViews = false;
  let optionalGraph:
    { sameBuild: boolean; frozen: boolean; noCubeBefore: boolean } | undefined;
  const started = performance.now();
  const settings = (
    mode: "pbr" | "cel",
    intensity = 1,
    rotationYDegrees = 0,
    celStrength = 0,
    enabled = true,
  ) => ({
    mode,
    environmentLighting: normalizeEnvironmentLightingSettings({
      enabled,
      intensity,
      rotationYDegrees,
      celStrength,
    }),
    cel: normalizeCelShadingSettings({
      shadowBands: 3,
      shadowStrength: 1,
      bandSoftness: 0,
      specularEnabled: false,
    }),
  });
  const wait = async (ready: () => boolean) => {
    while (!ready()) {
      if (performance.now() - started > 60_000)
        throw new Error("Environment pixel proof readiness timed out.");
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  };
  const compile = async (
    scene: Scene,
    doc: MaterialDocument,
    functions = {},
  ) => {
    const lowered = lowerMaterialDocument(doc, { functions });
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const result = compileMaterialPlan(lowered.plan, {
      scene,
      name: `proof${compiled.length}`,
    });
    if (result.ok === false)
      throw new Error(JSON.stringify(result.diagnostics));
    compiled.push(result);
    const errors = await result.ready;
    if (errors.length) throw new Error(JSON.stringify(errors));
    return result;
  };
  const create = () => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new FreeCamera("proof-camera", new Vector3(0, 0, -2), scene);
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = camera.orthoBottom = -1;
    camera.orthoRight = camera.orthoTop = 1;
    scene.activeCamera = camera;
    const mesh = MeshBuilder.CreatePlane("proof-surface", { size: 2 }, scene);
    scenes.push(scene);
    return { scene, mesh, camera };
  };
  const surface = () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes[0]!.properties = { value: [1, 1, 1] };
    doc.nodes.find((node) => node.type === "output.surface")!.properties = {
      "default:roughness": [1],
    };
    return doc;
  };
  const capture = async (name: string, scene: Scene, mesh: Mesh) => {
    await wait(
      () => isEnvironmentLightingReady(scene) && isSceneFrameReady(scene),
    );
    const material = mesh.material!;
    if ("buildIsInProgress" in material)
      await wait(() => !(material as NodeMaterial).buildIsInProgress);
    await material.forceCompilationAsync(mesh);
    await wait(() => isSceneFrameReady(scene));
    engine.restoreDefaultFramebuffer();
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    const bytes = await engine.readPixels(32, 32, 1, 1);
    captures[name] = {
      pixel: Array.from(
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ),
      png: canvas.toDataURL("image/png"),
    };
  };
  const assets = (guid: string, bytes: Uint8Array) => ({
    resourceCache: cache,
    textureBytes: new Map([[guid, bytes]]),
  });
  try {
    const green = buildFloatDdsCubeFixture({ color: [0, 1, 0, 1] });
    const a = create(),
      b = create();
    const native = new PBRMaterial("native-import-compatible", a.scene);
    native.albedoColor = Color3.White();
    native.metallic = 0;
    native.roughness = 1;
    a.mesh.material = native;
    const graph = (await compile(b.scene, surface())).material;
    b.mesh.material = graph;
    setSceneRenderSettings(b.scene, settings("pbr", 0.25));
    await capture("graph-before-environment", b.scene, b.mesh);
    graph.freeze();
    const initialBuildId = graph.buildId;
    const noCubeBefore =
      b.scene.environmentTexture === null &&
      !engine.getLoadedTexturesCache().some((texture) => texture.isCube);
    for (const entry of [a, b]) {
      setSceneRenderSettings(entry.scene, settings("pbr"));
      applyEnvironmentLighting(entry.scene, "green", assets("green", green));
    }
    sharedUpload =
      a.scene.environmentTexture!.getInternalTexture() ===
      b.scene.environmentTexture!.getInternalTexture();
    distinctViews = a.scene.environmentTexture !== b.scene.environmentTexture;
    setSceneRenderSettings(b.scene, settings("pbr", 0.25));
    await capture("graph-late-environment", b.scene, b.mesh);
    applyEnvironmentLighting(b.scene, null, assets("green", green));
    await capture("graph-removed-environment", b.scene, b.mesh);
    applyEnvironmentLighting(b.scene, "green", assets("green", green));
    await capture("graph-reassigned-environment", b.scene, b.mesh);
    optionalGraph = {
      sameBuild: graph.buildId === initialBuildId,
      frozen: graph.isFrozen,
      noCubeBefore,
    };
    for (const [name, entry] of [
      ["native", a],
      ["graph", b],
    ] as const) {
      for (const intensity of [0, 0.25, 0.5]) {
        setSceneRenderSettings(entry.scene, settings("pbr", intensity));
        await capture(`${name}-pbr-${intensity}`, entry.scene, entry.mesh);
      }
      for (const strength of [0, 0.2, 0.3, 0.7, 1]) {
        setSceneRenderSettings(entry.scene, settings("cel", 1, 0, strength));
        await capture(`${name}-cel-${strength}`, entry.scene, entry.mesh);
        entry.mesh.material!.freeze();
      }
    }
    const fallback = await numericEnv();
    const oriented = buildFloatDdsCubeFixture({ color: [0, 1, 0, 1] });
    const orientedData = new DataView(oriented.buffer);
    // Both X faces are red at every mip; both Z faces remain green.
    for (const face of [0, 1])
      for (let texel = 0; texel < 5; texel++)
        for (let channel = 0; channel < 4; channel++)
          orientedData.setFloat32(
            128 + face * 80 + texel * 16 + channel * 4,
            [1, 0, 0, 1][channel]!,
            true,
          );
    for (const [name, entry] of [
      ["native", a],
      ["graph", b],
    ] as const) {
      applyEnvironmentLighting(
        entry.scene,
        "fallback",
        assets("fallback", fallback),
      );
      setSceneRenderSettings(entry.scene, settings("pbr", 0.25));
      await capture(`${name}-env-fallback`, entry.scene, entry.mesh);
      applyEnvironmentLighting(
        entry.scene,
        "oriented",
        assets("oriented", oriented),
      );
      for (const rotation of [0, 90]) {
        setSceneRenderSettings(entry.scene, settings("pbr", 0.5, rotation));
        await capture(`${name}-oriented-${rotation}`, entry.scene, entry.mesh);
      }
    }
    // A full base-radiance CPU reference, with deliberately unrelated GGX mips.
    const referenceFaces = Array.from({ length: 6 }, (_, face) => {
      const pixels = new Float32Array(64 * 64 * 4);
      for (let i = 0; i < pixels.length; i += 4)
        pixels.set(face < 2 ? [1, 0, 0, 1] : [0, 1, 0, 1], i);
      return pixels;
    });
    const polynomial =
      CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
        size: 64,
        right: referenceFaces[0],
        left: referenceFaces[1],
        up: referenceFaces[2],
        down: referenceFaces[3],
        front: referenceFaces[4],
        back: referenceFaces[5],
        format: 5,
        type: 1,
        gammaSpace: false,
      });
    const coefficients = Object.fromEntries(
      (["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"] as const).map(
        (key) => [key, polynomial[key].asArray()],
      ),
    );
    const directionalColor = (level: number, face: number) =>
      level ? [0, 0, 255] : face < 2 ? [255, 0, 0] : [0, 255, 0];
    for (const [kind, irradiance] of [
      ["sampled", undefined],
      ["supplied", coefficients],
    ] as const) {
      const bytes = await numericEnv({
        width: 64,
        color: directionalColor,
        irradiance,
      });
      for (const [name, entry] of [
        ["native", a],
        ["graph", b],
      ] as const) {
        applyEnvironmentLighting(
          entry.scene,
          `directional-${kind}`,
          assets(`directional-${kind}`, bytes),
        );
        for (const rotation of [0, 90]) {
          setSceneRenderSettings(entry.scene, settings("pbr", 0.5, rotation));
          await capture(
            `${name}-directional-${kind}-${rotation}`,
            entry.scene,
            entry.mesh,
          );
        }
      }
    }
    applyEnvironmentLighting(b.scene, "green", assets("green", green));
    setSceneRenderSettings(b.scene, settings("cel", 1, 0, 1));
    await capture("sibling-before-dispose", b.scene, b.mesh);
    a.scene.dispose();
    await capture("sibling-after-dispose", b.scene, b.mesh);

    const raw = create();
    const directionCube = buildFloatDdsCubeFixture({ color: [0, 1, 0, 1] });
    const facePixels = 5,
      faceBytes = facePixels * 16;
    const data = new DataView(directionCube.buffer);
    // Base +X is red, +Z is green; every final roughness mip is blue.
    for (let face = 0; face < 6; face++)
      for (let texel = 0; texel < facePixels; texel++) {
        const color =
          texel === 4 ? [0, 0, 1, 1] : face === 0 ? [1, 0, 0, 1] : [0, 1, 0, 1];
        for (let channel = 0; channel < 4; channel++)
          data.setFloat32(
            128 + face * faceBytes + texel * 16 + channel * 4,
            color[channel]!,
            true,
          );
      }
    setSceneRenderSettings(raw.scene, settings("pbr", 7, 0, 0, false));
    applyEnvironmentLighting(
      raw.scene,
      "directions",
      assets("directions", directionCube),
    );
    const fn = createDefaultMaterialFunctionDocument("Environment Function");
    fn.inputs = [];
    fn.nodes.push({
      id: "sample",
      type: "input.environmentSample",
      position: { x: 0, y: 0 },
      properties: {},
    });
    fn.edges = [
      {
        id: "raw-output",
        sourceNodeId: "sample",
        sourcePinId: "color",
        targetNodeId: "outputs",
        targetPinId: "out_value",
      },
    ];
    const rawDoc = surface();
    rawDoc.shadingModel = "unlit";
    rawDoc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "environment" },
    });
    rawDoc.edges = [
      {
        id: "call-output",
        sourceNodeId: "call",
        sourcePinId: "out_value",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    ];
    const rawMaterial = await compile(raw.scene, rawDoc, { environment: fn });
    raw.mesh.material = rawMaterial.material;
    await capture("raw-disabled-green", raw.scene, raw.mesh);
    rawMaterial.material.freeze();
    setSceneRenderSettings(raw.scene, settings("pbr", 2, 90, 0, false));
    await capture("raw-rotated-red", raw.scene, raw.mesh);
    setSceneRenderSettings(raw.scene, settings("pbr", 0, 0, 0, false));
    await capture("raw-zero-intensity-green", raw.scene, raw.mesh);
    fn.nodes.find((node) => node.id === "sample")!.properties = {
      "default:roughness": [1],
    };
    const rough = await compile(raw.scene, rawDoc, { environment: fn });
    raw.mesh.material = rough.material;
    rawMaterial.dispose();
    await capture("raw-rough-blue", raw.scene, raw.mesh);
    const dim = buildFloatDdsCubeFixture({ color: [0, 0.1, 0, 1] });
    rough.material.freeze();
    applyEnvironmentLighting(raw.scene, "dim", assets("dim", dim));
    await capture("raw-frozen-swap", raw.scene, raw.mesh);
    applyEnvironmentLighting(raw.scene, null);
    await capture("raw-removed", raw.scene, raw.mesh);
    applyEnvironmentLighting(raw.scene, "dim", assets("dim", dim));
    await capture("raw-restored", raw.scene, raw.mesh);
    const parameterDoc = surface();
    parameterDoc.shadingModel = "unlit";
    parameterDoc.nodes.push(
      {
        id: "sample",
        type: "input.environmentSample",
        position: { x: 0, y: 0 },
        properties: { "default:direction": [0, 0, 0] },
      },
      {
        id: "roughness",
        type: "param.float",
        position: { x: 0, y: 0 },
        properties: { value: [0.5], name: "Roughness" },
      },
    );
    parameterDoc.edges = [
      {
        id: "roughness",
        sourceNodeId: "roughness",
        sourcePinId: "out",
        targetNodeId: "sample",
        targetPinId: "roughness",
      },
      {
        id: "raw",
        sourceNodeId: "sample",
        sourcePinId: "color",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    ];
    const parameterMaterial = await compile(raw.scene, parameterDoc);
    raw.mesh.material = parameterMaterial.material;
    const levelColors = [
      [0, 255, 0],
      [255, 0, 0],
      [0, 0, 255],
      [255, 255, 255],
    ];
    for (const scale of [0.5, 1]) {
      const bytes = await numericEnv({
        width: 8,
        lodGenerationScale: scale,
        color: (level) => levelColors[level]!,
      });
      applyEnvironmentLighting(
        raw.scene,
        `prefilter-${scale}`,
        assets(`prefilter-${scale}`, bytes),
      );
      await capture(`raw-prefilter-${scale}`, raw.scene, raw.mesh);
      parameterMaterial.material.freeze();
    }
    for (const roughness of [0.25, 0.75, 1]) {
      if (
        !parameterMaterial.setParameter("Roughness", {
          kind: "float",
          value: roughness,
        })
      )
        throw new Error("Raw roughness parameter was not applied.");
      await capture(
        `raw-prefilter-roughness-${roughness}`,
        raw.scene,
        raw.mesh,
      );
    }
    applyEnvironmentLighting(raw.scene, "dim", assets("dim", dim));
    const override = surface();
    override.nodes[0]!.properties = { value: [0, 0, 0] };
    override.nodes.find((node) => node.type === "output.surface")!.properties =
      { "default:environmentInfluence": [0] };
    override.nodes.push({
      id: "sample",
      type: "input.environmentSample",
      position: { x: 0, y: 0 },
      properties: {},
    });
    override.edges.push({
      id: "raw-emission",
      sourceNodeId: "sample",
      sourcePinId: "color",
      targetNodeId: "output",
      targetPinId: "emissive",
    });
    raw.mesh.material = (await compile(raw.scene, override)).material;
    for (const intensity of [0, 4]) {
      setSceneRenderSettings(raw.scene, settings("pbr", intensity));
      await capture(`replacement-${intensity}`, raw.scene, raw.mesh);
    }
    const ppDoc = createDefaultMaterialDocument(
      "Raw Environment Post Process",
      "postProcess",
    );
    ppDoc.nodes.push(
      {
        id: "sample",
        type: "input.environmentSample",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "split",
        type: "vector.split",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "combine",
        type: "vector.combine",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    const edge = (
      sourceNodeId: string,
      sourcePinId: string,
      targetNodeId: string,
      targetPinId: string,
    ) => ({
      id: `${sourceNodeId}-${sourcePinId}-${targetNodeId}`,
      sourceNodeId,
      sourcePinId,
      targetNodeId,
      targetPinId,
    });
    ppDoc.edges = [
      edge("sample", "color", "split", "value"),
      ...["x", "y", "z"].map((pin) => edge("split", pin, "combine", pin)),
      edge("combine", "xyzw", "output", "color"),
    ];
    const pp = await compile(raw.scene, ppDoc);
    const pass = pp.material.createPostProcess(raw.camera);
    if (!pass) throw new Error("Raw environment post process was not created.");
    setSceneRenderSettings(raw.scene, settings("pbr", 5, 0, 0, false));
    await capture("raw-post-process", raw.scene, raw.mesh);
    pass.dispose();
    const hardware = engine.getGlInfo();
    return { sharedUpload, distinctViews, optionalGraph, hardware, captures };
  } catch (error) {
    return {
      sharedUpload,
      distinctViews,
      optionalGraph,
      hardware: engine.getGlInfo(),
      captures,
      failure: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const material of compiled) material.dispose();
    for (const scene of scenes) scene.dispose();
    cache.dispose();
    engine.dispose();
    canvas.remove();
  }
}

/** Supplemental native-WGSL irradiance/state proof; no project backend activation. */
export async function runEnvironmentIrradianceWebGpuProof() {
  const beforeEngines = EngineStore.Instances.length;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const swapChainFormat = (
    navigator as unknown as {
      gpu: { getPreferredCanvasFormat(): "rgba8unorm" | "bgra8unorm" };
    }
  ).gpu.getPreferredCanvasFormat();
  const engine = new WebGPUEngine(canvas, {
    antialias: false,
    adaptToDeviceRatio: false,
    enableAllFeatures: false,
    swapChainFormat,
  });
  const cache = new ResourceCache();
  const captures: Record<string, number[]> = {};
  const states: Record<string, unknown>[] = [];
  const polynomials: Record<string, number[]> = {};
  let optionalGraph:
    { sameBuild: boolean; frozen: boolean; noCubeBefore: boolean } | undefined;
  const started = performance.now();
  const wait = async (ready: () => boolean) => {
    while (!ready()) {
      if (performance.now() - started > 60_000)
        throw new Error("WebGPU irradiance readiness timed out.");
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  };
  const capture = async (name: string, scene: Scene, mesh: Mesh, precompile = true) => {
    if (precompile) await mesh.material!.forceCompilationAsync(mesh);
    await wait(() => isSceneFrameReady(scene));
    engine.beginFrame();
    scene.render();
    engine.endFrame();
    const pixels = await engine.readPixels(32, 32, 1, 1);
    const pixel = new Uint8Array(
      pixels.buffer,
      pixels.byteOffset,
      pixels.byteLength,
    );
    captures[name] =
      swapChainFormat === "bgra8unorm"
        ? [pixel[2]!, pixel[1]!, pixel[0]!, pixel[3]!]
        : Array.from(pixel);
  };
  const colors = [
    [1, 0, 0],
    [0, 0, 0],
    [0, 1, 0],
    [0, 0, 0],
    [0, 0, 1],
    [0, 0, 0],
  ];
  const faces = colors.map((color) => {
    const pixels = new Float32Array(64 * 64 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([...color, 1], i);
    return pixels;
  });
  const reference =
    CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
      size: 64,
      right: faces[0],
      left: faces[1],
      up: faces[2],
      down: faces[3],
      front: faces[4],
      back: faces[5],
      type: 1,
      format: 5,
      gammaSpace: false,
    });
  const keys = ["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"] as const;
  const coefficients = Object.fromEntries(
    keys.map((key) => [key, reference[key].asArray()]),
  );
  let failure: string | undefined;
  try {
    await engine.initAsync();
    for (const [kind, irradiance] of [
      ["sampled", undefined],
      ["supplied", coefficients],
    ] as const) {
      const scene = new Scene(engine);
      try {
        const camera = new FreeCamera("camera", new Vector3(0, 0, -2), scene);
        camera.setTarget(Vector3.Zero());
        const mesh = MeshBuilder.CreatePlane("receiver", { size: 2 }, scene);
        mesh.rotation.x = -Math.PI / 6;
        const material = new PBRMaterial("native-wgsl", scene);
        material.metallic = 0;
        material.roughness = 1;
        material.albedoColor = Color3.White();
        mesh.material = material;
        const bytes = await numericEnv({
          width: 64,
          irradiance,
          color: (level, face) =>
            level ? [255, 255, 255] : colors[face]!.map((value) => value * 255),
        });
        setSceneRenderSettings(scene, {
          environmentLighting: normalizeEnvironmentLightingSettings({
            intensity: 0.5,
          }),
        });
        applyEnvironmentLighting(scene, kind, {
          resourceCache: cache,
          textureBytes: new Map([[kind, bytes]]),
        });
        await wait(() => scene.environmentTexture!.isReady());
        const previous = engine.createRenderTargetTexture(16, {
          format: Constants.TEXTUREFORMAT_RGBA,
          generateDepthBuffer: false,
          generateMipMaps: false,
        });
        const targetsBefore = engine._renderTargetWrapperCache.length;
        try {
          engine.bindFramebuffer(previous);
          engine.clear(new Color4(0.25, 0.5, 0.75, 1), true, false, false);
          engine.setViewport(new Viewport(0.1, 0.2, 0.6, 0.7));
          engine.setAlphaMode(Constants.ALPHA_ADD);
          engine.setColorWrite(false);
          engine.depthCullingState.cull = false;
          engine.depthCullingState.zOffset = 3;
          engine.stencilState.stencilTest = true;
          await wait(() => isEnvironmentLightingReady(scene));
          const restored =
            engine._currentRenderTarget === previous &&
            engine.currentViewport?.x === 0.1 &&
            engine.currentViewport?.width === 0.6 &&
            engine.getAlphaMode() === Constants.ALPHA_ADD &&
            !engine.getColorWrite() &&
            engine.depthCullingState.cull === false &&
            engine.depthCullingState.zOffset === 3 &&
            engine.stencilState.stencilTest;
          const pixels = await engine._readTexturePixels(
            previous.texture!,
            16,
            16,
          );
          states.push({
            kind,
            restored,
            retainedTargets:
              engine._renderTargetWrapperCache.length - targetsBefore,
            previousPixel: Array.from(
              new Uint8Array(pixels.buffer, pixels.byteOffset, 4),
            ),
          });
        } finally {
          engine.restoreDefaultFramebuffer();
          previous.dispose();
        }
        polynomials[kind] = keys.flatMap((key) =>
          scene.environmentTexture!.sphericalPolynomial![key].asArray(),
        );
        engine.setViewport(new Viewport(0, 0, 1, 1));
        engine.setColorWrite(true);
        engine.stencilState.stencilTest = false;
        engine.setAlphaMode(Constants.ALPHA_DISABLE);
        for (const rotationYDegrees of [0, 90]) {
          setSceneRenderSettings(scene, {
            environmentLighting: normalizeEnvironmentLightingSettings({
              intensity: 0.5,
              rotationYDegrees,
            }),
          });
          await capture(`${kind}-${rotationYDegrees}`, scene, mesh);
        }
        if (kind === "supplied") {
          const lateScene = new Scene(engine);
          let graphResult: { dispose(): void } | undefined;
          try {
            lateScene.clearColor = new Color4(0, 0, 0, 1);
            const lateCamera = new FreeCamera(
              "late-camera",
              new Vector3(0, 0, -2),
              lateScene,
            );
            lateCamera.setTarget(Vector3.Zero());
            const lateMesh = MeshBuilder.CreatePlane(
              "late-receiver",
              { size: 2 },
              lateScene,
            );
            lateMesh.rotation.x = -Math.PI / 6;
            const doc = createDefaultMaterialDocument();
            doc.nodes[0]!.properties = { value: [1, 1, 1] };
            doc.nodes.find(
              (node) => node.type === "output.surface",
            )!.properties = {
              "default:roughness": [1],
            };
            const plan = lowerMaterialDocument(doc);
            if (plan.ok === false)
              throw new Error(JSON.stringify(plan.diagnostics));
            const cubesBefore = engine
              .getLoadedTexturesCache()
              .filter((texture) => texture.isCube).length;
            const result = compileMaterialPlan(plan.plan, {
              scene: lateScene,
              name: "late-wgsl-environment",
            });
            if (result.ok === false)
              throw new Error(JSON.stringify(result.diagnostics));
            graphResult = result;
            const diagnostics = await result.ready;
            if (diagnostics.length)
              throw new Error(JSON.stringify(diagnostics));
            const graph = result.material;
            lateMesh.material = graph;
            setSceneRenderSettings(lateScene, {
              environmentLighting: normalizeEnvironmentLightingSettings({
                intensity: 0.5,
              }),
            });
            await capture("graph-before-environment", lateScene, lateMesh, false);
            graph.freeze();
            const buildId = graph.buildId;
            const noCubeBefore =
              lateScene.environmentTexture === null &&
              engine
                .getLoadedTexturesCache()
                .filter((texture) => texture.isCube).length === cubesBefore;
            const graphAssets = {
              resourceCache: cache,
              textureBytes: new Map([[kind, bytes]]),
            };
            applyEnvironmentLighting(lateScene, kind, graphAssets);
            await wait(() => isEnvironmentLightingReady(lateScene));
            await capture("graph-late-environment", lateScene, lateMesh, false);
            applyEnvironmentLighting(lateScene, null, graphAssets);
            await capture("graph-removed-environment", lateScene, lateMesh, false);
            applyEnvironmentLighting(lateScene, kind, graphAssets);
            setSceneRenderSettings(lateScene, {
              environmentLighting: normalizeEnvironmentLightingSettings({
                intensity: 0.5,
                rotationYDegrees: 90,
              }),
            });
            await wait(() => isEnvironmentLightingReady(lateScene));
            await capture("graph-reassigned-environment", lateScene, lateMesh, false);
            optionalGraph = {
              sameBuild: graph.buildId === buildId,
              frozen: graph.isFrozen,
              noCubeBefore,
            };
          } finally {
            graphResult?.dispose();
            lateScene.dispose();
          }
        }
      } finally {
        scene.dispose();
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    cache.dispose();
    engine.dispose();
    canvas.remove();
  }
  return {
    failure,
    captures,
    states,
    polynomials,
    optionalGraph,
    retainedEngines: EngineStore.Instances.length - beforeEngines,
    hardware: engine.getInfo(),
  };
}
