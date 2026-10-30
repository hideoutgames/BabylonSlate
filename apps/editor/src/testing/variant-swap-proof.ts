/**
 * Test-build-only proof, on the real GPU, that a world view keeps drawing while new variants compile, with graph
 * Materials on the lighting plan's light block: a Material draws its previous Effect while a variant a change asked
 * for (fog switched on) compiles, without a GL error; a light that starts casting shadows changes no receiver's Effect
 * and its map samples neutrally until its casters' depth variants have compiled; a spawn with a variant nothing
 * compiled stays hidden until it has; and a spawn whose Material Play's load warmed links no program.
 *
 * SwiftShader links inside the call, so "still compiling" is injected: every Effect created after `hold` reports not
 * ready until `release`, exactly as a parallel-compile driver reports a link in flight. The view is a
 * `SceneRenderCoordinator` with `deferPipelines` on a world Scene, drawing steady frames (`render(false)`), as Play and
 * the editor do.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  MeshBuilder,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
  type Effect,
  type Light,
  type Mesh,
  type NodeMaterial,
  type ShadowGenerator,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { applyAuthoredLightProperties, setHapticLighting, setSceneRenderSettings } from "@haptic/render";
import { glErrorTraceEntries, installGlErrorTrace } from "@haptic/render/gl-error-trace";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { compileMaterialPlan } from "../../../../packages/render/src/material-compiler";
import { warmSpawnables } from "../../../../packages/render/src/spawnable-warm";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

/** A graph Material of one base colour; `variant` changes its document's settings, so it compiles its own program. */
async function graphMaterial(scene: Scene, name: string, color: number[], variant: (doc: MaterialDocument) => void = () => undefined) {
  const doc = createDefaultMaterialDocument(name);
  doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
  variant(doc);
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(`${name} did not lower.`);
  const compiled = compileMaterialPlan(lowered.plan, { scene, name });
  if (!compiled.ok) throw new Error(`${name} did not compile.`);
  return compiled.material;
}

/** A world view on a real WebGL2 Engine: three graph Materials on floors with a box each. */
async function worldView() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  // Graph Materials compile with the light block.
  setHapticLighting(engine, true);
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
  const materials: NodeMaterial[] = [];
  for (const [index, color] of [[0.8, 0.8, 0.8], [0.8, 0.6, 0.5], [0.5, 0.7, 0.8]].entries())
    materials.push(await graphMaterial(scene, `graph ${index}`, color));
  const meshes: Mesh[] = materials.map((material, index) => {
    const x = -2 + index * 2;
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
  const reasons = new Set<string>();
  const frame = (steady: boolean) => {
    engine.beginFrame();
    try {
      const result = coordinator.render(!steady);
      if (!result.rendered && result.reason) reasons.add(result.reason);
      return result.rendered;
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
  /** The Effect each floor draws with in the view's object pass. */
  const drawnEffects = () => {
    const pass = engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    return meshes.map((mesh) => (pass < 0 ? null : mesh.subMeshes[0]!._getDrawWrapper(pass)?.effect ?? null));
  };

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
  const dispose = () => {
    coordinator.dispose();
    scene.dispose();
    setHapticLighting(engine, false);
    engine.dispose();
    canvas.remove();
  };
  /** The driver, step by step: hold every new Effect, then release them. */
  const driver = {
    hold: () => { holding = true; created.clear(); },
    stop: () => { holding = false; held.clear(); },
    created,
  };
  return { engine, scene, coordinator, materials, frame, settle, read, drawnEffects, driver, reasons, dispose };
}

const authored = (light: Light, color: number[], intensity: number, castShadows = false) =>
  applyAuthoredLightProperties(light, { color, intensity, castShadows, range: 9, outerAngle: 70, innerAngle: 40 });

const difference = (pixels: readonly number[], reference: readonly number[]) =>
  Math.max(...pixels.map((value, index) => Math.abs(value - reference[index]!)));

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

/** Pixels darker than the reference by more than 30 (summed channels). */
const darkened = (pixels: readonly number[], reference: readonly number[]) => {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const drop = (reference[index]! + reference[index + 1]! + reference[index + 2]!) - (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!);
    if (drop > 30) count++;
  }
  return count;
};

const glErrorsSince = (start: number) => [...new Set(glErrorTraceEntries().slice(start).map((entry) => `${entry.call}: ${entry.code}`))];
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Fog switches on, which every Material compiles a variant for (its fog define): with the variants held back, each
 * Material keeps drawing its previous Effect in every steady frame, which shows the scene as it was, with no GL error;
 * released, every Material draws its new, fogged variant.
 */
async function fogSwap() {
  const view = await worldView();
  try {
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 2.2);
    const lamp = new PointLight("lamp", new Vector3(-0.6, 1.6, -1.2), view.scene);
    authored(lamp, [0.3, 0.4, 1], 3);
    await view.coordinator.prepare();
    await view.settle();
    const before = view.drawnEffects();
    const reference = await view.read();
    const errorsBefore = glErrorTraceEntries().length;
    view.driver.hold();
    view.scene.fogMode = Scene.FOGMODE_LINEAR;
    view.scene.fogColor = new Color3(0.7, 0.75, 0.8);
    view.scene.fogStart = 2;
    view.scene.fogEnd = 14;
    let drawn = 0;
    let held = 0;
    let previous = 0;
    let heldDifference = 0;
    for (let attempt = 0; attempt < 60 && drawn < 3; attempt++) {
      if (view.frame(true)) {
        drawn++;
        if (view.drawnEffects().every((effect, index) => effect === before[index])) previous++;
        heldDifference = Math.max(heldDifference, difference(await view.read(), reference));
      } else {
        held++;
        await pause();
      }
    }
    view.driver.stop();
    let adopted = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      view.frame(true);
      adopted = view.drawnEffects().filter((effect) => effect && view.driver.created.has(effect)).length;
      if (adopted === view.materials.length) break;
      await pause();
    }
    return { drawn, held, previous, heldDifference, adopted, fogged: changed(await view.read(), reference), glErrors: glErrorsSince(errorsBefore) };
  } finally {
    view.dispose();
  }
}

