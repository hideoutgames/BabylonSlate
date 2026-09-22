/** Test-only synthetic box-character fixture. Readbacks never run in production. */
import {
  CascadedShadowGenerator,
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

const SIZE = 384;
type Triple = [number, number, number];
type Box = { name: string; center: Triple; size: Triple };
// Touching, hard-normal primitive faces; there are no model or texture assets.
const BOXES: Box[] = [
  { name: "head", center: [0, 3.55, 0], size: [1.6, 1.1, 1.25] },
  { name: "torso", center: [0, 2.25, 0], size: [1.15, 1.5, 0.7] },
  { name: "left-arm", center: [-0.8, 2.2, 0], size: [0.45, 1.6, 0.7] },
  { name: "right-arm", center: [0.8, 2.2, 0], size: [0.45, 1.6, 0.7] },
  { name: "left-leg", center: [-0.325, 0.75, 0], size: [0.5, 1.5, 0.65] },
  { name: "right-leg", center: [0.325, 0.75, 0], size: [0.5, 1.5, 0.65] },
];

/** Independent slab-ray oracle, using authored primitive bounds, never shadow data. */
function blocker(point: Vector3, direction: Vector3, maxDistance = Infinity) {
  let nearest: { name: string; distance: number } | null = null;
  for (const box of BOXES) {
    let near = -Infinity;
    let far = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const origin = point.asArray()[axis]!;
      const ray = direction.asArray()[axis]!;
      const minimum = box.center[axis]! - box.size[axis]! / 2;
      const maximum = box.center[axis]! + box.size[axis]! / 2;
      if (Math.abs(ray) < 1e-8) {
        if (origin < minimum || origin > maximum) far = -Infinity;
      } else {
        const a = (minimum - origin) / ray;
        const b = (maximum - origin) / ray;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
      }
    }
    if (
      near > 1e-4 &&
      far >= near &&
      near < maxDistance &&
      (!nearest || near < nearest.distance)
    )
      nearest = { name: box.name, distance: near };
  }
  return nearest;
}

function samples(scene: Scene, camera: FreeCamera, toLight: Vector3) {
  const result: {
    region: string;
    expected: "lit" | "contact";
    x: number;
    y: number;
  }[] = [];
  const add = (
    point: Vector3,
    normal: Vector3,
    tangentA: Vector3,
    tangentB: Vector3,
    region: string,
  ) => {
    if (Vector3.Dot(normal, toLight) < 0.2) return;
    const toCamera = camera.position.subtract(point);
    if (
      Vector3.Dot(normal, toCamera) <= 0 ||
      blocker(
        point,
        toCamera.normalize(),
        Vector3.Distance(camera.position, point),
      )
    )
      return;
    const hit = blocker(point, toLight);
    // Only compare interior lit regions and near contacts. Exclude geometric
    // penumbra boundaries using four independent nearby visibility rays.
    for (const tangent of [tangentA, tangentB])
      for (const sign of [-1, 1])
        if (
          Boolean(blocker(point.add(tangent.scale(0.12 * sign)), toLight)) !==
          Boolean(hit)
        )
          return;
    if (hit && hit.distance > 1.2) return;
    const screen = Vector3.Project(
      point,
      Matrix.Identity(),
      scene.getTransformMatrix(),
      camera.viewport.toGlobal(SIZE, SIZE),
    );
    const x = Math.round(screen.x),
      y = Math.round(screen.y);
    if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) return;
    result.push({ region, expected: hit ? "contact" : "lit", x, y });
  };
  for (const box of BOXES) {
    for (const axis of [0, 1, 2]) {
      const a = (axis + 1) % 3,
        b = (axis + 2) % 3;
      for (const side of [-1, 1]) {
        const normal = [0, 0, 0],
          ta = [0, 0, 0],
          tb = [0, 0, 0];
        normal[axis] = side;
        ta[a] = 1;
        tb[b] = 1;
        for (let u = -0.4; u <= 0.401; u += 0.08)
          for (let v = -0.4; v <= 0.401; v += 0.08) {
            const point = [...box.center];
            point[axis] = box.center[axis]! + (side * box.size[axis]!) / 2;
            point[a] = box.center[a]! + u * box.size[a]!;
            point[b] = box.center[b]! + v * box.size[b]!;
            add(
              Vector3.FromArray(point),
              Vector3.FromArray(normal),
              Vector3.FromArray(ta),
              Vector3.FromArray(tb),
              box.name,
            );
          }
      }
    }
  }
  for (let x = -1.8; x <= 1.8; x += 0.08)
    for (let z = -1.2; z <= 1.8; z += 0.08)
      add(
        new Vector3(x, 0, z),
        Vector3.Up(),
        Vector3.Right(),
        Vector3.Forward(),
        "ground",
      );
  return result;
}

