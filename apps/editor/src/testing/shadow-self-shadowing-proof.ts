/** Test-only synthetic box-character fixture. Readbacks never run in production. */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  Scene,
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

export async function runShadowSelfShadowingProof(
  backend: "webgl2" | "webgpu",
  mode: "pbr" | "cel",
  configuration: "low" | "cascade-fallback" | "cascades",
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
      Vector3.FromArray(SHADOW_LIGHT_DIRECTION).normalize(),
      scene,
    );
    applyAuthoredLightProperties(light, { intensity: 2, castShadows: true });
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
    const ground = MeshBuilder.CreateGround(
      "ground",
      { width: 12, height: 12 },
      scene,
    );
    ground.material = material;
    const authored = normalizeShadowSettings({
      profile: "low",
      cascades: configuration === "low" ? 1 : 2,
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
    const boxes: ShadowBox[] = [...SHADOW_BOXES];
    let reference: number[] = [];
    let points: ReturnType<typeof shadowSurfaceSamples> = [];
    const diagnostics = () =>
      captureShadowDiagnostics(scene, {
        host: "synthetic FrameGraph proof",
        requestedBackend: backend,
        sceneUnits: "synthetic world units",
        meshes: scene.meshes,
      });
    const referencePose = async (name: string) => {
      light.shadowEnabled = false;
      reference = await render();
      points = shadowSurfaceSamples(
        camera.position.asArray() as ShadowTriple,
        Array.from(scene.getTransformMatrix().asArray()),
        light.direction.negate().asArray() as ShadowTriple,
        SIZE,
        SIZE,
        camera.viewport,
        boxes,
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
        ),
      );
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
    settings(true);
    await capture("automatic", true);
    if (configuration === "low") {
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
