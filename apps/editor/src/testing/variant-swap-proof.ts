/**
 * Test-build-only proof, on the real GPU, that a world view draws a Material's
 * previous Effect while its changed variant compiles without a GL error: a
 * really-linked program drawn with the new light state, bound by its own light
 * layout (`bindLights` in fixed-light-binding.ts).
 *
 * SwiftShader links inside the call, so "still compiling" is injected: every
 * Effect created after `hold` reports not ready until `release`, exactly as a
 * parallel-compile driver reports a link in flight. The view is a
 * `SceneRenderCoordinator` with `deferPipelines` on a world Scene, drawing
 * steady frames (`render(false)`), as Play and the editor do.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  Vector3,
  type Effect,
  type Light,
  type Material,
  type Mesh,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { applyAuthoredLightProperties, setSceneRenderSettings } from "@haptic/render";
import { glErrorTraceEntries, installGlErrorTrace } from "@haptic/render/gl-error-trace";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { CelMaterial } from "../../../../packages/render/src/cel-material";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { compileMaterialPlan } from "../../../../packages/render/src/material-compiler";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

type Step = {
  name: string;
  /** Frames the view drew while the changed variants were held back. */
  drawn: number;
  held: number;
  /** Materials still drawing the Effect they drew before the change, in every drawn frame. */
  previousDrawn: string[];
  /** Materials drawing a variant compiled for the change, once released. */
  adopted: string[];
  /** GL errors recorded while the previous Effects drew, and after release. */
  glErrors: string[];
  /** Pixels with any channel above 25, in the last frame drawn while the variants were held back. */
  litPixels: number;
  /**
   * The largest channel difference between that frame and a reference: a draw of the lights the previous Effect can
   * still bind, or the first frame the new variants drew where they draw the same lights.
   */
  referenceDifference?: number;
};

