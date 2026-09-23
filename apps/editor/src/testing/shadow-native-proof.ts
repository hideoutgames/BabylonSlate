/** Test-only native Babylon comparison; independent engine, scene and materials. */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  Matrix,
  MeshBuilder,
  PBRMaterial,
  Scene,
  ShaderStore,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";
import { lightFragment } from "@babylonjs/core/Shaders/ShadersInclude/lightFragment";
import {
  SHADOW_BOXES,
  SHADOW_CAMERA_TARGET,
  shadowNormalize,
  shadowRegions,
  shadowSurfaceSamples,
  type ShadowTriple,
} from "./shadow-self-shadowing-fixture";

export type NativeShadowProofInput = {
  receiverPlane?: boolean;
  cameraPosition: readonly number[];
  cameraNear: number;
  cameraFar: number;
  cameraFov: number;
  cameraViewProjection?: readonly number[];
  lightPosition: readonly number[];
  lightDirection: readonly number[];
  lightView: readonly number[];
  lightProjection: readonly number[];
  mapSize: number;
  depthBias: number;
  normalBias: number;
  filteringQuality: number;
  shadowMinZ: number;
  shadowMaxZ: number;
  imageProcessing?: {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
    toneMappingType: number;
  };
};

const SIZE = 384;
const matrixError = (actual: readonly number[], expected: readonly number[]) =>
  actual.length !== 16 || expected.length !== 16
    ? null
    : Math.max(
        ...actual.map((value, index) => Math.abs(value - expected[index]!)),
      );

