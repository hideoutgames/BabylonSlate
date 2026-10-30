/**
 * Test-build-only proof, on a real WebGPU device (the software adapter in CI), that a world view of graph Materials on
 * the lighting plan's light block keeps drawing while new variants' render pipelines are created: a light switching off
 * creates none, fog switching on draws each Material's previous Effect until its new variant's pipeline exists, a new
 * shadow map (a spot's tile, the sun's first cascades) samples neutrally until its casters' pipelines exist, a spawn
 * with a variant nothing compiled stays hidden until its pipelines exist (into a drawn shadow map, its caster depth
 * pipeline included), the same spawn built again is revealed in its first frame while one with another vertex layout
 * waits hidden for its own pipeline, and a spawn whose Material Play's load warmed creates no pipeline at all. It
 * counts the pipelines the device created synchronously (each blocks the renderer while the GPU process compiles it)
 * and asynchronously.
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
  Vector3,
  VertexBuffer,
  type AbstractEngine,
  type Effect,
  type Light,
  type Mesh,
  type NodeMaterial,
  type ShadowGenerator,
} from "@babylonjs/core";
import { DEFAULT_RENDER_EFFECTS, normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { applyAuthoredLightProperties, setHapticLighting, setSceneRenderSettings } from "@haptic/render";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { setFixedShapeLightingWorldScene } from "../../../../packages/render/src/fixed-light-admission";
import { setAuthoredLightEnabled } from "../../../../packages/render/src/light-policy";
import { compileMaterialPlan } from "../../../../packages/render/src/material-compiler";
import { isRevealPending } from "../../../../packages/render/src/reveal-pending";
import { warmSpawnables } from "../../../../packages/render/src/spawnable-warm";
import { effectDrawn } from "../../../../packages/render/src/webgpu-pipeline-deferral";

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

/** Counts the render pipelines `engine`'s device creates, synchronously and not, until `restore`. */
function countPipelines(engine: AbstractEngine) {
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
  const restore = () => {
    device.createRenderPipeline = createRenderPipeline;
    device.createRenderPipelineAsync = createRenderPipelineAsync;
  };
  return { counts, restore };
}

/**
 * A world view on `engine` (WebGPU): three graph Materials on floors with a box each, a sun, a point light and a spot
 * light that can cast shadows.
 */
