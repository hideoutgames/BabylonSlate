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
  type ShadowGenerator,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { applyAuthoredLightProperties, setSceneRenderSettings } from "@haptic/render";
import { glErrorTraceEntries, installGlErrorTrace } from "@haptic/render/gl-error-trace";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { CelMaterial } from "../../../../packages/render/src/cel-material";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { isForwardLightExcluded, setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { compileMaterialPlan } from "../../../../packages/render/src/material-compiler";
import { warmSpawnables } from "../../../../packages/render/src/spawnable-warm";
import { createLoadRehearsal } from "../../../../packages/render/src/load-rehearsal";
import { AUTHORED_LIGHT_PREFIX } from "../../../../packages/render/src/scene-illumination";
import { findSceneShadowController } from "../../../../packages/render/src/shadow-controller";
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
  /** The driver, step by step: hold every new Effect, then release those `filter` picks (all by default). */
  const driver = {
    hold: () => { holding = true; created.clear(); },
    release: (filter: (effect: Effect) => boolean = () => true) => {
      for (const effect of held) if (filter(effect)) held.delete(effect);
    },
    stop: () => { holding = false; held.clear(); },
    created,
  };
  return { engine, scene, coordinator, materials, frame, settle, read, swap, drawnEffects, driver, dispose };
}

const authored = (light: Light, color: number[], intensity: number, castShadows = false) =>
  applyAuthoredLightProperties(light, { color, intensity, castShadows, range: 9, outerAngle: 70, innerAngle: 40 });

const difference = (pixels: readonly number[], reference: readonly number[]) =>
  Math.max(...pixels.map((value, index) => Math.abs(value - reference[index]!)));

/** A step's record without its pixels. */
const record = (step: Step & { pixels?: number[]; adoptedPixels?: number[] }, referenceDifference?: number): Step => {
  const kept: Step & { pixels?: number[]; adoptedPixels?: number[] } = { ...step };
  delete kept.pixels;
  delete kept.adoptedPixels;
  return referenceDifference === undefined ? kept : { ...kept, referenceDifference };
};

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

/** A shadow map's caster depth variant (Babylon's shadow defines), as opposed to a receiver's colour variant. */
const isDepthEffect = (effect: Effect) => effect.defines.includes("#define SM_FLOAT");

/** Pixels darker than the reference by more than 30 (summed channels). */
const darkened = (pixels: readonly number[], reference: readonly number[]) => {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const drop = (reference[index]! + reference[index + 1]! + reference[index + 2]!) - (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!);
    if (drop > 30) count++;
  }
  return count;
};

/**
 * A light starts casting shadows mid-session. The view keeps drawing: each receiver draws its previous Effect, and the
 * new map waits for its casters' depth variants. The receivers' shadowed variants link first and sample the map
 * before it ever drew, so it must read as lit (a cube of distances reads zero, an occluder at the light, unless its
 * darkness is neutral); once the casters link, the map draws and the boxes' shadows appear on the floors.
 */
async function shadowGain(name: string, caster: (scene: Scene) => { light: Light; castShadows: (enabled: boolean) => void }) {
  const view = await worldView();
  try {
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 0.3);
    const { light, castShadows } = caster(view.scene);
    castShadows(false);
    await view.coordinator.prepare();
    await view.settle();
    const unshadowed = await view.read();
    const before = view.drawnEffects();
    const errorsBefore = glErrorTraceEntries().length;
    const names = view.materials.map((material) => material.name);
    const drawn = { held: 0, previous: 0, neutral: 0 };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
    view.driver.hold();
    castShadows(true);
    let heldPixels: number[] = [];
    for (let index = 0; index < 3; index++) {
      if (!view.frame(true)) drawn.held++;
      else if (view.drawnEffects().every((effect, at) => effect === before[at])) drawn.previous++;
      heldPixels = await view.read();
    }
    // The receivers' variants link; the casters' do not yet. Wait until the casters have asked for theirs (the
    // generator loads its shaders first), so the map is known to be waiting for them.
    view.driver.release((effect) => !isDepthEffect(effect));
    const casters = () => [...view.driver.created].filter(isDepthEffect).length;
    let adopted: string[] = [];
    let neutralPixels: number[] = [];
    for (let attempt = 0; attempt < 150 && (adopted.length < names.length || !casters()); attempt++) {
      view.driver.release((effect) => !isDepthEffect(effect));
      if (view.frame(true)) drawn.neutral++;
      adopted = names.filter((_, at) => view.driver.created.has(view.drawnEffects()[at]!));
      neutralPixels = await view.read();
      await pause();
    }
    const requested = casters();
    // The casters link: the map draws on the first frame they are all ready.
    view.driver.stop();
    const map = light.getShadowGenerator() as ShadowGenerator | null;
    let shadowPixels = 0;
    for (let attempt = 0; attempt < 150 && !(shadowPixels = darkened(await view.read(), unshadowed)); attempt++) {
      view.frame(true);
      await pause();
    }
    return {
      name, drawn, adopted, casters: requested, mapDrawn: map?.getDarkness() === 0,
      heldDifference: difference(heldPixels, unshadowed),
      neutralDifference: difference(neutralPixels, unshadowed),
      shadowPixels,
      glErrors: [...new Set(glErrorTraceEntries().slice(errorsBefore).map((entry) => `${entry.call}: ${entry.code}`))],
    };
  } finally {
    view.dispose();
  }
}

