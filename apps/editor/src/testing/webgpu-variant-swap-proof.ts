/**
 * Test-build-only proof, on a real WebGPU device (the software adapter in CI), that a world view keeps drawing while
 * new variants' render pipelines are created: a light switching off draws each Material's previous Effect until its
 * new variant's pipeline exists, a spawn with a variant nothing compiled stays hidden until its pipelines exist, and a
 * spawn whose Material Play's load warmed creates no pipeline at all. It counts the pipelines the device created
 * synchronously (each blocks the renderer while the GPU process compiles it) and asynchronously.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  FreeCamera,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  Vector3,
  type AbstractEngine,
  type Effect,
  type Light,
  type Material,
  type Mesh,
  type ShadowGenerator,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { applyAuthoredLightProperties, setSceneRenderSettings } from "@haptic/render";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { isForwardLightExcluded, setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { compileMaterialPlan } from "../../../../packages/render/src/material-compiler";
import { isRevealPending } from "../../../../packages/render/src/reveal-pending";
import { warmSpawnables } from "../../../../packages/render/src/spawnable-warm";
import { createLoadRehearsal } from "../../../../packages/render/src/load-rehearsal";
import { AUTHORED_LIGHT_PREFIX } from "../../../../packages/render/src/scene-illumination";
import { findSceneShadowController } from "../../../../packages/render/src/shadow-controller";

/** Pipelines the device created while a step ran. */
type PipelineCounts = { synchronous: number; asynchronous: number };

type DeviceEngine = AbstractEngine & {
  _device: {
    createRenderPipeline: (descriptor: unknown) => unknown;
    createRenderPipelineAsync: (descriptor: unknown) => Promise<unknown>;
  };
};

const authored = (light: Light, color: number[], intensity: number, castShadows = false) =>
  applyAuthoredLightProperties(light, { color, intensity, castShadows, range: 9, outerAngle: 70, innerAngle: 40 });

const tick = () => new Promise((resolve) => setTimeout(resolve, 16));

/**
 * A world view on `engine` (WebGPU): its three lit Material kinds on floors with a box each, a sun, a point light and
 * a spot light that can cast shadows.
 */
export async function proveWebGpuVariantSwap(engine: AbstractEngine) {
  const result = await webGpuWorld(engine, false);
  if (!("swap" in result)) throw new Error("The swap proof did not run its swaps.");
  return result;
}

/**
 * The same world after a load rehearsal of its lights' changes (`createLoadRehearsal`, each drawn once by a strict
 * frame): a point switching off and a spot starting to cast shadows then create no pipeline, synchronously or not.
 */
export async function proveWebGpuRehearsedChanges(engine: AbstractEngine) {
  const result = await webGpuWorld(engine, true);
  if (!("report" in result)) throw new Error("The rehearsal proof did not rehearse.");
  return result;
}

/** An admission a light's approach brings on WebGPU: what it compiled and created, and how long previous variants drew. */
type PredictedAdmission = {
  admitted: boolean;
  /** Effects compiled while the light waited within reach of the admission, before it. */
  effectsAhead: number;
  /** Effects compiled from the change that admits it until every floor drew its new variant. */
  effectsAtAdmission: number;
  /** Render pipelines the device created meanwhile. */
  pipelines: PipelineCounts;
  /** Steady frames after that change in which some floor still drew its previous variant. */
  lateFrames: number;
  held: number;
  done: boolean;
};

/**
 * A light comes within reach of an admission and then into it, approaching (it waits within the prediction margin
 * first) or jumping straight in: a spot the Forward budget (two local lights) leaves out takes a point's place, and a
 * shadowed spot takes a farther point's shadow map (two local maps, the other a spot's). Approached, the admission's
 * Effects were compiled ahead; its render pipelines are still created at the admission, while previous variants draw.
 */
