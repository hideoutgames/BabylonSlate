/**
 * Test-build-only proof, on a real WebGPU device (the software adapter in CI), that a world view keeps drawing while
 * new variants' render pipelines are created: a light switching off draws each Material's previous Effect until its
 * new variant's pipeline exists, a new shadow map (a spot's, the sun's first cascaded one) samples neutrally until its
 * casters' pipelines exist, a spawn with a variant nothing compiled stays hidden until its pipelines exist (into a drawn
 * shadow map, its caster depth pipeline included), and a spawn whose Material Play's load warmed creates no pipeline at
 * all. It counts the pipelines the device created
 * synchronously (each blocks the renderer while the GPU process compiles it) and asynchronously.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  FreeCamera,
  Matrix,
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
import { DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
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
import { awaitsFirstDraw } from "../../../../packages/render/src/shadow-first-draw";
import { pruneWebGpuCachesNow, webGpuPipelinesOutside } from "../../../../packages/render/src/webgpu-cache-pruning";
import { deferredPipelineCount, effectDrawn } from "../../../../packages/render/src/webgpu-pipeline-deferral";
import { PREDICTION_EXPIRY_MS } from "../../../../packages/render/src/variant-prediction";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree";

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

/**
 * A world view with a geometry pass (temporal anti-aliasing's view depth and velocity, which no warm draw warms): a
 * spawn with a variant nothing compiled stays hidden until its colour pipelines exist, and is then left out of the
 * geometry pass alone, with no frame held and no pipeline created synchronously, until its geometry pipeline exists.
 * A light switching off then swaps the floor's colour variant and keeps its geometry Effect.
 */
