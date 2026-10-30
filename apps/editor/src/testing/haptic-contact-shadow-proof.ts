/**
 * Test-build-only oracle for Contact Hardening (PCSS) on the light block: a spot light's, the sun's and
 * a point light's shadows drawn from the shadow atlas by HapticLightingBlock, on the real GPU through the Forward
 * FrameGraph, each with ray-cast masks of what blocks the floor's view of the light, and CEL's, which draws it as PCF.
 */
import {
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  Matrix,
  MeshBuilder,
  PointLight,
  Ray,
  Scene,
  ShadowGenerator,
  SpotLight,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Light,
} from "@babylonjs/core";
import {
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
  type RenderMode,
  type ShadowSettings,
} from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { isAtlasShadow } from "../../../../packages/render/src/shadow-atlas";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

/** `passes`: the light's map passes the capture's frame drew, and `originMoved` whether the render origin moved, where counted. */
type Capture = { name: string; atlas: boolean; pixels: number[]; passes?: number; originMoved?: boolean };

export async function runHapticContactShadowProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 80;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    // With the floating render origin, as the app's Engines.
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 3.6, -7), scene);
    camera.setTarget(new Vector3(0, 0.5, 0));
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    // As Play's world Scene.
    setSceneBindsPreviousEffects(scene);
    const quality = normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } });
    // One local shadow and the sun's two cascades, biased past the acne a slanting light shows on the floor (as the
    // light block's PCF oracle is).
    const shadows = (filter: ShadowSettings["filter"]) =>
      normalizeShadowSettings({ cascades: 2, maxLocalLights: 1, depthBias: 0.0008, filter, filterQuality: "medium", softness: 0.05 });
    const settings = (mode: RenderMode, filter: ShadowSettings["filter"]) => setSceneRenderSettings(scene, {
      mode, quality, shadows: shadows(filter),
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      environmentLighting: normalizeEnvironmentLightingSettings({ celStrength: 0.8 }),
    });
    settings("pbr", "pcss");

    const doc = createDefaultMaterialDocument("rough dielectric");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [0.6];
    output[materialPinDefaultPropertyKey("environmentInfluence")] = [0];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("The surface did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "rough dielectric" });
    if (!compiled.ok) throw new Error("The surface did not compile");
    await compiled.ready;

    const floor = MeshBuilder.CreateGround("floor", { width: 9, height: 6 }, scene);
    const box = MeshBuilder.CreateBox("box", { size: 1.2 }, scene);
    box.position.set(-1.8, 0.6, 0.4);
    box.rotation.y = 0.6;
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 1.4, segments: 24 }, scene);
    ball.position.set(1.7, 0.7, 0.2);
    const meshes: AbstractMesh[] = [floor, box, ball];
    for (const mesh of meshes) mesh.material = compiled.material;

    // The light block's PCF oracle's lights: a spot behind the box aiming through it toward the camera, the sun shining
    // toward the camera, a bulb behind and between the box and the ball.
    const lamp = new SpotLight("shadowed lamp", new Vector3(-1.8, 3.4, 1.8), new Vector3(0, -3.4, -2.1).normalize(), 1, 2, scene);
    const sun = new DirectionalLight("sun", new Vector3(-0.25, -0.75, -0.9), scene);
    const bulb = new PointLight("shadowed bulb", new Vector3(0, 2.4, 1.6), scene);
    const lights: Light[] = [lamp, sun, bulb];
    const authored = (light: Light, castShadows: boolean) => applyAuthoredLightProperties(light, light === lamp
      ? { color: [1, 0.95, 0.9], intensity: 50, castShadows, range: 40, outerAngle: 90, innerAngle: 60 }
      : light === sun
        ? { color: [1, 0.95, 0.85], intensity: 3, castShadows, range: 40, outerAngle: 70, innerAngle: 40 }
        : { color: [1, 0.9, 0.8], intensity: 30, castShadows, range: 40 });

    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      await graph.prepare(camera);
      engine.beginFrame();
      try { graph.render(camera, false); } finally { engine.endFrame(); }
      return read();
    };
    /** `light` alone, casting shadows, once its map has drawn (a new map samples neutrally until then). */
    const shadowed = async (light: Light, name: string): Promise<Capture> => {
      for (const other of lights) {
        authored(other, other === light);
        setAuthoredLightEnabled(other, other === light);
      }
      await draw();
      for (let frame = 0; frame < 60 && (light.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() !== 0; frame++) await draw();
      return { name, atlas: isAtlasShadow(light.getShadowGenerator()), pixels: await draw() };
    };
    /** `light` alone, its shadow switched off. */
    const unshadowed = async (light: Light, name: string): Promise<Capture> => {
      light.shadowEnabled = false;
      const pixels = await draw();
      light.shadowEnabled = true;
      return { name, atlas: false, pixels };
    };
    /**
     * `light`'s shadow after the camera, and with it the floating render origin, moved: as the frame after the move drew
     * it, then with its map drawn again at that pose. The camera returns after.
     */
    const originMoved = async (light: Light, name: string): Promise<Capture[]> => {
      const map = (light.getShadowGenerator() as ShadowGenerator).getShadowMap()!;
      let passes = 0;
      const counted = map.onClearObservable.add(() => passes++);
      const home = camera.position.clone();
      const origin = scene.floatingOriginOffset.clone();
      try {
        camera.position.x += 0.35;
        const kept = await draw();
        const keptPasses = passes;
        const originMoved = !scene.floatingOriginOffset.equals(origin);
        map.resetRefreshCounter();
        const redrawn = await draw();
        return [{ name: `${name} origin moved`, atlas: true, pixels: kept, passes: keptPasses, originMoved },
          { name: `${name} origin moved redrawn`, atlas: true, pixels: redrawn, passes: passes - keptPasses }];
      } finally {
        map.onClearObservable.remove(counted);
        camera.position.copyFrom(home);
        await draw();
      }
    };
    const captures: Capture[] = [];
    const blocked: Record<string, number[]> = {};
    /**
     * `light`'s captures (shadowed, unshadowed, unlit) and its floor mask, `toLight` from a floor point, over the floor
     * its shadow covers (`covered`).
     */
    const poses = async (light: Light, name: string, toLight: (point: Vector3) => Vector3, covered?: (point: Vector3) => boolean) => {
      captures.push(await shadowed(light, name));
      // A sun's cascades follow the camera; a local map's depth does not depend on the render origin.
      if (light !== sun) captures.push(...await originMoved(light, name));
      captures.push(await unshadowed(light, `${name} unshadowed`));
      setAuthoredLightEnabled(light, false);
      captures.push({ name: `${name} unlit`, atlas: false, pixels: await draw() });
      blocked[name] = floorShadowMask(scene, camera, canvas, engine.isWebGPU, meshes, toLight, covered);
    };
    // The spot lights nothing past its cone's outer angle, where its shadow's view ends: the spot's mask covers its cone.
    const withinCone = (point: Vector3) =>
      Vector3.Dot(point.subtract(lamp.getAbsolutePosition()).normalize(), lamp.direction.normalizeToNew()) >= Math.cos(lamp.angle / 2);
    await poses(lamp, "spot", (point) => lamp.getAbsolutePosition().subtract(point), withinCone);
    await poses(sun, "sun", () => sun.direction.normalizeToNew().scaleInPlace(-100));
    await poses(bulb, "point", (point) => bulb.getAbsolutePosition().subtract(point));
    settings("cel", "pcss");
    captures.push(await shadowed(lamp, "cel spot"));
    settings("cel", "pcf");
    captures.push(await shadowed(lamp, "cel spot pcf"));
    graph.dispose();
    return { width: canvas.width, height: canvas.height, captures, blocked };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}