export async function proveWebGpuPredictedAdmissions(engine: AbstractEngine) {
  const run = async (admission: "forward" | "shadow", approach: boolean): Promise<PredictedAdmission> => {
    const shadows = admission === "shadow";
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 4.5, -7.5), scene);
    camera.setTarget(new Vector3(0, 0.4, 0));
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: shadows ? 16 : 2 } }),
      shadows: normalizeShadowSettings({ cascades: 1, localLightMode: "manual", maxLocalLights: 2 }),
    });
    const pbr = new PBRMaterial("native pbr", scene);
    pbr.albedoColor = new Color3(0.8, 0.8, 0.8);
    pbr.metallic = 0;
    const standard = new StandardMaterial("native standard", scene);
    standard.diffuseColor = new Color3(0.8, 0.8, 0.8);
    const floors = [pbr, standard].map((material, index) => {
      const floor = MeshBuilder.CreateGround(`floor-${index}`, { width: 1.9, height: 6 }, scene);
      floor.position.x = -1 + index * 2;
      floor.material = material;
      floor.receiveShadows = true;
      const box = MeshBuilder.CreateBox(`box-${index}`, { size: 0.8 }, scene);
      box.position.set(-1 + index * 2, 0.4, 0);
      box.material = material;
      box.receiveShadows = true;
      return floor;
    });
    const sun = new DirectionalLight(`${AUTHORED_LIGHT_PREFIX}sun`, new Vector3(0.3, -1, 0.4), scene);
    authored(sun, [1, 0.95, 0.85], 0.4);
    const near = shadows
      ? new SpotLight(`${AUTHORED_LIGHT_PREFIX}near`, new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, scene)
      : new PointLight(`${AUTHORED_LIGHT_PREFIX}near`, new Vector3(-0.6, 1.6, -1.2), scene);
    authored(near, [0.3, 0.4, 1], 0.9, shadows);
    const far = new PointLight(`${AUTHORED_LIGHT_PREFIX}far`, shadows ? new Vector3(1.5, 1.8, 3) : new Vector3(1.4, 1.2, -1.5), scene);
    authored(far, [1, 0.8, 0.2], 0.9, shadows);
    const spot = new SpotLight(`${AUTHORED_LIGHT_PREFIX}spot`, new Vector3(0, 3.2, 24), new Vector3(0.05, -1, 0.2), 1.2, 2, scene);
    authored(spot, [0.9, 0.85, 0.7], 1.4, shadows);
    const coordinator = new SceneRenderCoordinator(scene, { deferPipelines: true });
    const device = (engine as DeviceEngine)._device;
    const createRenderPipeline = device.createRenderPipeline;
    const createRenderPipelineAsync = device.createRenderPipelineAsync;
    const counts: PipelineCounts = { synchronous: 0, asynchronous: 0 };
    device.createRenderPipeline = function (descriptor) {
      counts.synchronous++;
      return createRenderPipeline.call(this, descriptor);
    };
    device.createRenderPipelineAsync = function (descriptor) {
      counts.asynchronous++;
      return createRenderPipelineAsync.call(this, descriptor);
    };
    const effects = () => Object.keys((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects).length;
    const drawn = () => {
      const pass = engine.getRenderPassNames().lastIndexOf("Forward objects#0");
      return floors.map((floor) => pass < 0 ? null : floor.subMeshes[0]!._getDrawWrapper(pass)?.effect ?? null);
    };
    const admitted = () => shadows
      ? findSceneShadowController(scene)?.generator(spot) != null && findSceneShadowController(scene)?.generator(far) == null
      : !isForwardLightExcluded(spot);
    const frame = async (strict = false) => {
      engine.beginFrame();
      let rendered: boolean;
      try {
        rendered = coordinator.render(strict).rendered;
      } finally {
        engine.endFrame();
      }
      await tick();
      return rendered;
    };
    try {
      await coordinator.prepare();
      for (let attempt = 0; attempt < 300; attempt++) if (coordinator.isReady() && await frame(true) && await frame(true)) break;
      for (let index = 0; index < 4; index++) await frame();
      let effectsAhead = 0;
      if (approach) {
        // Within the prediction margin of the cut-off (the farther local light's ranking distance), still left out.
        const start = effects();
        spot.position.set(0, 3.2, shadows ? 6 : 1);
        for (let index = 0; index < 12; index++) await frame();
        effectsAhead = effects() - start;
      }
      if (admitted()) throw new Error(`The ${admission} admission came before the change.`);
      const start = effects();
      counts.synchronous = counts.asynchronous = 0;
      const before = drawn();
      spot.position.set(0, 3.2, shadows ? 0 : -4.5);
      let lateFrames = 0;
      let held = 0;
      let done = false;
      for (let index = 0; index < 300 && !done; index++) {
        if (!(await frame())) held++;
        else if (drawn().some((effect, slot) => effect === before[slot])) lateFrames++;
        else done = true;
      }
      return { admitted: admitted(), effectsAhead, effectsAtAdmission: effects() - start, pipelines: { ...counts }, lateFrames, held, done };
    } finally {
      device.createRenderPipeline = createRenderPipeline;
      device.createRenderPipelineAsync = createRenderPipelineAsync;
      coordinator.dispose();
      scene.dispose();
    }
  };
  return {
    forward: { approached: await run("forward", true), jumped: await run("forward", false) },
    shadow: { approached: await run("shadow", true), jumped: await run("shadow", false) },
  };
}