function regions(
  reference: number[],
  shadowed: number[],
  points: ReturnType<typeof samples>,
) {
  const result: Record<
    string,
    { lit: number; falseDark: number; contact: number; retainedContact: number }
  > = {};
  for (const sample of points) {
    const offset = (sample.y * SIZE + sample.x) * 4;
    // Neutral material means luminance does not depend on a channel swizzle.
    const before = reference[offset + 1]!;
    if (before < 40) continue;
    const value = (result[sample.region] ??= {
      lit: 0,
      falseDark: 0,
      contact: 0,
      retainedContact: 0,
    });
    const ratio = shadowed[offset + 1]! / before;
    if (sample.expected === "lit") {
      value.lit++;
      if (ratio < 0.85) value.falseDark++;
    } else {
      value.contact++;
      if (ratio < 0.85) value.retainedContact++;
    }
  }
  return result;
}

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
      new Vector3(-5, 4.2, -7),
      scene,
    );
    camera.setTarget(new Vector3(0, 1.9, 0));
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.fov = 0.62;
    scene.activeCamera = camera;
    const light = new DirectionalLight(
      "oblique key",
      new Vector3(0.7, -1, 0.5).normalize(),
      scene,
    );
    applyAuthoredLightProperties(light, { intensity: 2, castShadows: true });
    new HemisphericLight("fixed fill", Vector3.Up(), scene).intensity = 0.12;
    const material = new PBRMaterial("neutral matte", scene);
    material.albedoColor = new Color3(0.6, 0.6, 0.6);
    material.metallic = 0;
    material.roughness = 1;
    for (const box of BOXES) {
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
    const settings = (autoBias: boolean) => {
      setSceneRenderSettings(scene, {
        mode,
        shadows: { ...authored, autoBias },
        cel: normalizeCelShadingSettings({
          specularEnabled: false,
          shadowStrength: 1,
        }),
      });
    };
    const captures: {
      name: string;
      png: string;
      effective: unknown;
      regions: ReturnType<typeof regions>;
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
    settings(false);
    light.shadowEnabled = false;
    const reference = await render();
    const points = samples(scene, camera, light.direction.negate());
    captures.push({
      name: "shadow-contribution-off",
      png: png(reference),
      effective: null,
      regions: {},
    });
    light.shadowEnabled = true;
    for (const autoBias of [false, true]) {
      settings(autoBias);
      const image = await render();
      const generator = light.getShadowGenerator()!;
      const map = generator.getShadowMap()!;
      captures.push({
        name: autoBias ? "automatic" : "authored-manual",
        png: png(image),
        effective: {
          generator: generator.getClassName(),
          dimensions: map.getSize(),
          cascades:
            generator instanceof CascadedShadowGenerator
              ? generator.numCascades
              : 1,
          bias: generator.bias,
          normalBias: generator.normalBias,
          filter: generator.filter,
          filteringQuality: generator.filteringQuality,
          minZ: light.shadowMinZ,
          maxZ: light.shadowMaxZ,
          diagnostics: captureShadowDiagnostics(scene, {
            host: "synthetic FrameGraph proof",
            requestedBackend: backend,
            sceneUnits: "synthetic world units",
            meshes: scene.meshes,
          }),
        },
        regions: regions(reference, image, points),
      });
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
      boxes: BOXES,
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