/** Pixels whose summed channels differ from the reference by more than 30. */
const changed = (pixels: readonly number[], reference: readonly number[]) => {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const delta = Math.abs(pixels[index]! - reference[index]!) + Math.abs(pixels[index + 1]! - reference[index + 1]!) +
      Math.abs(pixels[index + 2]! - reference[index + 2]!);
    if (delta > 30) count++;
  }
  return count;
};

/**
 * An actor spawns mid-session with a Material variant nothing compiled: a box with a two-sided red Material, on a
 * floor under a shadowed spot. While its variant compiles the view keeps drawing and the box is left out of every
 * pass: the frame is the frame before the spawn, so no depth, shadow or colour of it shows (its shadow-map depth
 * variant is one the other boxes already use, so a caster list that kept it would draw its shadow at once). Once its
 * variant links, the box appears.
 */
async function spawnReveal() {
  const view = await worldView();
  try {
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 0.4);
    const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, view.scene);
    authored(spot, [0.9, 0.85, 0.7], 1.6, true);
    await view.coordinator.prepare();
    await view.settle();
    const before = await view.read();
    const errorsBefore = glErrorTraceEntries().length;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
    view.driver.hold();
    const material = new StandardMaterial("spawned", view.scene);
    material.diffuseColor = new Color3(0.9, 0.1, 0.1);
    material.backFaceCulling = false;
    material.twoSidedLighting = true;
    const box = MeshBuilder.CreateBox("spawned", { size: 0.6 }, view.scene);
    box.position.set(1, 0.3, -1.2);
    box.material = material;
    box.receiveShadows = true;
    const frames = { drawn: 0, held: 0 };
    let hiddenDifference = 0;
    for (let index = 0; index < 3; index++) {
      if (view.frame(true)) frames.drawn++;
      else frames.held++;
      hiddenDifference = Math.max(hiddenDifference, difference(await view.read(), before));
    }
    const effect = () => box.subMeshes[0]!._getDrawWrapper(view.scene.activeCamera!.renderPassId)?.effect ?? null;
    const compiling = !!effect() && view.driver.created.has(effect()!) && !effect()!.isReady();
    view.driver.stop();
    let appeared = 0;
    for (let attempt = 0; attempt < 100 && !(appeared = changed(await view.read(), before)); attempt++) {
      view.frame(true);
      await pause();
    }
    return {
      frames, compiling, hiddenDifference, appeared,
      glErrors: [...new Set(glErrorTraceEntries().slice(errorsBefore).map((entry) => `${entry.call}: ${entry.code}`))],
    };
  } finally {
    view.dispose();
  }
}

/**
 * An actor spawns with a Material Play's load warmed (`warmSpawnables`, on a staged box it then disposed): no program
 * links, on the real context, and the box draws in its first frame. Babylon 9.29's `forceCompilation` compiles on a
 * temporary submesh it never disposes, whose reference keeps the Effect in the Engine's cache after the staged mesh
 * is gone.
 */
async function warmSpawn() {
  const view = await worldView();
  try {
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 0.4);
    const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, view.scene);
    authored(spot, [0.9, 0.85, 0.7], 1.6, true);
    await view.coordinator.prepare();
    await view.settle();
    const material = new StandardMaterial("warmed", view.scene);
    material.diffuseColor = new Color3(0.1, 0.9, 0.2);
    await warmSpawnables(view.scene, { materials: [material], containers: [] });
    const staged = view.scene.meshes.filter((mesh) => mesh.name.startsWith("spawnable-warm:")).length;
    await view.settle();
    const before = await view.read();
    const errorsBefore = glErrorTraceEntries().length;
    const gl = (view.engine as unknown as { _gl: WebGL2RenderingContext })._gl;
    const linkProgram = gl.linkProgram;
    let links = 0;
    gl.linkProgram = function countedLinkProgram(this: WebGL2RenderingContext, program: WebGLProgram) {
      links++;
      return linkProgram.call(this, program);
    };
    try {
      const box = MeshBuilder.CreateBox("warmed", { size: 0.6 }, view.scene);
      box.position.set(1, 0.3, -1.2);
      box.material = material;
      box.receiveShadows = true;
      const drawn = view.frame(true);
      const appeared = changed(await view.read(), before);
      for (let index = 0; index < 2; index++) view.frame(true);
      return {
        staged, links, drawn, appeared,
        glErrors: [...new Set(glErrorTraceEntries().slice(errorsBefore).map((entry) => `${entry.call}: ${entry.code}`))],
      };
    } finally {
      gl.linkProgram = linkProgram;
    }
  } finally {
    view.dispose();
  }
}