/**
 * Per pixel, in readPixels' rows (WebGL2's bottom-up, WebGPU's swap chain texture's top-down): 1 where the box or the
 * ball blocks the floor's view of a light (`toLight`: from a floor point to the light), 0 where nothing does, -1 off
 * the floor or off the floor the light's shadow covers (`covered`).
 */
export function floorShadowMask(
  scene: Scene, camera: FreeCamera, canvas: HTMLCanvasElement, topDown: boolean, meshes: AbstractMesh[],
  toLight: (point: Vector3) => Vector3, covered: (point: Vector3) => boolean = () => true,
): number[] {
  const [floor, ...casters] = meshes;
  const mask: number[] = [];
  for (let row = 0; row < canvas.height; row++) {
    const y = topDown ? row + 0.5 : canvas.height - row - 0.5;
    for (let column = 0; column < canvas.width; column++) {
      const hit = scene.pickWithRay(scene.createPickingRay(column + 0.5, y, Matrix.Identity(), camera), (mesh) => meshes.includes(mesh));
      if (hit?.pickedMesh !== floor || !hit.pickedPoint || !covered(hit.pickedPoint)) {
        mask.push(-1);
        continue;
      }
      const offset = toLight(hit.pickedPoint);
      const length = offset.length();
      const towards = new Ray(hit.pickedPoint, offset.scaleInPlace(1 / length), length);
      mask.push(scene.pickWithRay(towards, (mesh) => casters.includes(mesh))?.hit ? 1 : 0);
    }
  }
  return mask;
}