/**
 * A light starts casting shadows mid-session. On the light block a receiver's Effect reads every shadow from the
 * block's records and the atlas, so no receiver asks for a variant: each keeps drawing the Effect it drew. The new map
 * waits for its casters' depth variants, which are held back, and samples neutrally meanwhile (the frame unchanged);
 * once they link, the map draws and the boxes' shadows darken the floors.
 */
async function shadowGain(name: string, caster: (scene: Scene) => { light: Light; castShadows: (enabled: boolean) => void }) {
  const view = await worldView();
  try {
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 0.9);
    const { light, castShadows } = caster(view.scene);
    castShadows(false);
    await view.coordinator.prepare();
    await view.settle();
    const unshadowed = await view.read();
    const before = view.drawnEffects();
    const errorsBefore = glErrorTraceEntries().length;
    const drawn = { held: 0, previous: 0 };
    view.reasons.clear();
    view.driver.hold();
    castShadows(true);
    let heldDifference = 0;
    for (let index = 0; index < 6; index++) {
      if (!view.frame(true)) drawn.held++;
      else if (view.drawnEffects().every((effect, at) => effect === before[at])) drawn.previous++;
      heldDifference = Math.max(heldDifference, difference(await view.read(), unshadowed));
      await pause();
    }
    const casters = view.driver.created.size;
    const map = light.getShadowGenerator() as ShadowGenerator | null;
    const neutralWhileHeld = map?.getDarkness() !== 0;
    view.driver.stop();
    let shadowPixels = 0;
    for (let attempt = 0; attempt < 150 && !(shadowPixels = darkened(await view.read(), unshadowed)); attempt++) {
      view.frame(true);
      await pause();
    }
    return {
      name, drawn, heldBecause: [...view.reasons], casters, neutralWhileHeld, mapDrawn: map?.getDarkness() === 0,
      receiversKept: view.drawnEffects().every((effect, at) => effect === before[at]),
      heldDifference, shadowPixels, glErrors: glErrorsSince(errorsBefore),
    };
  } finally {
    view.dispose();
  }
}

/**
 * An actor spawns mid-session with a Material variant nothing compiled: a box with a two-sided red graph Material, on
 * a floor under a shadowed spot. While its variant compiles the view keeps drawing and the box is left out of every
 * pass: the frame is the frame before the spawn, so no depth, shadow or colour of it shows. Once its variant links,
 * the box appears.
 */
async function spawnReveal() {
  const view = await worldView();
  try {
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), view.scene);
    authored(sun, [1, 0.95, 0.85], 1.2);
    const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, view.scene);
    authored(spot, [0.9, 0.85, 0.7], 6, true);
    await view.coordinator.prepare();
    await view.settle();
    const before = await view.read();
    const errorsBefore = glErrorTraceEntries().length;
    view.driver.hold();
    const material = await graphMaterial(view.scene, "spawned", [0.9, 0.1, 0.1], (doc) => { doc.twoSided = true; });
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
    // Its own variant was asked for and is still compiling.
    const compiling = [...view.driver.created].some((effect) => !effect.isReady());
    view.driver.stop();
    let appeared = 0;
    for (let attempt = 0; attempt < 100 && !(appeared = changed(await view.read(), before)); attempt++) {
      view.frame(true);
      await pause();
    }
    return { frames, compiling, hiddenDifference, appeared, glErrors: glErrorsSince(errorsBefore) };
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
    authored(sun, [1, 0.95, 0.85], 1.2);
    const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, view.scene);
    authored(spot, [0.9, 0.85, 0.7], 6, true);
    await view.coordinator.prepare();
    await view.settle();
    // Unlit: a variant no other mesh draws with.
    const material = await graphMaterial(view.scene, "warmed", [0.1, 0.9, 0.2], (doc) => { doc.shadingModel = "unlit"; });
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
      return { staged, links, drawn, appeared, glErrors: glErrorsSince(errorsBefore) };
    } finally {
      gl.linkProgram = linkProgram;
    }
  } finally {
    view.dispose();
  }
}

export async function runVariantSwapProof() {
  const untrace = installGlErrorTrace();
  try {
    return {
      fog: await fogSwap(),
      shadowGains: [
        // A spot's map: one atlas tile.
        await shadowGain("a spot starts casting shadows", (scene) => {
          const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, scene);
          return { light: spot, castShadows: (enabled) => authored(spot, [0.9, 0.85, 0.7], 15, enabled) };
        }),
        // A point light's map: six atlas tiles, one per cube face.
        await shadowGain("a point light starts casting shadows", (scene) => {
          const point = new PointLight("point", new Vector3(-0.4, 1.8, -0.9), scene);
          return { light: point, castShadows: (enabled) => authored(point, [1, 0.8, 0.5], 6, enabled) };
        }),
      ],
      spawn: await spawnReveal(),
      warmSpawn: await warmSpawn(),
    };
  } finally {
    untrace();
  }
}
