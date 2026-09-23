/** Test-only synthetic box-character fixture. Readbacks never run in production. */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  ShadowGenerator,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  normalizeShadowSettings,
} from "@babylonslate/core";
import {
  applyAuthoredLightProperties,
  captureShadowDiagnostics,
  createAppWebGpuEngine,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";

import {
  SHADOW_BOXES,
  SHADOW_CAMERA_POSITION,
  SHADOW_CAMERA_TARGET,
  SHADOW_CAMERA_FOV,
  SHADOW_LIGHT_DIRECTION,
  shadowSurfaceSamples,
  shadowThinContactEdgeSamples,
  shadowRegions,
  type ShadowTriple,
  type ShadowBox,
} from "./shadow-self-shadowing-fixture";

const SIZE = 384;
export { runNativeShadowProof } from "./shadow-native-proof";

export async function runShadowSelfShadowingProof(
  backend: "webgl2" | "webgpu",
  mode: "pbr" | "cel",
  configuration: "low" | "cascade-fallback" | "cascades",
  options: {
    transformed?: boolean;
    liveTransform?: boolean;
    filterQuality?: "low" | "medium" | "high";
    grazing?: boolean;
  } = {},
) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  document.getElementById("root")!.append(canvas);
  const engine =
    backend === "webgpu"
      ? await createAppWebGpuEngine(canvas)
      : new Engine(canvas, false, {
          preserveDrawingBuffer: true,
          stencil: true,
          disableWebGL2Support: false,
        });
  if (configuration === "cascade-fallback") engine._features.supportCSM = false;
  const scene = new Scene(engine);
  const graph = new ForwardSceneFrameGraph(scene);
  try {
    scene.clearColor = new Color4(0.04, 0.04, 0.04, 1);
    const camera = new FreeCamera(
      "fixed close view",
      Vector3.FromArray(SHADOW_CAMERA_POSITION),
      scene,
    );
    camera.setTarget(Vector3.FromArray(SHADOW_CAMERA_TARGET));
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.fov = SHADOW_CAMERA_FOV;
    scene.activeCamera = camera;
    const light = new DirectionalLight(
      "oblique key",
      Vector3.FromArray(options.grazing ? [1, -0.012, 0.4] : SHADOW_LIGHT_DIRECTION).normalize(),
      scene,
    );
    applyAuthoredLightProperties(light, { intensity: options.grazing ? 20 : 2, castShadows: true });
    new HemisphericLight("fixed fill", Vector3.Up(), scene).intensity = 0.12;
    const material = new PBRMaterial("neutral matte", scene);
    material.albedoColor = new Color3(0.6, 0.6, 0.6);
    material.metallic = 0;
    material.roughness = 1;
    for (const box of SHADOW_BOXES) {
      const mesh = MeshBuilder.CreateBox(
        box.name,
        { width: box.size[0], height: box.size[1], depth: box.size[2] },
        scene,
      );
      mesh.position = Vector3.FromArray(box.center);
      mesh.material = material;
    }
    const boxes: ShadowBox[] = [...SHADOW_BOXES];
    const transformFixture = () => {
      // Exercise final world normals under a non-uniform mirrored parent, and
      // the instanced receiver/caster path, with independently updated bounds.
      const head = scene.getMeshByName("head")!;
      const parent = new TransformNode("mirrored non-uniform parent", scene);
      parent.scaling.set(-2, 1.5, 0.75);
      head.parent = parent;
      head.position.set(0, 3.55 / 1.5, 0);
      head.scaling.set(1.8 / 1.6 / 2, 1 / 1.5, 1.4 / 1.25 / 0.75);
      boxes[boxes.findIndex((box) => box.name === "head")] = {
        name: "head", center: [0, 3.55, 0], size: [1.8, 1.1, 1.4],
      };
      const left = scene.getMeshByName("left-arm")!;
      const right = scene.getMeshByName("right-arm")!;
      if (!(right instanceof Mesh)) throw new Error("Instance source must be a mesh");
      const position = left.position.clone();
      left.dispose();
      const instance = right.createInstance("left-arm");
      instance.position.copyFrom(position);
      return instance;
    };
    if (options.transformed) transformFixture();
    const ground = MeshBuilder.CreateGround(
      "ground",
      { width: 12, height: 12 },
      scene,
    );
    ground.material = material;
    const authored = normalizeShadowSettings({
      profile: options.grazing ? "medium" : "low",
      cascades: configuration === "low" ? 1 : 2,
      filterQuality: options.filterQuality ?? (options.grazing ? "medium" : "low"),
    });
    const settings = (
      autoBias: boolean,
      depthBias = authored.depthBias,
      normalBias = authored.normalBias,
      distance = authored.distance,
    ) => {
      setSceneRenderSettings(scene, {
        mode,
        shadows: { ...authored, autoBias, depthBias, normalBias, distance },
        cel: normalizeCelShadingSettings({
          specularEnabled: false,
          shadowStrength: 1,
        }),
      });
    };
    const captures: {
      name: string;
      png: string;
      effective: ReturnType<typeof captureShadowDiagnostics>;
      assertions: boolean;
      regions: ReturnType<typeof shadowRegions>;
    }[] = [];
    const render = async () => {
      const ready = await graph.prepare(camera);
      if (ready.path !== "frameGraph") throw new Error(ready.reason);
      engine.beginFrame();
      try {
        const rendered = graph.render(camera, false);
        if (rendered.path !== "frameGraph") throw new Error(rendered.reason);
        const view = await engine.readPixels(0, 0, SIZE, SIZE);
        const bytes = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        const rgba = Array.from(bytes);
        const format =
          backend === "webgpu"
            ? (
                navigator as Navigator & {
                  gpu: { getPreferredCanvasFormat(): string };
                }
              ).gpu.getPreferredCanvasFormat()
            : "rgba8unorm";
        for (let y = 0; y < SIZE; y++)
          for (let x = 0; x < SIZE; x++) {
            const src = (y * SIZE + x) * 4;
            const dst =
              ((backend === "webgl2" ? SIZE - 1 - y : y) * SIZE + x) * 4;
            rgba[dst] = bytes[src + (format.startsWith("bgra") ? 2 : 0)]!;
            rgba[dst + 1] = bytes[src + 1]!;
            rgba[dst + 2] = bytes[src + (format.startsWith("bgra") ? 0 : 2)]!;
            rgba[dst + 3] = bytes[src + 3]!;
          }
        return rgba;
      } finally {
        engine.endFrame();
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
    let reference: number[] = [];
    let points: ReturnType<typeof shadowSurfaceSamples> = [];
    const diagnostics = () =>
      captureShadowDiagnostics(scene, {
        host: "synthetic FrameGraph proof",
        requestedBackend: backend,
        sceneUnits: "synthetic world units",
        meshes: scene.meshes,
      });
    const updatePoints = () => {
      const generator = light.getShadowGenerator() as ShadowGenerator;
      const size = generator.getShadowMap()!.getSize();
      const filter = configuration === "cascades" ? undefined : {
        kind: "directional-single-pcf" as const,
        view: Array.from(generator.viewMatrix.asArray()),
        projection: Array.from(generator.projectionMatrix.asArray()),
        width: size.width,
        height: size.height,
        quality: authored.filterQuality,
      };
      points = shadowSurfaceSamples(
        camera.position.asArray() as ShadowTriple,
        Array.from(scene.getTransformMatrix().asArray()),
        light.direction.negate().asArray() as ShadowTriple,
        SIZE,
        SIZE,
        camera.viewport,
        boxes,
        filter,
        options.grazing ? 0.005 : 0.2,
      );
      points.push(
        ...shadowThinContactEdgeSamples(
          camera.position.asArray() as ShadowTriple,
          Array.from(scene.getTransformMatrix().asArray()),
          light.direction.negate().asArray() as ShadowTriple,
          SIZE,
          SIZE,
          camera.viewport,
          boxes,
          filter,
        ),
      );
    };
    const referencePose = async (name: string) => {
      light.shadowEnabled = false;
      reference = await render();
      captures.push({
        name: `${name}-shadow-contribution-off`,
        png: png(reference),
        effective: diagnostics(),
        assertions: false,
        regions: {},
      });
      light.shadowEnabled = true;
    };
    const capture = async (name: string, assertions = false) => {
      const pixels = await render();
      // Use this draw's light matrices, including after changing the pose.
      updatePoints();
      captures.push({
        name,
        png: png(pixels),
        effective: diagnostics(),
        assertions,
        regions: shadowRegions(reference, pixels, points, SIZE),
      });
    };
    settings(false);
    await referencePose("baseline");
    await capture("authored-manual");
    const nativeGenerator = light.getShadowGenerator() as ShadowGenerator;
    const nativeInput = configuration === "low" ? {
      cameraPosition: camera.position.asArray(),
      cameraNear: camera.minZ,
      cameraFar: camera.maxZ,
      cameraFov: camera.fov,
      cameraViewProjection: Array.from(scene.getTransformMatrix().asArray()),
      lightPosition: light.position.asArray(),
      lightDirection: light.direction.asArray(),
      lightView: Array.from(nativeGenerator.viewMatrix.asArray()),
      lightProjection: Array.from(nativeGenerator.projectionMatrix.asArray()),
      mapSize: nativeGenerator.getShadowMap()!.getSize().width,
      depthBias: authored.depthBias,
      normalBias: authored.normalBias,
      filteringQuality: nativeGenerator.filteringQuality,
      shadowMinZ: light.shadowMinZ!,
      shadowMaxZ: light.shadowMaxZ!,
      imageProcessing: {
        exposure: scene.imageProcessingConfiguration.exposure,
        contrast: scene.imageProcessingConfiguration.contrast,
        toneMappingEnabled: scene.imageProcessingConfiguration.toneMappingEnabled,
        toneMappingType: scene.imageProcessingConfiguration.toneMappingType,
      },
    } : undefined;
    await capture("authored-manual-repeat");
    settings(true);
    await capture("automatic", true);
    await capture("automatic-repeat", true);
    if (configuration === "low" && authored.filterQuality === "low") {
      // Native 9.20 PCF depth comparison moves 0.5*bias on BOTH backends.
      // 160-world-unit Low footprint/depth, 1024 map: these are independently
      // hand-derived world-texel depth corrections.
      // Keep normal bias fixed, then restore depth for the separate normal sweep.
      const depthSweep = [
        ["quarter", 0.00048828125],
        ["half", 0.0009765625],
        ["three-quarter", 0.00146484375],
        ["one", 0.001953125],
        ["one-and-quarter", 0.00244140625],
        ["one-and-half", 0.0029296875],
        ["two", 0.00390625],
      ] as const;
      for (const [name, bias] of depthSweep) {
        settings(false, bias);
        await capture(`manual-depth-${name}-texel`);
      }
      for (const normalBias of [0, 0.005, 0.01]) {
        settings(false, authored.depthBias, normalBias);
        await capture(`manual-normal-${normalBias}`);
      }
      // Projection-utilization experiment only: unchanged resolution, camera,
      // materials and lighting. Restore authored coverage before assertions.
      settings(false, authored.depthBias, authored.normalBias, 16);
      await capture("diagnostic-distance-16-authored-manual");
      settings(true, authored.depthBias, authored.normalBias, 16);
      await capture("diagnostic-distance-16-automatic");
      settings(true);
      // Deliberately separate geometry experiment: retain the principal pose
      // above unchanged, then introduce a thin contact resting on the floor.
      const thin: ShadowBox = {
        name: "thin-slab",
        center: [-1.45, 0.5, -0.1],
        size: [0.08, 1, 0.7],
      };
      boxes.push(thin);
      // Babylon defers its new-mesh notification. Already-ready materials and
      // synchronous WebGL readbacks can otherwise keep this whole proof inside
      // microtasks, before the controller learns that the new caster exists.
      const addition = new Promise<void>((resolve, reject) => {
        const observer = scene.onNewMeshAddedObservable.add((added) => {
          if (added.name !== thin.name) return;
          clearTimeout(timeout);
          scene.onNewMeshAddedObservable.remove(observer);
          resolve();
        });
        const timeout = setTimeout(() => {
          scene.onNewMeshAddedObservable.remove(observer);
          reject(new Error("Thin fixture mesh notification timed out"));
        }, 5_000);
      });
      const mesh = MeshBuilder.CreateBox(
        thin.name,
        { width: thin.size[0], height: thin.size[1], depth: thin.size[2] },
        scene,
      );
      mesh.position = Vector3.FromArray(thin.center);
      mesh.material = material;
      await addition;
      setSceneRenderSettings(scene);
      const thinReady = await graph.prepare(camera);
      if (thinReady.path !== "frameGraph") throw new Error(thinReady.reason);
      if (
        !mesh.receiveShadows ||
        !light.getShadowGenerator()?.getShadowMap()?.renderList?.includes(mesh)
      )
        throw new Error(
          "Thin fixture must join managed cast and receive participation before capture",
        );
      await referencePose("thin-contact");
      await capture("automatic-thin-contact", true);
      settings(false);
      await capture("thin-authored-manual");
      for (const [name, bias] of depthSweep) {
        settings(false, bias);
        await capture(`thin-manual-depth-${name}-texel`);
      }
      settings(true);
      // Unlike the previous near-camera-aligned angle, this independent view
      // contains 25 body-ground and 46 thin-ground occlusion samples at this
      // fixed camera, before brightness/raster classification.
      light.direction = new Vector3(1, -1, 0.4).normalize();
      await referencePose("second-light-angle");
      await capture("automatic-second-light-angle", true);
      // Repeat the independent depth sweep against this pose's own reference
      // and near-contact edge mask; a correction must survive both light angles.
      for (const [name, bias] of depthSweep) {
        settings(false, bias);
        await capture(`second-angle-manual-depth-${name}-texel`);
      }
      settings(false, 0.001953125, 0);
      await capture("second-angle-manual-one-texel-zero-normal");
      settings(true);
      if (options.liveTransform) {
        const instance = transformFixture();
        await new Promise<void>((resolve, reject) => {
          const observer = scene.onNewMeshAddedObservable.add((added) => {
            if (added !== instance) return;
            clearTimeout(timeout);
            scene.onNewMeshAddedObservable.remove(observer);
            resolve();
          });
          const timeout = setTimeout(() => {
            scene.onNewMeshAddedObservable.remove(observer);
            reject(new Error("Live instance notification timed out"));
          }, 5_000);
        });
        await referencePose("live-transform");
        await capture("automatic-live-transform", true);
      }
    } else if (configuration === "cascades") {
      // Dolly through the first split while retaining the same target and
      // projection settings. Capture each view's own independent reference.
      const target = Vector3.FromArray(SHADOW_CAMERA_TARGET);
      const offset = Vector3.FromArray(SHADOW_CAMERA_POSITION).subtract(target);
      for (const scale of [1.4, 1.8]) {
        camera.position.copyFrom(target.add(offset.scale(scale)));
        camera.setTarget(target);
        await referencePose(`camera-dolly-${scale}`);
        await capture(`automatic-camera-dolly-${scale}`, true);
      }
    }
    return {
      synthetic: true,
      transformed: options.transformed ?? false,
      nativeInput,
      backend,
      mode,
      configuration,
      webGLVersion: engine instanceof Engine ? engine.webGLVersion : null,
      width: SIZE,
      height: SIZE,
      authored,
      boxes,
      camera: {
        position: camera.position.asArray(),
        minZ: camera.minZ,
        maxZ: camera.maxZ,
        fov: camera.fov,
      },
      lightDirection: light.direction.asArray(),
      samples: points.length,
      captures,
    };
  } finally {
    const device = (
      engine as {
        _device?: { queue: { onSubmittedWorkDone(): Promise<void> } };
      }
    )._device;
    engine.flushFramebuffer();
    await device?.queue.onSubmittedWorkDone();
    graph.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