/**
 * A load rehearses its authored lights' changes (`createLoadRehearsal`): each change is applied, drawn once by a
 * strict frame and reverted. Afterwards a point switching off and a spot starting to cast shadows link no program on the
 * real context, and the view never holds.
 */
async function rehearsedChanges() {
  const view = await worldView();
  try {
    const sun = new DirectionalLight(`${AUTHORED_LIGHT_PREFIX}sun`, new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 0.4);
    const point = new PointLight(`${AUTHORED_LIGHT_PREFIX}point`, new Vector3(-0.6, 1.6, -1.2), view.scene);
    authored(point, [0.3, 0.4, 1], 0.9);
    const spot = new SpotLight(`${AUTHORED_LIGHT_PREFIX}spot`, new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, view.scene);
    authored(spot, [0.9, 0.85, 0.7], 1.4);
    await view.coordinator.prepare();
    await view.settle();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
    const rehearsal = createLoadRehearsal(view.scene);
    for (let attempt = 0; attempt < 600 && !rehearsal.done; attempt++) {
      rehearsal.check();
      if (view.coordinator.isReady()) rehearsal.frame(() => view.frame(false));
      await pause();
    }
    const report = rehearsal.report();
    await view.settle();
    const gl = (view.engine as unknown as { _gl: WebGL2RenderingContext })._gl;
    const linkProgram = gl.linkProgram;
    let links = 0;
    gl.linkProgram = function countedLinkProgram(this: WebGL2RenderingContext, program: WebGLProgram) {
      links++;
      return linkProgram.call(this, program);
    };
    const errorsBefore = glErrorTraceEntries().length;
    /** Frames from `apply` until the drawn Effects change and `live` holds, counting links and held frames. */
    const change = async (apply: () => void, live = () => true) => {
      links = 0;
      const before = view.drawnEffects();
      apply();
      let held = 0;
      let frames = 0;
      for (; frames < 30 && (view.drawnEffects().every((effect, index) => effect === before[index]) || !live()); frames++) {
        if (!view.frame(true)) held++;
        await pause();
      }
      return { links, held, frames, changed: view.drawnEffects().some((effect, index) => effect !== before[index]) };
    };
    try {
      const pointOff = await change(() => setAuthoredLightEnabled(point, false));
      // One change at a time, as rehearsed: the point back on first (the variants the load drew).
      await change(() => setAuthoredLightEnabled(point, true));
      // Until the spot's map draws (its casters' depth programs in use), not only the receivers' swap.
      const spotShadows = await change(() => authored(spot, [0.9, 0.85, 0.7], 1.4, true),
        () => (spot.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() === 0);
      return {
        report, pointOff, spotShadows,
        glErrors: [...new Set(glErrorTraceEntries().slice(errorsBefore).map((entry) => `${entry.call}: ${entry.code}`))],
      };
    } finally {
      gl.linkProgram = linkProgram;
    }
  } finally {
    view.dispose();
  }
}

/** An admission a light's approach brings: what it linked and how long the previous variants drew. */
type Admission = {
  /** The light was admitted (the Forward budget's, or a shadow map's) by the last frame. */
  admitted: boolean;
  /** Programs linked while the light waited within reach of the admission, before it. */
  linksAhead: number;
  /** Programs linked from the change that admits it until every Material drew its new variant. */
  linksAtAdmission: number;
  /** Steady frames after that change in which some Material still drew its previous variant. */
  lateFrames: number;
  held: number;
  glErrors: string[];
};

/**
 * A light comes within reach of an admission and then into it, approaching (it waits within the prediction margin
 * first) or jumping straight in: a spot the Forward budget (two local lights) leaves out takes a point's place, and a
 * shadowed spot takes a farther point's shadow map (two local maps, the other a spot's). Approached, the admission's
 * variants were compiled ahead, so it links no program; jumping in, the same admission links them.
 */
async function predictedAdmissions() {
  const run = async (admission: "forward" | "shadow", approach: boolean): Promise<Admission> => {
    const view = await worldView();
    try {
      setSceneRenderSettings(view.scene, {
        mode: "pbr",
        quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: admission === "forward" ? 2 : 16 } }),
        shadows: normalizeShadowSettings({ cascades: 1, localLightMode: "manual", maxLocalLights: 2 }),
      });
      const sun = new DirectionalLight(`${AUTHORED_LIGHT_PREFIX}sun`, new Vector3(0.3, -1, 0.4), view.scene);
      authored(sun, [1, 0.95, 0.85], 0.4);
      const shadows = admission === "shadow";
      const near = shadows
        ? new SpotLight(`${AUTHORED_LIGHT_PREFIX}near`, new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, view.scene)
        : new PointLight(`${AUTHORED_LIGHT_PREFIX}near`, new Vector3(-0.6, 1.6, -1.2), view.scene);
      authored(near, [0.3, 0.4, 1], 0.9, shadows);
      const far = new PointLight(`${AUTHORED_LIGHT_PREFIX}far`, shadows ? new Vector3(1.5, 1.8, 3) : new Vector3(1.4, 1.2, -1.5), view.scene);
      authored(far, [1, 0.8, 0.2], 0.9, shadows);
      const spot = new SpotLight(`${AUTHORED_LIGHT_PREFIX}spot`, new Vector3(0, 3.2, 24), new Vector3(0.05, -1, 0.2), 1.2, 2, view.scene);
      authored(spot, [0.9, 0.85, 0.7], 1.4, shadows);
      await view.coordinator.prepare();
      await view.settle();
      for (let index = 0; index < 4; index++) view.frame(true);
      const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
      const pass = () => view.engine.getRenderPassNames().lastIndexOf("Forward objects#0");
      const floors = view.scene.meshes.filter((mesh) => mesh.name.startsWith("floor-"));
      const drawn = () => floors.map((mesh) => mesh.subMeshes[0]!._getDrawWrapper(pass())?.effect ?? null);
      const admitted = () => shadows
        ? findSceneShadowController(view.scene)?.generator(spot) != null && findSceneShadowController(view.scene)?.generator(far) == null
        : !isForwardLightExcluded(spot);
      const gl = (view.engine as unknown as { _gl: WebGL2RenderingContext })._gl;
      const linkProgram = gl.linkProgram;
      let links = 0;
      gl.linkProgram = function countedLinkProgram(this: WebGL2RenderingContext, program: WebGLProgram) {
        links++;
        return linkProgram.call(this, program);
      };
      const errorsBefore = glErrorTraceEntries().length;
      try {
        let linksAhead = 0;
        if (approach) {
          // Within the prediction margin of the cut-off (the farther local light's ranking distance), still left out.
          spot.position.set(0, 3.2, shadows ? 6 : 1);
          for (let index = 0; index < 12; index++) {
            view.frame(true);
            await pause();
          }
          linksAhead = links;
        }
        if (admitted()) throw new Error(`The ${admission} admission came before the change.`);
        links = 0;
        const before = drawn();
        spot.position.set(0, 3.2, shadows ? 0 : -4.5);
        let lateFrames = 0;
        let held = 0;
        for (let index = 0; index < 30; index++) {
          if (!view.frame(true)) held++;
          else if (drawn().some((effect, slot) => effect === before[slot])) lateFrames++;
          else break;
          await pause();
        }
        return {
          admitted: admitted(), linksAhead, linksAtAdmission: links, lateFrames, held,
          glErrors: [...new Set(glErrorTraceEntries().slice(errorsBefore).map((entry) => `${entry.call}: ${entry.code}`))],
        };
      } finally {
        gl.linkProgram = linkProgram;
      }
    } finally {
      view.dispose();
    }
  };
  return {
    forward: { approached: await run("forward", true), jumped: await run("forward", false) },
    shadow: { approached: await run("shadow", true), jumped: await run("shadow", false) },
  };
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
    const shadowGains = [
      // Its map is a 2D depth texture, sampled by comparison (PCF).
      await shadowGain("a spot starts casting shadows", (scene) => {
        const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, scene);
        return { light: spot, castShadows: (enabled) => authored(spot, [0.9, 0.85, 0.7], 1.6, enabled) };
      }),
      // Its map is a cube of distances, sampled with Poisson taps.
      await shadowGain("a point light starts casting shadows", (scene) => {
        const point = new PointLight("point", new Vector3(-0.4, 1.8, -0.9), scene);
        return { light: point, castShadows: (enabled) => authored(point, [1, 0.8, 0.5], 1.4, enabled) };
      }),
    ];
    return {
      steps, shadowGains, spawn: await spawnReveal(), warmSpawn: await warmSpawn(), rehearsed: await rehearsedChanges(),
      predicted: await predictedAdmissions(),
    };
  } finally {
    untrace();
  }
}