export async function proveWebGpuVariantSwap(engine: AbstractEngine) {
  // Graph Materials compile with the light block.
  setHapticLighting(engine, true);
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
  const materials: NodeMaterial[] = [];
  for (const [index, color] of [[0.8, 0.8, 0.8], [0.8, 0.6, 0.5], [0.5, 0.7, 0.8]].entries())
    materials.push(await graphMaterial(scene, `graph ${index}`, color));
  const floors: Mesh[] = materials.map((material, index) => {
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
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  authored(sun, [1, 0.95, 0.85], 2.2);
  const point = new PointLight("point", new Vector3(0, 1.6, -1.2), scene);
  authored(point, [1, 0.8, 0.4], 4);
  const spot = new SpotLight("spot", new Vector3(0, 3.2, -0.4), new Vector3(0.05, -1, 0.2), 1.2, 2, scene);
  authored(spot, [0.9, 0.85, 0.7], 6);
  const coordinator = new SceneRenderCoordinator(scene, { deferPipelines: true });
  const { counts, restore } = countPipelines(engine);
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
  const kept = (effects: (Effect | null)[]) => floors.every((floor, index) => drawnEffect(floor) === effects[index]);
  try {
    await coordinator.prepare();
    for (let attempt = 0; attempt < 300; attempt++) if (coordinator.isReady() && await frame(true) && await frame(true)) break;
    // Steady frames: the view now tolerates swaps and warms new variants' pipelines.
    for (let index = 0; index < 4; index++) await frame();

    // A light switches off: the block's records change, no Material asks for a variant and no pipeline is created.
    const lit = floors.map(drawnEffect);
    setAuthoredLightEnabled(point, false);
    let lightFrames = 0;
    const lightOff = await step(() => ++lightFrames > 8);
    const lightOffKept = kept(lit);
    setAuthoredLightEnabled(point, true);

    // Fog switches on: every Material asks for a fogged variant, and draws its previous Effect until that variant's
    // pipeline exists.
    const before = floors.map(drawnEffect);
    let previousFrames = 0;
    Object.assign(scene, { fogMode: Scene.FOGMODE_LINEAR, fogColor: new Color3(0.7, 0.75, 0.8), fogStart: 2, fogEnd: 14 });
    const swap = await step(
      () => floors.every((floor, index) => drawnEffect(floor) !== before[index]),
      () => { if (kept(before)) previousFrames++; },
    );

    // The spot starts casting shadows: the floors keep their Effects (the block reads the atlas), and the new map
    // samples neutrally until its casters' depth pipelines exist, then draws.
    const unshadowed = floors.map(drawnEffect);
    authored(spot, [0.9, 0.85, 0.7], 6, true);
    const shadowGain = await step(() => (spot.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() === 0);
    const shadowGainKept = kept(unshadowed);

    // A spawn with a variant nothing compiled (a Material of its own): hidden until its pipelines exist.
    const missedMaterial = await graphMaterial(scene, "spawned", [0.9, 0.1, 0.1], (doc) => { doc.twoSided = true; });
    const missed = MeshBuilder.CreateBox("spawned", { size: 0.6 }, scene);
    missed.position.set(1, 0.3, -1.2);
    missed.material = missedMaterial;
    let hiddenFrames = 0;
    const spawn = await step(() => !isRevealPending(missed) && drawnEffect(missed) !== null,
      () => { if (isRevealPending(missed)) hiddenFrames++; });

    // The same spawn built again, as a script's write rebuilds a visual: its Effect and pipelines (its vertex layout and
    // state) exist, so a lookup ahead of its draws finds them and it is revealed in its first frame, creating none.
    missed.dispose();
    const rebuilt = MeshBuilder.CreateBox("rebuilt", { size: 0.6 }, scene);
    rebuilt.position.set(1, 0.3, -1.2);
    rebuilt.material = missedMaterial;
    let rebuiltHidden = 0;
    const respawn = await step(() => !isRevealPending(rebuilt) && drawnEffect(rebuilt) !== null,
      () => { if (isRevealPending(rebuilt)) rebuiltHidden++; });
    // The same Material on a box whose positions are laid out another way (padded): the Effect has drawn, but not with
    // this vertex layout, so the lookup misses and the box waits hidden while its pipeline is created asynchronously.
    const padded = MeshBuilder.CreateBox("padded", { size: 0.6 }, scene);
    const positions = padded.getVerticesData(VertexBuffer.PositionKind)!;
    const paddedPositions = new Float32Array((positions.length / 3) * 4);
    for (let index = 0; index < positions.length / 3; index++)
      paddedPositions.set(positions.slice(index * 3, index * 3 + 3), index * 4);
    padded.setVerticesBuffer(new VertexBuffer(engine, paddedPositions, VertexBuffer.PositionKind, false, false, 4, false, 0, 3));
    padded.position.set(0, 0.3, -1.8);
    padded.material = missedMaterial;
    let paddedHidden = 0;
    const layout = await step(() => !isRevealPending(padded) && drawnEffect(padded) !== null,
      () => { if (isRevealPending(padded)) paddedHidden++; });

    // A spawn whose Material Play's load warmed: its staged box was warm-drawn, so the spawn creates no pipeline.
    const warmedMaterial = await graphMaterial(scene, "warmed", [0.1, 0.2, 0.9], (doc) => { doc.shadingModel = "unlit"; });
    await warmSpawnables(scene, { materials: [warmedMaterial], containers: [] });
    const staged = await step(() => !scene.meshes.some((mesh) => mesh.name.startsWith("spawnable-warm:")));
    const warmed = MeshBuilder.CreateBox("warmed", { size: 0.6 }, scene);
    warmed.position.set(-1, 0.3, -1.2);
    warmed.material = warmedMaterial;
    const warmSpawn = await step(() => !isRevealPending(warmed) && drawnEffect(warmed) !== null);

    // The sun starts casting shadows into a first, cascaded map (one render pass per cascade): it too waits, neutral,
    // for its casters' depth pipelines, while the floors keep drawing their Effects.
    setSceneRenderSettings(scene, {
      mode: "pbr",
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } }),
      shadows: normalizeShadowSettings({ cascades: 2, maxLocalLights: 2 }),
    });
    // New shadow settings rebuild the spot's map: let it draw again first.
    await step(() => (spot.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() === 0);
    const unshadowedBySun = floors.map(drawnEffect);
    authored(sun, [1, 0.95, 0.85], 2.2, true);
    const sunMap = () => sun.getShadowGenerator() as ShadowGenerator | null;
    const sunShadows = await step(() => sunMap()?.getDarkness() === 0);
    const sunShadowsKept = kept(unshadowedBySun);
    // A spawn into the drawn sun map with a caster depth variant no caster drew (an instanced one): hidden, it is
    // listed in the map's redraws only to create that pipeline asynchronously, and is revealed once it exists, so the
    // map's redraw with it creates none synchronously.
    const instanced = MeshBuilder.CreateBox("instanced spawn", { size: 0.5 }, scene);
    instanced.position.set(0, 0.25, -2);
    instanced.material = materials[0]!;
    instanced.thinInstanceAdd(Matrix.Identity());
    const castsIntoSun = () => {
      const effect = instanced.subMeshes[0]?._getDrawWrapper(sunMap()!.getShadowMap()!.renderPassIds[0]!)?.effect;
      return !!effect && effectDrawn(engine, effect);
    };
    let casterHiddenFrames = 0;
    const casterSpawn = await step(() => !isRevealPending(instanced) && drawnEffect(instanced) !== null && castsIntoSun(),
      () => { if (isRevealPending(instanced)) casterHiddenFrames++; });
    return {
      lightOff: { ...lightOff, kept: lightOffKept },
      swap: { ...swap, previousFrames },
      shadowGain: { ...shadowGain, kept: shadowGainKept },
      spawn: { ...spawn, hiddenFrames },
      respawn: { ...respawn, hiddenFrames: rebuiltHidden },
      layout: { ...layout, hiddenFrames: paddedHidden, sameEffect: drawnEffect(padded) === drawnEffect(rebuilt) },
      staged,
      warmSpawn,
      sunShadows: { ...sunShadows, kept: sunShadowsKept, cascades: sunMap()?.getShadowMap()?.renderPassIds.length ?? 0 },
      casterSpawn: { ...casterSpawn, hiddenFrames: casterHiddenFrames },
    };
  } finally {
    restore();
    coordinator.dispose();
    scene.dispose();
    setHapticLighting(engine, false);
  }
}

/**
 * A world view with a geometry pass (temporal anti-aliasing's view depth and velocity, which no warm draw warms): a
 * spawn with a variant nothing compiled stays hidden until its colour pipelines exist, and is then left out of the
 * geometry pass alone, with no frame held and no pipeline created synchronously, until its geometry pipeline exists.
 * The floor is unlit: its lighting is not this proof's subject.
 */
export async function proveWebGpuGeometrySpawn(engine: AbstractEngine) {
  setHapticLighting(engine, true);
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
  floorMaterial.unlit = true;
  const floor = MeshBuilder.CreateGround("floor", { width: 6, height: 6 }, scene);
  floor.material = floorMaterial;
  const coordinator = new SceneRenderCoordinator(scene, { deferPipelines: true });
  const { counts, restore } = countPipelines(engine);
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
    return {
      geometryPass: geometryPass >= 0, settled: settled >= 4, ...spawn, ms: Math.round(performance.now() - started),
    };
  } finally {
    restore();
    coordinator.dispose();
    scene.dispose();
    setHapticLighting(engine, false);
  }
}
