import {
  Camera,
  Color3,
  Color4,
  Engine,
  FreeCamera,
  MeshBuilder,
  PBRMaterial,
  Scene,
  Vector3,
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
    if (result.ok === false) throw new Error(JSON.stringify(result.diagnostics));
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
    b.mesh.material = (await compile(b.scene, surface())).material;
    for (const entry of [a, b]) {
      setSceneRenderSettings(entry.scene, settings("pbr"));
      applyEnvironmentLighting(entry.scene, "green", assets("green", green));
    }
    sharedUpload =
      a.scene.environmentTexture!.getInternalTexture() ===
      b.scene.environmentTexture!.getInternalTexture();
    distinctViews = a.scene.environmentTexture !== b.scene.environmentTexture;
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
    return { sharedUpload, distinctViews, hardware, captures };
  } catch (error) {
    return {
      sharedUpload,
      distinctViews,
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