async function webGpuWorld(engine: AbstractEngine, rehearse: boolean) {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
  const camera = new FreeCamera("camera", new Vector3(0, 4, -7), scene);
  camera.setTarget(new Vector3(0, 0.4, 0));
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
  const standard = new StandardMaterial("native standard", scene);
  standard.diffuseColor = new Color3(0.8, 0.8, 0.8);
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("The default Material did not lower.");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name: "graph" });
  if (!compiled.ok) throw new Error("The default Material did not compile.");
  const materials: Material[] = [pbr, standard, compiled.material];
  const boxes: Mesh[] = materials.map((material, index) => {
    const floor = MeshBuilder.CreateGround(`floor-${index}`, { width: 1.9, height: 6 }, scene);
    floor.position.x = -2 + index * 2;
    floor.material = material;
    floor.receiveShadows = true;
    const box = MeshBuilder.CreateBox(`box-${index}`, { size: 0.8 }, scene);
    box.position.set(-2 + index * 2, 0.4, 0);
    box.material = material;
    box.receiveShadows = true;
    return floor;
  });
  // The rehearsal enumerates authored lights (Play's names).
  const name = (light: string) => rehearse ? `${AUTHORED_LIGHT_PREFIX}${light}` : light;
  const sun = new DirectionalLight(name("sun"), new Vector3(0.3, -1, 0.4), scene);
  authored(sun, [1, 0.95, 0.85], 0.7);
  const point = new PointLight(name("point"), new Vector3(0, 1.6, -1.2), scene);
  authored(point, [1, 0.8, 0.4], 1.2);
  const spot = new SpotLight(name("spot"), new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, scene);
  authored(spot, [0.9, 0.85, 0.7], 1.4);
  const coordinator = new SceneRenderCoordinator(scene, { deferPipelines: true });
  const device = (engine as DeviceEngine)._device;
  const createRenderPipeline = device.createRenderPipeline;
  const createRenderPipelineAsync = device.createRenderPipelineAsync;
  const counts: PipelineCounts = { synchronous: 0, asynchronous: 0 };
  device.createRenderPipeline = function (descriptor) {
    counts.synchronous++;
    return createRenderPipeline.call(this, descriptor);
  };
  device.createRenderPipelineAsync = function (descriptor) {
    counts.asynchronous++;
    return createRenderPipelineAsync.call(this, descriptor);
  };
  /** The Effect `mesh` draws with in the view's object pass. */
  const drawnEffect = (mesh: Mesh): Effect | null => {
    const pass = engine.getRenderPassNames().lastIndexOf("Forward objects#0");
    return pass < 0 ? null : mesh.subMeshes[0]!._getDrawWrapper(pass)?.effect ?? null;
  };
  /** One frame: steady (`render(false)`) unless `strict`; whether it drew. */
  const frame = async (strict = false) => {
    engine.beginFrame();
    let drawn: boolean;
    try {
      drawn = coordinator.render(strict).rendered;
    } finally {
      engine.endFrame();
    }
    await tick();
    return drawn;
  };
  /** Runs frames until `done` (at most 300), counting those not drawn and the pipelines created meanwhile. */
  const step = async (done: () => boolean, each?: () => void) => {
    counts.synchronous = counts.asynchronous = 0;
    let frames = 0;
    let held = 0;
    while (frames < 300 && !done()) {
      if (!(await frame())) held++;
      frames++;
      each?.();
    }
    return { frames, held, done: done(), pipelines: { ...counts } };
  };
  try {
    await coordinator.prepare();
    for (let attempt = 0; attempt < 300; attempt++) if (coordinator.isReady() && await frame(true) && await frame(true)) break;
    if (rehearse) {
      const rehearsal = createLoadRehearsal(scene);
      for (let attempt = 0; attempt < 600 && !rehearsal.done; attempt++) {
        rehearsal.check();
        if (coordinator.isReady()) rehearsal.frame(() => { engine.beginFrame(); try { return coordinator.render(true).rendered; } finally { engine.endFrame(); } });
        await tick();
      }
      const report = rehearsal.report();
      for (let attempt = 0; attempt < 300; attempt++) if (coordinator.isReady() && await frame(true)) break;
      for (let index = 0; index < 4; index++) await frame();
      const unchanged = boxes.map(drawnEffect);
      setAuthoredLightEnabled(point, false);
      const pointOff = await step(() => boxes.every((floor, index) => drawnEffect(floor) !== unchanged[index]));
      // One change at a time, as rehearsed: the point back on first (the variants the load drew).
      setAuthoredLightEnabled(point, true);
      await step(() => boxes.every((floor, index) => drawnEffect(floor) === unchanged[index]));
      authored(spot, [0.9, 0.85, 0.7], 1.4, true);
      const spotShadows = await step(() => boxes.every((floor, index) => drawnEffect(floor) !== unchanged[index]) &&
        (spot.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() === 0);
      return { report, pointOff, spotShadows };
    }
    // Steady frames: the view now tolerates swaps and warms new variants' pipelines.
    for (let index = 0; index < 4; index++) await frame();

    // A light switches off: every Material asks for a variant without it.
    const before = boxes.map(drawnEffect);
    let previousFrames = 0;
    setAuthoredLightEnabled(point, false);
    const swap = await step(
      () => boxes.every((box, index) => drawnEffect(box) !== before[index]),
      () => { if (boxes.every((box, index) => drawnEffect(box) === before[index])) previousFrames++; },
    );

    // The spot starts casting shadows, then stops: the floors swap to their shadowed variants and on. The new map's
    // casters draw in a shadow pass, outside the view's deferral, so their depth pipelines are created synchronously.
    const unshadowed = boxes.map(drawnEffect);
    authored(spot, [0.9, 0.85, 0.7], 1.4, true);
    const shadowGain = await step(() => boxes.every((floor, index) => drawnEffect(floor) !== unshadowed[index]) &&
      (spot.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() === 0);
    // With the sun switched off too, the floors' next variant is one nothing drew: their shadowed Effect draws until it
    // has a pipeline, its lost map's sampler bound to a placeholder of the declared type.
    const shadowed = boxes.map(drawnEffect);
    let shadowedFrames = 0;
    authored(spot, [0.9, 0.85, 0.7], 1.4, false);
    setAuthoredLightEnabled(sun, false);
    const shadowLoss = await step(() => boxes.every((floor, index) => drawnEffect(floor) !== shadowed[index]),
      () => { if (boxes.every((floor, index) => drawnEffect(floor) === shadowed[index])) shadowedFrames++; });

    // The sun back on (a variant the floors drew after the first swap) for the spawns.
    const sunless = boxes.map(drawnEffect);
    setAuthoredLightEnabled(sun, true);
    await step(() => boxes.every((floor, index) => drawnEffect(floor) !== sunless[index]));
    // A spawn with a variant nothing compiled (a Material of its own): hidden until its pipelines exist.
    const missedMaterial = new StandardMaterial("spawned", scene);
    // Unlit: a variant (and pipeline) no other mesh draws with.
    missedMaterial.emissiveColor = new Color3(0.9, 0.1, 0.1);
    missedMaterial.disableLighting = true;
    const missed = MeshBuilder.CreateBox("spawned", { size: 0.6 }, scene);
    missed.position.set(1, 0.3, -1.2);
    missed.material = missedMaterial;
    let hiddenFrames = 0;
    const spawn = await step(() => !isRevealPending(missed) && drawnEffect(missed) !== null,
      () => { if (isRevealPending(missed)) hiddenFrames++; });

    // A spawn whose Material Play's load warmed: its staged box was warm-drawn, so the spawn creates no pipeline.
    const warmedMaterial = new StandardMaterial("warmed", scene);
    // Emissive as illumination: another variant no other mesh draws with.
    warmedMaterial.diffuseColor = new Color3(0.1, 0.2, 0.9);
    warmedMaterial.emissiveColor = new Color3(0.1, 0.1, 0.3);
    warmedMaterial.useEmissiveAsIllumination = true;
    await warmSpawnables(scene, { materials: [warmedMaterial], containers: [] });
    const staged = await step(() => !scene.meshes.some((mesh) => mesh.name.startsWith("spawnable-warm:")));
    const warmed = MeshBuilder.CreateBox("warmed", { size: 0.6 }, scene);
    warmed.position.set(-1, 0.3, -1.2);
    warmed.material = warmedMaterial;
    const warmSpawn = await step(() => !isRevealPending(warmed) && drawnEffect(warmed) !== null);
    return {
      swap: { ...swap, previousFrames },
      shadowGain,
      shadowLoss: { ...shadowLoss, previousFrames: shadowedFrames },
      spawn: { ...spawn, hiddenFrames },
      staged,
      warmSpawn,
    };
  } finally {
    device.createRenderPipeline = createRenderPipeline;
    device.createRenderPipelineAsync = createRenderPipelineAsync;
    coordinator.dispose();
    scene.dispose();
  }
}
