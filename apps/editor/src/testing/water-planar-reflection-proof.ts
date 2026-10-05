/** Test-build-only readback of the planar water reflection a SceneRenderCoordinator view draws. */
import { Color3, Color4, Constants, Engine, FreeCamera, HemisphericLight, MeshBuilder, Scene, StandardMaterial, Vector3, type AbstractEngine } from "@babylonjs/core";
import { createDefaultWaterDefinition, DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality, normalizeWaterBody, qualityPresetPatch } from "@babylonslate/core";
import {
  createAppWebGpuEngine, createWaterMesh, setSceneRenderSettings, waterPlanarReflectionDiagnostics, waterPlanarReflectionForCamera,
  type WaterPlanarReflection,
} from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

/** Half-float bits (as readback may return them) to numbers. */
function fromHalf(bits: number): number {
  const exponent = (bits >> 10) & 0x1f, fraction = bits & 0x3ff, sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Where an eye sees `object` mirrored in the plane y = planeY: the eye-to-reflected-object ray meets the plane. */
function seenAt(eye: Vector3, object: Vector3, planeY: number): Vector3 {
  const reflected = new Vector3(object.x, 2 * planeY - object.y, object.z);
  return Vector3.Lerp(eye, reflected, (eye.y - planeY) / (eye.y - reflected.y));
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 16));

/**
 * A flat built-in lake at Ultra (Planar reflections) with an unlit box above it and a thin column that straddles the
 * water on the mirror's line of sight to the box. `far` moves the whole scene 100 km from the world origin.
 */