export async function proveWebGpuGeometrySpawn(engine: AbstractEngine) {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
  const camera = new FreeCamera("camera", new Vector3(0, 3, -6), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  setFixedShapeLightingWorldScene(scene);
  setSceneRenderSettings(scene, { mode: "pbr", effects: { ...DEFAULT_RENDER_EFFECTS,
    temporalAntiAliasing: { enabled: true, samples: 8, blend: 0.1 } } });
  const floorMaterial = new PBRMaterial("floor", scene);
  floorMaterial.albedoColor = new Color3(0.8, 0.8, 0.8);
  floorMaterial.metallic = 0;
  const floor = MeshBuilder.CreateGround("floor", { width: 6, height: 6 }, scene);
  floor.material = floorMaterial;
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  authored(sun, [1, 0.95, 0.85], 1);
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
  const frame = async (strict = false) => {
    engine.beginFrame();
    try {
      return coordinator.render(strict).rendered;
    } finally {
      engine.endFrame();
      await tick();
    }
  };
  // Bounded, as the material proof's time limit is shared: four loops of at most FRAME_LIMIT passes each, the first
  // drawing up to two frames a pass, so at most 5 × FRAME_LIMIT frames.
  const FRAME_LIMIT = 120;
  const started = performance.now();
  try {
    await coordinator.prepare();
    for (let attempt = 0; attempt < FRAME_LIMIT; attempt++) {
      if (!coordinator.isReady()) await tick();
      else if (await frame(true) && await frame(true)) break;
    }
    // Steady frames that draw complete frames, so the geometry pass has drawn the floor.
    let settled = 0;
    for (let index = 0; index < FRAME_LIMIT && settled < 4; index++) settled = await frame() ? settled + 1 : 0;
    const geometryPass = engine.getRenderPassNames().lastIndexOf("Spatial Geometry#0");
    // Unlit: a colour and a geometry variant no other mesh draws with.
    const material = new PBRMaterial("spawned", scene);
    material.albedoColor = new Color3(0.1, 0.8, 0.2);
    material.unlit = true;
    const spawned = MeshBuilder.CreateBox("spawned", { size: 0.6 }, scene);
    spawned.position.y = 0.3;
    spawned.material = material;
    /** Whether the spawn has drawn into the geometry buffers: a draw drew its geometry variant. */
    const geometryDrawn = () => {
      const effect = spawned.subMeshes[0]?._getDrawWrapper(geometryPass)?.effect;
      return !!effect && effectDrawn(engine, effect);
    };
    counts.synchronous = counts.asynchronous = 0;
    let frames = 0;
    let held = 0;
    let hiddenFrames = 0;
    let leftOutFrames = 0;
    while (frames < FRAME_LIMIT && (isRevealPending(spawned) || !geometryDrawn())) {
      if (!(await frame())) held++;
      frames++;
      if (isRevealPending(spawned)) hiddenFrames++;
      else if (!geometryDrawn()) leftOutFrames++;
    }
    const spawn = {
      done: !isRevealPending(spawned) && geometryDrawn(), frames, held, hiddenFrames, leftOutFrames, pipelines: { ...counts },
    };
    // The sun switching off: the floor swaps to its unlit colour variant, while the geometry pass keeps its geometry
    // Effect (the opaque PBR floor's geometry attachments read no light).
    const pass = (name: string) => engine.getRenderPassNames().lastIndexOf(name);
    const effectIn = (name: string) => floor.subMeshes[0]!._getDrawWrapper(pass(name))?.effect ?? null;
    const lit = effectIn("Forward objects#0");
    const geometry = effectIn("Spatial Geometry#0");
    setAuthoredLightEnabled(sun, false);
    let lightFrames = 0;
    let lightHeld = 0;
    while (lightFrames < FRAME_LIMIT && effectIn("Forward objects#0") === lit) {
      if (!(await frame())) lightHeld++;
      lightFrames++;
    }
    const lightOff = {
      done: effectIn("Forward objects#0") !== lit, held: lightHeld, frames: lightFrames,
      geometryKept: geometry !== null && effectIn("Spatial Geometry#0") === geometry,
    };
    return {
      geometryPass: geometryPass >= 0, settled: settled >= 4, ...spawn, lightOff, ms: Math.round(performance.now() - started),
    };
  } finally {
    device.createRenderPipeline = createRenderPipeline;
    device.createRenderPipelineAsync = createRenderPipelineAsync;
    coordinator.dispose();
    scene.dispose();
  }
}

/** An admission a light's approach brings on WebGPU: what it compiled and created, and how long previous variants drew. */
type PredictedAdmission = {
  admitted: boolean;
  /** Effects compiled while the light waited within reach of the admission, before it. */
  effectsAhead: number;
  /** Effects compiled from the change that admits it until every floor drew its new variant and a new map drew. */
  effectsAtAdmission: number;
  /** Render pipelines the device created meanwhile. */
  pipelines: PipelineCounts;
  /** Render pipelines created while the light waited within reach (a new or returning map's casters', by its prediction map). */
  pipelinesAhead: number;
  /**
   * Pipelines Babylon's cache holds now beyond those it held before the approach; for a prediction left to expire, the
   * pipelines it still holds for Effects released since (none should be left).
   */
  pipelinesLeft: number;
  /** Steady frames after that change in which some floor still drew its previous variant. */
  lateFrames: number;
  held: number;
  /** Why the frames not drawn after that change were not. */
  heldBecause: string[];
  done: boolean;
  /** A map the admission started or brought back has drawn (it samples neutrally until then). */
  mapDrawn: boolean;
};

/**
 * A light comes within reach of an admission and then into it, approaching (it waits within the prediction margin
 * first) or jumping straight in: a spot the Forward budget (two local lights) leaves out takes a point's place, and a
 * shadowed spot takes a farther point's shadow map (two local maps, the other a spot's, or another point's for the first
 * spot map), and a shadowed spot whose map waits on standby enters the Forward budget. Approached, the admission's
 * Effects were compiled ahead, and a new or returning map's casters' depth pipelines created by a render of the
 * controller's prediction map; the receivers' pipelines are still created at the admission, while previous variants
 * draw. Jumped in, a new or returning map samples neutrally until a warm render of it has created its casters' depth
 * pipelines. A prediction left to expire gives its prediction map's pipelines back.
 */
export async function proveWebGpuPredictedAdmissions(engine: AbstractEngine) {
  let variant = 0;
  const run = async (admission: "forward" | "standby" | "shadow" | "first", approach: boolean, expire = false): Promise<PredictedAdmission> => {
    // The shadow budget's admissions; the Forward budget's (a standby spot's map comes back with it) otherwise.
    const shadows = admission === "shadow" || admission === "first";
    const spotShadowed = shadows || admission === "standby";
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 4.5, -7.5), scene);
    camera.setTarget(new Vector3(0, 0.4, 0));
    scene.activeCamera = camera;
    // A world Scene: its views bind previous Effects by their own light layout while new variants get ready.
    setFixedShapeLightingWorldScene(scene);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: shadows ? 16 : 2 } }),
      shadows: normalizeShadowSettings({ cascades: 1, localLightMode: "manual", maxLocalLights: 2 }),
    });
    // One Engine serves every run, and its Effect cache outlives their Scenes: each run draws its own variants, which
    // nothing compiled before.
    variant++;
    const pbr = new PBRMaterial("native pbr", scene);
    pbr.albedoColor = new Color3(0.8, 0.8, 0.8);
    pbr.metallic = 0;
    pbr.enableSpecularAntiAliasing = (variant & 1) !== 0;
    pbr.forceNormalForward = (variant & 2) !== 0;
    pbr.useSpecularOverAlpha = (variant & 4) === 0;
    pbr.useRadianceOverAlpha = (variant & 8) === 0;
    // The first spot map's runs draw their casters with no face culling, a shadow pass state no earlier run used,
    // so its caster depth pipelines are new too.
    const unculled = admission === "first";
    pbr.backFaceCulling = !unculled;
    pbr.twoSidedLighting = unculled;
    // The standby spot's receivers start with another Material, so its admitted variant of `pbr` is new when it returns.
    const initial = new PBRMaterial("initial pbr", scene);
    const receivers: Mesh[] = [];
    const floors = [pbr, pbr].map((material, index) => {
      const floor = MeshBuilder.CreateGround(`floor-${index}`, { width: 1.9, height: 6 }, scene);
      floor.position.x = -1 + index * 2;
      floor.material = admission === "standby" ? initial : material;
      floor.receiveShadows = true;
      const box = MeshBuilder.CreateBox(`box-${index}`, { size: 0.8 }, scene);
      box.position.set(-1 + index * 2, 0.4, 0);
      box.material = admission === "standby" ? initial : material;
      box.receiveShadows = true;
      receivers.push(floor, box);
      return floor;
    });
    const sun = new DirectionalLight(`${AUTHORED_LIGHT_PREFIX}sun`, new Vector3(0.3, -1, 0.4), scene);
    authored(sun, [1, 0.95, 0.85], 0.4);
    // The first spot map: the nearer holder is a point too.
    const near = admission === "shadow"
      ? new SpotLight(`${AUTHORED_LIGHT_PREFIX}near`, new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, scene)
      : new PointLight(`${AUTHORED_LIGHT_PREFIX}near`, new Vector3(-0.6, 1.6, -1.2), scene);
    authored(near, [0.3, 0.4, 1], 0.9, shadows);
    const far = new PointLight(`${AUTHORED_LIGHT_PREFIX}far`, shadows ? new Vector3(1.5, 1.8, 3) : new Vector3(1.4, 1.2, -1.5), scene);
    authored(far, [1, 0.8, 0.2], 0.9, shadows);
    // The standby spot starts admitted, so it holds a map before the Forward budget leaves it out.
    const spot = new SpotLight(`${AUTHORED_LIGHT_PREFIX}spot`, new Vector3(0, 3.2, admission === "standby" ? -4.5 : 24),
      new Vector3(0.05, -1, 0.2), 1.2, 2, scene);
    authored(spot, [0.9, 0.85, 0.7], 1.4, spotShadowed);
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
    // Effects compiled since `known` was taken (new Engine cache entries; a released map's entries leave meanwhile).
    const cache = () => Object.keys((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects);
    const compiledSince = (known: ReadonlySet<string>) => cache().filter((key) => !known.has(key)).length;
    const drawn = () => {
      const pass = engine.getRenderPassNames().lastIndexOf("Forward objects#0");
      return floors.map((floor) => pass < 0 ? null : floor.subMeshes[0]!._getDrawWrapper(pass)?.effect ?? null);
    };
    const admitted = () => shadows
      ? findSceneShadowController(scene)?.generator(spot) != null && findSceneShadowController(scene)?.generator(far) == null
      : !isForwardLightExcluded(spot) && (!spotShadowed || findSceneShadowController(scene)?.generator(spot) != null);
    const reasons = new Set<string>();
    const frame = async (strict = false) => {
      engine.beginFrame();
      let rendered: boolean;
      try {
        const result = coordinator.render(strict);
        rendered = result.rendered;
        if (!rendered) reasons.add(result.reason ?? "");
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
      if (admission === "standby") {
        // Left out by the Forward budget, its map waits on standby; then the receivers take `pbr` (strict frames: each
        // change is drawn before the next).
        spot.position.set(0, 3.2, 24);
        for (let attempt = 0; attempt < 300; attempt++) if (await frame(true) && await frame(true)) break;
        for (const mesh of receivers) mesh.material = pbr;
        for (let attempt = 0; attempt < 300; attempt++) if (await frame(true) && await frame(true)) break;
        for (let index = 0; index < 4; index++) await frame();
      }
      let effectsAhead = 0;
      let pipelinesAhead = 0;
      // The Engine's cache pruning drops released Effects' pipelines at a frame end (`webgpu-cache-pruning.ts`): what
      // earlier runs released goes now, so the count compares this run's pipelines only.
      pruneWebGpuCachesNow(engine);
      const cachedPipelines = WebGPUCacheRenderPipelineTree.GetNodeCounts().pipelineCount;
      if (approach) {
        // Within the prediction margin of the cut-off (the farther local light's ranking distance), still left out.
        const known = new Set(cache());
        counts.synchronous = counts.asynchronous = 0;
        spot.position.set(0, 3.2, shadows ? 6 : 1);
        // Long enough for the prediction map's asynchronous caster pipelines too (the software adapter can take longer
        // than twelve frames), then two frames.
        for (let index = 0; index < 300 && (index < 12 || deferredPipelineCount(engine) > 0); index++) await frame();
        for (let index = 0; index < 2; index++) await frame();
        effectsAhead = compiledSince(known);
        pipelinesAhead = counts.synchronous + counts.asynchronous;
      }
      if (expire) {
        // Out of the margin past the prediction's expiry: its Effects and its prediction map's pipelines go.
        spot.position.set(0, 3.2, 24);
        const start = performance.now();
        while (performance.now() - start < PREDICTION_EXPIRY_MS + 500) await frame();
        for (let index = 0; index < 4; index++) await frame();
        return {
          admitted: admitted(), effectsAhead, effectsAtAdmission: 0, pipelines: { ...counts }, pipelinesAhead,
          pipelinesLeft: webGpuPipelinesOutside(new Set(Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects).map((effect) => effect.uniqueId))),
          lateFrames: 0, held: 0, heldBecause: [], done: true, mapDrawn: true,
        };
      }
      if (admitted()) throw new Error(`The ${admission} admission came before the change.`);
      // A Forward admission of a shadowed spot: its map waits on standby, bound but not admitted, until then.
      if (admission === "standby" && !findSceneShadowController(scene)?.boundGenerator(spot))
        throw new Error("The standby spot holds no shadow map before its admission.");
      reasons.clear();
      const known = new Set(cache());
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
      // A map the admission starts asks for its casters' depth variants when it first draws, and waits for their
      // pipelines, which can come after the floors' new variants.
      const map = spotShadowed ? findSceneShadowController(scene)?.generator(spot) : null;
      for (let index = 0; index < 300 && map && awaitsFirstDraw(map); index++) if (!(await frame())) held++;
      for (let index = 0; index < 4; index++) await frame();
      return {
        admitted: admitted(), effectsAhead, effectsAtAdmission: compiledSince(known), pipelines: { ...counts }, pipelinesAhead,
        pipelinesLeft: WebGPUCacheRenderPipelineTree.GetNodeCounts().pipelineCount - cachedPipelines, lateFrames, held,
        heldBecause: [...reasons], done, mapDrawn: !map || !awaitsFirstDraw(map),
      };
    } finally {
      device.createRenderPipeline = createRenderPipeline;
      device.createRenderPipelineAsync = createRenderPipelineAsync;
      coordinator.dispose();
      scene.dispose();
    }
  };
  return {
    forward: { approached: await run("forward", true), jumped: await run("forward", false) },
    standby: { approached: await run("standby", true), jumped: await run("standby", false), expired: await run("standby", true, true) },
    shadow: { approached: await run("shadow", true), jumped: await run("shadow", false) },
    first: { approached: await run("first", true), jumped: await run("first", false), expired: await run("first", true, true) },
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

    // The spot starts casting shadows, then stops: the floors swap to their shadowed variants and on. The new map
    // samples neutrally until a warm render of it has created its casters' depth pipelines, then draws.
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

    // The sun starts casting shadows into a first, cascaded map (one render pass per cascade): it too waits, neutral,
    // for its casters' depth pipelines, while the floors draw their previous variants.
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } }),
      shadows: normalizeShadowSettings({ cascades: 2, maxLocalLights: 2 }),
    });
    const unshadowedBySun = boxes.map(drawnEffect);
    authored(sun, [1, 0.95, 0.85], 0.7, true);
    const sunMap = () => sun.getShadowGenerator() as ShadowGenerator | null;
    const sunShadows = await step(() => boxes.every((floor, index) => drawnEffect(floor) !== unshadowedBySun[index]) &&
      sunMap()?.getDarkness() === 0);
    // A spawn into the drawn sun map with a caster depth variant no caster drew (an instanced one): hidden, it is
    // listed in the map's redraws only to create that pipeline asynchronously, and is revealed once it exists, so the
    // map's redraw with it creates none synchronously.
    const instanced = MeshBuilder.CreateBox("instanced spawn", { size: 0.5 }, scene);
    instanced.position.set(0, 0.25, -2);
    instanced.material = standard;
    instanced.thinInstanceAdd(Matrix.Identity());
    const castsIntoSun = () => {
      const effect = instanced.subMeshes[0]?._getDrawWrapper(sunMap()!.getShadowMap()!.renderPassIds[0]!)?.effect;
      return !!effect && effectDrawn(engine, effect);
    };
    let casterHiddenFrames = 0;
    const casterSpawn = await step(() => !isRevealPending(instanced) && drawnEffect(instanced) !== null && castsIntoSun(),
      () => { if (isRevealPending(instanced)) casterHiddenFrames++; });
    return {
      swap: { ...swap, previousFrames },
      shadowGain,
      shadowLoss: { ...shadowLoss, previousFrames: shadowedFrames },
      spawn: { ...spawn, hiddenFrames },
      staged,
      warmSpawn,
      sunShadows: { ...sunShadows, cascades: sunMap()?.getShadowMap()?.renderPassIds.length ?? 0 },
      casterSpawn: { ...casterSpawn, hiddenFrames: casterHiddenFrames },
    };
  } finally {
    device.createRenderPipeline = createRenderPipeline;
    device.createRenderPipelineAsync = createRenderPipelineAsync;
    coordinator.dispose();
    scene.dispose();
  }
}