/** A world view on a real WebGL2 Engine with the four lit Material kinds: native PBR and Standard, CEL, a graph. */
async function worldView() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
  const camera = new FreeCamera("camera", new Vector3(0, 4.5, -7.5), scene);
  camera.setTarget(new Vector3(0, 0.4, 0));
  camera.minZ = 0.1;
  camera.maxZ = 40;
  scene.activeCamera = camera;
  setFixedShapeLightingWorldScene(scene);
  setSceneRenderSettings(scene, {
    mode: "pbr",
    quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } }),
    shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 2 }),
  });
  const pbr = new PBRMaterial("native pbr", scene);
  pbr.albedoColor = new Color3(0.8, 0.8, 0.8);
  pbr.metallic = 0;
  pbr.roughness = 0.55;
  const standard = new StandardMaterial("native standard", scene);
  standard.diffuseColor = new Color3(0.8, 0.8, 0.8);
  const cel = new CelMaterial(new PBRMaterial("cel source", scene), scene);
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("The default Material did not lower.");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "graph" });
  if (!compiled.ok) throw new Error("The default Material did not compile.");
  const materials: Material[] = [pbr, standard, cel, compiled.material];
  const meshes: Mesh[] = materials.map((material, index) => {
    const x = -3 + index * 2;
    const floor = MeshBuilder.CreateGround(`floor-${index}`, { width: 1.9, height: 6 }, scene);
    floor.position.x = x;
    floor.material = material;
    floor.receiveShadows = true;
    const box = MeshBuilder.CreateBox(`box-${index}`, { size: 0.8 }, scene);
    box.position.set(x, 0.4, 0.6);
    box.material = material;
    box.receiveShadows = true;
    return floor;
  });
  const coordinator = new SceneRenderCoordinator(scene, { deferPipelines: true });
  const order = readbackChannelOrder(false);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  /** One frame: a steady frame (`steady`), or one that validates its presentation (strict, as loading draws). */
  const frame = (steady: boolean) => {
    engine.beginFrame();
    try {
      return coordinator.render(!steady).rendered;
    } finally {
      engine.endFrame();
    }
  };
  /** Strict frames until the view draws every requested variant (preparations run between them). */
  const settle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (coordinator.isReady() && frame(false) && frame(false)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The world view did not settle.");
  };
  const drawnEffects = () => meshes.map((mesh) => mesh.subMeshes[0]!._getDrawWrapper(camera.renderPassId)?.effect ?? null);

  // The driver: every Effect created while held reports not ready until released.
  let holding = false;
  const held = new Set<Effect>();
  const created = new Set<Effect>();
  const createEffect = engine.createEffect.bind(engine) as (...args: unknown[]) => Effect;
  engine.createEffect = ((...args: unknown[]) => {
    const effect = createEffect(...args);
    if (holding && !created.has(effect)) {
      created.add(effect);
      held.add(effect);
      const isReady = effect.isReady.bind(effect);
      effect.isReady = function heldIsReady() { return !held.has(effect) && isReady(); };
    }
    return effect;
  }) as typeof engine.createEffect;

  /**
   * Applies `change` with its variants held back, draws steady frames, then releases them and draws until every
   * Material adopted its new variant.
   */
  const swap = async (name: string, change: () => void): Promise<Step & { pixels: number[]; adoptedPixels: number[] }> => {
    const before = drawnEffects();
    const errorsBefore = glErrorTraceEntries().length;
    holding = true;
    created.clear();
    change();
    let drawn = 0;
    let heldFrames = 0;
    const previousDrawn = new Set(materials.map((material) => material.name));
    let pixels: number[] = [];
    for (let attempt = 0; attempt < 60 && drawn < 3; attempt++) {
      if (frame(true)) {
        drawn++;
        drawnEffects().forEach((effect, index) => { if (effect !== before[index]) previousDrawn.delete(materials[index]!.name); });
        pixels = await read();
      } else {
        heldFrames++;
        // A frame not drawn waits for an asynchronous preparation (a changed shadow set).
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const heldErrors = glErrorTraceEntries().slice(errorsBefore).map((entry) => `${entry.call}: ${entry.code}`);
    holding = false;
    held.clear();
    let adopted: string[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      frame(true);
      adopted = materials.flatMap((material, index) => (created.has(drawnEffects()[index]!) ? [material.name] : []));
      if (adopted.length === materials.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const adoptedPixels = await read();
    const glErrors = glErrorTraceEntries().slice(errorsBefore).map((entry) => `${entry.call}: ${entry.code}`);
    let litPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) if (Math.max(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) > 25) litPixels++;
    return {
      name, drawn, held: heldFrames, previousDrawn: [...previousDrawn], adopted,
      glErrors: [...new Set([...heldErrors, ...glErrors])], litPixels, pixels, adoptedPixels,
    };
  };
  const dispose = () => {
    coordinator.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  };
  return { engine, scene, coordinator, frame, settle, read, swap, dispose };
}

const authored = (light: Light, color: number[], intensity: number, castShadows = false) =>
  applyAuthoredLightProperties(light, { color, intensity, castShadows, range: 9, outerAngle: 70, innerAngle: 40 });

const difference = (pixels: readonly number[], reference: readonly number[]) =>
  Math.max(...pixels.map((value, index) => Math.abs(value - reference[index]!)));

/** A step's record without its pixels. */
const record = ({ pixels: _pixels, adoptedPixels: _adopted, ...step }: Step & { pixels: number[]; adoptedPixels: number[] }, referenceDifference?: number): Step =>
  referenceDifference === undefined ? step : { ...step, referenceDifference };

/**
 * A light stops casting shadows while a lamp switches off. The receivers' previous Effect still samples the light's
 * map, which the light no longer binds, so its sampler takes a placeholder, and the lamp's slot binds an empty light.
 * The new variant (no lamp, no shadow) is one no Material compiled before, and the first frame it draws is what the
 * previous Effect must draw meanwhile: a placeholder reads as an empty shadow map, so the light still lights.
 */
async function shadowLoss(name: string, caster: (scene: Scene) => { castShadows: (enabled: boolean) => void }): Promise<Step> {
  const view = await worldView();
  try {
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 0.35);
    const light = caster(view.scene);
    const lamp = new PointLight("lamp", new Vector3(1.4, 1.2, -1.5), view.scene);
    authored(lamp, [0.3, 0.4, 1], 0.6);
    await view.coordinator.prepare();
    await view.settle();
    const step = await view.swap(name, () => {
      light.castShadows(false);
      setAuthoredLightEnabled(lamp, false);
    });
    return record(step, difference(step.pixels, step.adoptedPixels));
  } finally {
    view.dispose();
  }
}

export async function runVariantSwapProof() {
  const untrace = installGlErrorTrace();
  try {
    const steps: Step[] = [];
    {
      // A light changes kind in a shader slot: the previous Effect's spot block must not receive a point's smaller buffer.
      const view = await worldView();
      try {
        const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
        authored(sun, [1, 0.95, 0.85], 0.7);
        const near = new PointLight("near", new Vector3(-0.6, 1.6, -1.2), view.scene);
        authored(near, [0.3, 0.4, 1], 0.9);
        const spot = new SpotLight("spot", new Vector3(1.4, 3, 0.2), new Vector3(0.1, -1, 0.15), 1, 2, view.scene);
        authored(spot, [0.9, 0.3, 0.2], 1.4);
        const point = new PointLight("point", new Vector3(1.4, 1.2, -1.5), view.scene);
        authored(point, [1, 0.8, 0.2], 0.9);
        setAuthoredLightEnabled(point, false);
        await view.coordinator.prepare();
        // The lights the previous Effect can still bind after the change: its spot slot binds an empty spot.
        setAuthoredLightEnabled(spot, false);
        await view.settle();
        const reference = await view.read();
        setAuthoredLightEnabled(spot, true);
        await view.settle();
        const step = await view.swap("a spot gives way to a point", () => {
          setAuthoredLightEnabled(spot, false, false);
          setAuthoredLightEnabled(point, true);
        });
        steps.push(record(step, difference(step.pixels, reference)));
        // Every Material asks for a variant without the sun, which none compiled before.
        steps.push(record(await view.swap("the sun is removed", () => sun.dispose())));
      } finally {
        view.dispose();
      }
    }
    // Its map is a 2D depth texture, sampled by comparison (PCF).
    steps.push(await shadowLoss("a spot stops casting shadows", (scene) => {
      const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, scene);
      const castShadows = (enabled: boolean) => authored(spot, [0.9, 0.85, 0.7], 1.6, enabled);
      castShadows(true);
      return { castShadows };
    }));
    // Its map is a cube of distances, sampled with Poisson taps.
    steps.push(await shadowLoss("a point light stops casting shadows", (scene) => {
      const point = new PointLight("point", new Vector3(-0.4, 1.8, -0.9), scene);
      const castShadows = (enabled: boolean) => authored(point, [1, 0.8, 0.5], 1.4, enabled);
      castShadows(true);
      return { castShadows };
    }));
    return { steps };
  } finally {
    untrace();
  }
}