export async function runWaterPlanarReflectionProof(
  backend: "webgl2" | "webgpu", pipeline: "legacyDisplay" | "sceneLinear" = "legacyDisplay", far = false,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 128; canvas.height = 96;
  document.getElementById("root")!.append(canvas);
  // Match the app: exact sRGB conversions and large-world rendering (floating origin).
  const engine: AbstractEngine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true, useExactSrgbConversions: true,
  });
  const scene = new Scene(engine);
  let coordinator: SceneRenderCoordinator | undefined;
  try {
    for (let group = 0; group < 4; group += 1) scene.setRenderingAutoClearDepthStencil(group, false);
    setSceneRenderSettings(scene, {
      ...(pipeline === "sceneLinear" ? { mode: "pbr", effects: { ...DEFAULT_RENDER_EFFECTS, colorPipeline: { version: 1, mode: "sceneLinear" } } } : {}),
      quality: normalizeRenderingQuality(qualityPresetPatch("ultra")),
    });
    scene.clearColor = new Color4(0.3, 0.55, 0.85, 1);
    new HemisphericLight("light", Vector3.Up(), scene);
    const origin = far ? new Vector3(100000, 0, -100000) : Vector3.Zero();
    const at = (x: number, y: number, z: number) => origin.add(new Vector3(x, y, z));
    const camera = new FreeCamera("camera", at(0, 4, -10), scene);
    camera.setTarget(at(0, 0, 4));
    camera.minZ = 0.5; camera.maxZ = 200;
    scene.activeCamera = camera;
    const paint = (name: string, color: Color3) => {
      const material = new StandardMaterial(name, scene);
      material.disableLighting = true;
      material.emissiveColor = color;
      return material;
    };
    // The box the water reflects, right of centre so a mirrored or flipped mapping misses it.
    const box = MeshBuilder.CreateBox("beacon", { size: 2 }, scene);
    box.position.copyFrom(at(2, 1.5, 12));
    box.material = paint("beacon", new Color3(0.8, 0.4, 0.2));
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 60, length: 60, resolution: 8 }), createDefaultWaterDefinition());
    lake.position.copyFrom(origin);
    // The mirror eye looks up through the water at the box. A column straddling the plane on that line of sight
    // passes CPU culling (it reaches above the water) but its submerged part must be clipped on the GPU by the
    // oblique near plane, or it hides the box's reflection.
    const mirrorEye = at(0, -4, -10);
    const boxCentre = box.position.clone();
    const blocking = Vector3.Lerp(mirrorEye, boxCentre, 2 / (boxCentre.y - mirrorEye.y));
    // It spans y = −3 to 0.6: only its submerged part lies on that line of sight.
    const column = MeshBuilder.CreateBox("column", { width: 0.6, depth: 0.6, height: 3.6 }, scene);
    column.position.set(blocking.x, origin.y - 1.2, blocking.z);
    column.material = paint("column", new Color3(0.1, 0.9, 0.2));
    // Built-in water draws while the view renders; its lookup is what requests the reflection.
    let latest: WaterPlanarReflection | null = null;
    lake.onBeforeRenderObservable.add(() => { latest = waterPlanarReflectionForCamera(scene, scene.activeCamera); });
    coordinator = new SceneRenderCoordinator(scene);
    const prepared = await coordinator.prepare();
    const order = readbackChannelOrder(engine.isWebGPU);
    const results: unknown[] = [];
    let output: number[] | undefined;
    let reflection: WaterPlanarReflection | null = null;
    for (let attempt = 0; attempt < 600 && !output; attempt += 1) {
      latest = null;
      if (!coordinator.isReady()) { await sleep(); continue; }
      engine.beginFrame();
      let result: ReturnType<SceneRenderCoordinator["render"]>;
      try { result = coordinator.render(); } finally { engine.endFrame(); }
      results.push({ path: result.path, rendered: result.rendered });
      if (result.rendered && latest) {
        reflection = latest;
        // Read this frame's output before a later frame replaces WebGPU's canvas texture.
        const raw = await engine.readPixels(0, 0, canvas.width, canvas.height);
        output = toRgbaPixels(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), order);
        break;
      }
      await sleep();
    }
    if (!output || !reflection) throw new Error(`The planar reflection never drew: ${JSON.stringify(results.slice(-5))}`);
    const planar: WaterPlanarReflection = reflection;
    const texture = planar.texture.getInternalTexture();
    if (!texture) throw new Error("The planar reflection has no texture.");
    const raw = await engine._readTexturePixels(texture, texture.width, texture.height, -1, 0, null, true, false);
    const values = raw instanceof Uint16Array ? Array.from(raw, fromHalf)
      : raw instanceof Uint8Array || raw instanceof Uint8ClampedArray ? Array.from(raw, (value) => value / 255)
      : Array.from(raw as Float32Array);
    const bgra = texture.format === Constants.TEXTUREFORMAT_BGRA;
    /** RGBA of the texel at uv (u, v), with v counted from the first row in texture memory. */
    const texel = (u: number, v: number) => {
      const x = Math.min(texture.width - 1, Math.max(0, Math.floor(u * texture.width)));
      const y = Math.min(texture.height - 1, Math.max(0, Math.floor(v * texture.height)));
      const index = (y * texture.width + x) * 4;
      const [a, b, c, alpha] = values.slice(index, index + 4) as [number, number, number, number];
      return bgra ? [c, b, a, alpha] : [a, b, c, alpha];
    };
    // Positions the water shader would project: relative to its origin (the view's eye under floating origin).
    const eye = camera.globalPosition.clone();
    const shaderOrigin = scene.floatingOriginMode ? eye : Vector3.Zero();
    const clip = (point: Vector3) => {
      const relative = point.subtract(shaderOrigin);
      const m = planar.viewProjection.m;
      const x = relative.x * m[0]! + relative.y * m[4]! + relative.z * m[8]! + m[12]!;
      const y = relative.x * m[1]! + relative.y * m[5]! + relative.z * m[9]! + m[13]!;
      const w = relative.x * m[3]! + relative.y * m[7]! + relative.z * m[11]! + m[15]!;
      return { x: x / w, y: y / w };
    };
    /**
     * The texel a water point reflects under each candidate NDC-to-uv mapping: `contract` (v = 0.5 + 0.5·y, the
     * first memory row at NDC y = −1), the opposite row order, and a mirrored u.
     */
    const sample = (point: Vector3) => {
      const ndc = clip(point);
      const u = 0.5 + 0.5 * ndc.x;
      return {
        ndc: [ndc.x, ndc.y],
        contract: texel(u, 0.5 + 0.5 * ndc.y),
        flippedV: texel(u, 0.5 - 0.5 * ndc.y),
        mirroredU: texel(0.5 - 0.5 * ndc.x, 0.5 + 0.5 * ndc.y),
      };
    };
    const boxHit = sample(seenAt(eye, boxCentre, planar.planeY));
    // The column's above-water face toward the mirror eye: drawn, so the column did reach the mirror pass.
    const columnFace = new Vector3(blocking.x, origin.y + 0.3, blocking.z - 0.3);
    const columnHit = clip(columnFace);
    const columnTexel = texel(0.5 + 0.5 * columnHit.x, 0.5 + 0.5 * columnHit.y);
    // The column's submerged point projects onto the box's texel: it is on the mirror's line of sight.
    const blockingNdc = clip(blocking);
    // A water point left of the view whose reflected ray rises into empty sky.
    const skyHit = sample(at(-6, 0, 2));
    // The box as the view shows it directly (canvas readback is bottom-up on WebGL2, top-down on WebGPU).
    const direct = Vector3.TransformCoordinates(boxCentre, camera.getViewMatrix().multiply(camera.getProjectionMatrix()));
    const px = Math.floor((0.5 + 0.5 * direct.x) * canvas.width);
    const fromBottom = Math.floor((0.5 + 0.5 * direct.y) * canvas.height);
    const row = engine.isWebGPU ? canvas.height - 1 - fromBottom : fromBottom;
    const outputIndex = (row * canvas.width + px) * 4;
    return {
      backend, pipeline, far, prepared, results: results.slice(-3),
      floatingOrigin: scene.floatingOriginMode,
      target: { width: texture.width, height: texture.height, format: texture.format, type: texture.type, gammaSpace: planar.gammaSpace },
      view: { width: engine.getRenderWidth(true), height: engine.getRenderHeight(true) },
      planeY: planar.planeY - origin.y, meshIsLake: planar.mesh === lake,
      boxHit, skyHit, columnTexel, blockingNdc: [blockingNdc.x, blockingNdc.y], boxDirect: Array.from(output.slice(outputIndex, outputIndex + 3)),
      diagnostics: waterPlanarReflectionDiagnostics(scene),
      sceneMembership: { cameras: scene.cameras.length, textures: scene.textures.filter((t) => t.name.startsWith("waterPlanarReflection")).length },
    };
  } finally {
    coordinator?.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