/** Call after the managed proof has disposed its graph, scene and engine. */
export async function runNativeShadowProof(input: NativeShadowProofInput) {
  if (
    input.lightView.length !== 16 ||
    input.lightProjection.length !== 16 ||
    ![...input.lightView, ...input.lightProjection].every(Number.isFinite) ||
    input.mapSize !== 1024
  )
    throw new Error(
      "Native comparison requires the captured Low single-map projection",
    );
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  document.getElementById("root")!.append(canvas);
  const previousInclude = ShaderStore.IncludesShadersStore.lightFragment;
  let engine: Engine | undefined;
  let scene: Scene | undefined;
  try {
    // Use the pinned upstream include while compiling this scene's fresh effects.
    // A fresh engine prevents reuse of effects compiled with an earlier probe.
    if (input.receiverPlane && !previousInclude)
      throw new Error("Production shadow receiver adapter was not installed");
    ShaderStore.IncludesShadersStore.lightFragment = input.receiverPlane
      ? previousInclude!
      : lightFragment.shader;
    engine = new Engine(canvas, false, {
      preserveDrawingBuffer: true,
      stencil: true,
      disableWebGL2Support: false,
    });
    if (engine.webGLVersion !== 2)
      throw new Error("Native comparison requires actual WebGL2");
    const nativeEngine = engine;
    scene = new Scene(nativeEngine);
    const nativeScene = scene;
    nativeScene.clearColor = new Color4(0.04, 0.04, 0.04, 1);
    if (input.imageProcessing)
      Object.assign(
        nativeScene.imageProcessingConfiguration,
        input.imageProcessing,
      );
    const camera = new FreeCamera(
      "native fixed close view",
      Vector3.FromArray(input.cameraPosition),
      nativeScene,
    );
    camera.setTarget(Vector3.FromArray(SHADOW_CAMERA_TARGET));
    camera.minZ = input.cameraNear;
    camera.maxZ = input.cameraFar;
    camera.fov = input.cameraFov;
    nativeScene.activeCamera = camera;
    const key = new DirectionalLight(
      "native oblique key",
      Vector3.FromArray(input.lightDirection),
      nativeScene,
    );
    key.position.copyFromFloats(...(input.lightPosition as ShadowTriple));
    key.intensity = 2;
    key.autoCalcShadowZBounds = false;
    key.shadowMinZ = input.shadowMinZ;
    key.shadowMaxZ = input.shadowMaxZ;
    const projection = Matrix.FromArray(input.lightProjection);
    let drawnView: number[] = [];
    let drawnProjection: number[] = [];
    key.customProjectionMatrixBuilder = (view, _renderList, result) => {
      drawnView = Array.from(view.asArray());
      result.copyFrom(projection);
      drawnProjection = Array.from(result.asArray());
    };
    new HemisphericLight(
      "native fixed fill",
      Vector3.Up(),
      nativeScene,
    ).intensity = 0.12;
    const material = new PBRMaterial("native neutral matte", nativeScene);
    material.albedoColor = new Color3(0.6, 0.6, 0.6);
    material.metallic = 0;
    material.roughness = 1;
    for (const box of SHADOW_BOXES) {
      const mesh = MeshBuilder.CreateBox(
        box.name,
        { width: box.size[0], height: box.size[1], depth: box.size[2] },
        nativeScene,
      );
      mesh.position.copyFromFloats(...box.center);
      mesh.material = material;
      mesh.receiveShadows = true;
      mesh.computeWorldMatrix(true);
    }
    const ground = MeshBuilder.CreateGround(
      "ground",
      { width: 12, height: 12 },
      nativeScene,
    );
    ground.material = material;
    ground.receiveShadows = true;
    const generator = new ShadowGenerator(input.mapSize, key);
    if (input.receiverPlane) {
      const prepare = generator.prepareDefines.bind(generator);
      generator.prepareDefines = (defines, index) => {
        prepare(defines, index);
        defines[`SLATE_SHADOW_AUTO${index}`] = true;
        defines.rebuild();
      };
    }
    generator.filter = ShadowGenerator.FILTER_PCF;
    generator.filteringQuality = input.filteringQuality;
    generator.bias = input.depthBias;
    generator.normalBias = input.normalBias;
    generator.frustumEdgeFalloff = 0;
    generator.getShadowMap()!.renderList = [...nativeScene.meshes];
    nativeScene.updateTransformMatrix(true);
    const boundedReady = async () => {
      const deadline = performance.now() + 30_000;
      // Own the polling lifetime: racing Babylon's asynchronous readiness
      // helpers against a timeout would leave their internal timers alive.
      for (;;) {
        const previousPass = nativeEngine.currentRenderPassId;
        const hotSwap = material.allowShaderHotSwapping;
        const everyCall = material.checkReadyOnEveryCall;
        let castersReady = true;
        let receiversReady = false;
        try {
          // isReady stores its effect in the CURRENT pass's submesh wrapper.
          // Match the shadow RTT pass without invoking RTT draw observables.
          // Probing in the camera pass overwrites PBR wrappers with casters.
          nativeEngine.currentRenderPassId = generator.getShadowMap()!.renderPassId;
          for (const mesh of nativeScene.meshes)
            for (const subMesh of mesh.subMeshes)
              castersReady = generator.isReady(subMesh, false, false) && castersReady;
          nativeEngine.currentRenderPassId = camera.renderPassId;
          // A shadow-enabled toggle must compile the requested receiver variant,
          // rather than accepting the previous ready effect through hot swapping.
          material.allowShaderHotSwapping = false;
          material.checkReadyOnEveryCall = true;
          receiversReady = nativeScene.isReady(false);
        } finally {
          material.allowShaderHotSwapping = hotSwap;
          material.checkReadyOnEveryCall = everyCall;
          nativeEngine.currentRenderPassId = previousPass;
          nativeScene.resetCachedMaterial();
        }
        if (receiversReady && castersReady) return;
        if (performance.now() >= deadline)
          throw new Error("Native shader readiness timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    await boundedReady();
    const render = async () => {
      await boundedReady();
      nativeEngine.beginFrame();
      try {
        nativeScene.render();
        const view = await nativeEngine.readPixels(0, 0, SIZE, SIZE);
        const bytes = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        const pixels = new Array<number>(SIZE * SIZE * 4);
        for (let y = 0; y < SIZE; y++)
          for (let x = 0; x < SIZE; x++) {
            const from = (y * SIZE + x) * 4;
            const to = ((SIZE - 1 - y) * SIZE + x) * 4;
            for (let channel = 0; channel < 4; channel++)
              pixels[to + channel] = bytes[from + channel]!;
          }
        return pixels;
      } finally {
        nativeEngine.endFrame();
      }
    };
    const png = (pixels: number[]) => {
      const copy = document.createElement("canvas");
      copy.width = copy.height = SIZE;
      copy
        .getContext("2d")!
        .putImageData(
          new ImageData(new Uint8ClampedArray(pixels), SIZE, SIZE),
          0,
          0,
        );
      return copy.toDataURL("image/png").split(",")[1]!;
    };
    key.shadowEnabled = false;
    await render();
    const reference = await render();
    const points = shadowSurfaceSamples(
      camera.position.asArray() as ShadowTriple,
      Array.from(nativeScene.getTransformMatrix().asArray()),
      shadowNormalize(key.direction.negate().asArray() as ShadowTriple),
      SIZE,
      SIZE,
    );
    key.shadowEnabled = true;
    const firstShadowed = await render();
    const shadowed = await render();
    const cameraMatrix = Array.from(nativeScene.getTransformMatrix().asArray());
    const map = generator.getShadowMap()!;
    const processing = nativeScene.imageProcessingConfiguration;
    return {
      synthetic: true,
      qualification:
        "Native Babylon baseline comparison; not an upstream defect or original-asset proof",
      effective: {
        receiverPlaneDiagnostic: input.receiverPlane ?? false,
        backend: "webgl2",
        webGLVersion: nativeEngine.webGLVersion,
        adapter: nativeEngine.getGlInfo(),
        width: SIZE,
        height: SIZE,
        reverseDepthBuffer: nativeEngine.useReverseDepthBuffer,
        ndcHalfZRange: nativeEngine.isNDCHalfZRange,
        material: material.getClassName(),
        renderPath: "native scene.render",
        readinessRenderPasses: {
          receiver: camera.renderPassId,
          caster: map.renderPassId,
        },
        map: map.getSize(),
        filter: "pcf",
        filteringQuality: generator.filteringQuality,
        depthBias: generator.bias,
        normalBias: generator.normalBias,
        lightPosition: key.position.asArray(),
        lightDirection: key.direction.asArray(),
        view: drawnView,
        projection: drawnProjection,
        cameraViewProjection: cameraMatrix,
        comparisonError: {
          lightView: matrixError(drawnView, input.lightView),
          lightProjection: matrixError(drawnProjection, input.lightProjection),
          cameraViewProjection: input.cameraViewProjection
            ? matrixError(cameraMatrix, input.cameraViewProjection)
            : null,
        },
        imageProcessing: {
          exposure: processing.exposure,
          contrast: processing.contrast,
          toneMappingEnabled: processing.toneMappingEnabled,
          toneMappingType: processing.toneMappingType,
        },
      },
      captures: [
        {
          name: "native-shadow-contribution-off",
          png: png(reference),
          pixels: reference,
          regions: {},
        },
        {
          name: "native-first-shadowed",
          png: png(firstShadowed),
          pixels: firstShadowed,
          regions: shadowRegions(reference, firstShadowed, points, SIZE),
        },
        {
          name: "native-authored-manual",
          png: png(shadowed),
          pixels: shadowed,
          regions: shadowRegions(reference, shadowed, points, SIZE),
        },
      ],
    };
  } finally {
    scene?.dispose();
    engine?.dispose();
    if (previousInclude === undefined)
      delete ShaderStore.IncludesShadersStore.lightFragment;
    else ShaderStore.IncludesShadersStore.lightFragment = previousInclude;
    canvas.remove();
  }
}
