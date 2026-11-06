import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import {
  fogVolumeBindings,
  identitySerializedTransform,
  normalizeCelShadingSettings,
  normalizeRenderEffectsSettings,
  normalizeShadowSettings,
  normalizeRenderingQuality,
  type RenderMode,
} from "@haptic/core";
import {
  applyAuthoredLightProperties,
  createAppWebGpuEngine,
  MaterialLibrary,
  setSceneRenderSettings,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { managedRenderReservations } from "@haptic/render/managed-render-resources";
import { removeFogVolumes, upsertFogVolumes } from "@haptic/render/fog-volumes";
import { createDefaultMaterialDocument } from "@haptic/shader-graph";
import { setUnlitMaterial } from "../../../../packages/render/src/unlit-material";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

async function captureFogVolumes(
  scene: Scene,
  camera: FreeCamera,
  effects: ReturnType<typeof normalizeRenderEffectsSettings>,
  draw: () => Promise<number[]>,
) {
  const root = new TransformNode("Local Fog Actor", scene);
  const properties = { enabled: true, shape: "box", size: [2, 2, 2], density: 0.8, edgeFalloff: 0 };
  const update = () => upsertFogVolumes(scene, "fog-actor", root, fogVolumeBindings([{
    id: "fog-component",
    classId: "FogVolumeComponent",
    properties,
    transform: identitySerializedTransform(),
  }]));
  try {
    const off = await draw();
    root.position.x = -2;
    root.scaling.set(1.5, 0.75, 1);
    root.rotation.z = Math.PI / 4;
    update();
    const box = await draw();
    upsertFogVolumes(scene, "fog-actor", root, fogVolumeBindings(["first", "second"].map((id) => ({
      id,
      classId: "FogVolumeComponent",
      properties: { ...properties, density: 0.4 },
      transform: identitySerializedTransform(),
    }))));
    const overlap = await draw();
    update();
    // Root transform changes must reach the shader without replacing bindings.
    root.position.x = 2;
    const moved = await draw();
    root.rotation.z = 0;
    root.scaling.set(2, 0.5, 1);
    properties.shape = "sphere";
    update();
    const sphere = await draw();
    properties.edgeFalloff = 0.5;
    update();
    const softSphere = await draw();
    properties.edgeFalloff = 0;
    properties.enabled = false;
    update();
    const disabled = await draw();
    properties.enabled = true;
    update();
    await draw();
    removeFogVolumes(scene, "fog-actor");
    const removed = await draw();

    camera.position.set(0, 0, 0);
    camera.setTarget(new Vector3(0, 0, 8));
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    const insideOff = await draw();
    root.position.set(0, 0, 0);
    root.scaling.set(1, 1, 1);
    properties.shape = "box";
    properties.size = [4, 4, 4];
    update();
    const inside = await draw();

    // Scene-wide fog on (uniform, extinction only: intensity 0). The Fog Volume ahead must take the same fog from every
    // camera position a fraction of a march step apart, and a Volumetric Distance short of it must not cut it.
    Object.assign(effects.volumetricLighting, { enabled: true, density: 0.02 });
    properties.size = [2, 2, 2];
    root.position.set(0, 0, 4);
    const walk: { clear: number[]; fogged: number[] }[] = [];
    for (const z of [-1, -1.1, -1.2, -1.3, -1.4]) {
      camera.position.set(0, 0, z);
      camera.setTarget(new Vector3(0, 0, 8));
      removeFogVolumes(scene, "fog-actor");
      const clear = await draw();
      update();
      walk.push({ clear, fogged: await draw() });
    }
    effects.volumetricLighting.maxDistance = 2;
    removeFogVolumes(scene, "fog-actor");
    const beyondClear = await draw();
    update();
    const beyond = await draw();
    return { off, box, overlap, moved, sphere, softSphere, disabled, removed, insideOff, inside, walk, beyondClear, beyond };
  } finally {
    removeFogVolumes(scene, "fog-actor");
    root.dispose();
  }
}

/** Occlusion darkens the contact crease, keeps open floor and the sky, and
 * follows an orthographic projection without stale shader state; a floor seen
 * almost edge-on stays unoccluded, as do a wall behind a plate standing more
 * than twice the radius in front of it and a coarse smooth-shaded ball. */
async function captureAmbientOcclusion(
  camera: FreeCamera,
  effects: ReturnType<typeof normalizeRenderEffectsSettings>,
  draw: () => Promise<number[]>,
) {
  const off = await draw();
  effects.ambientOcclusion.enabled = true;
  const on = await draw();
  effects.colorPipeline.mode = "sceneLinear";
  const linear = await draw();
  effects.colorPipeline.mode = "legacyDisplay";
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -4;
  camera.orthoRight = 4;
  camera.orthoTop = 3;
  camera.orthoBottom = -3;
  const orthographic = await draw();
  effects.ambientOcclusion.enabled = false;
  const orthographicOff = await draw();
  camera.mode = Camera.PERSPECTIVE_CAMERA;
  const disabled = await draw();
  // The open floor seen almost edge-on, the crate hidden: a surface never occludes itself.
  const scene = camera.getScene();
  const crate = scene.getMeshByName("Occluding Crate")!;
  const floor = scene.getMeshByName("Floor")!;
  crate.setEnabled(false);
  camera.position.set(0, 0.3, -6);
  camera.setTarget(new Vector3(0, 0.15, 4));
  const grazingOff = await draw();
  effects.ambientOcclusion.enabled = true;
  const grazing = await draw();
  // A darker plate a little over twice the radius (0.6) in front of a wall: the wall around it stays unoccluded.
  floor.setEnabled(false);
  const wall = MeshBuilder.CreatePlane("Halo Wall", { size: 12 }, scene);
  wall.position.set(0, 1, 2);
  wall.material = crate.material;
  const plateMaterial = new PBRMaterial("Halo Plate", scene);
  plateMaterial.unlit = true;
  plateMaterial.albedoColor = new Color3(0.2, 0.2, 0.2);
  const plate = MeshBuilder.CreateBox("Halo Plate", { width: 1, height: 1, depth: 0.1 }, scene);
  plate.position.set(0, 1, 0.65);
  plate.material = plateMaterial;
  camera.position.set(0, 1, -6);
  camera.setTarget(new Vector3(0, 1, 1));
  const halo = await draw();
  effects.ambientOcclusion.enabled = false;
  const haloOff = await draw();
  // A coarse smooth-shaded ball alone: its shaded normals tilt across each face, yet nothing occludes it.
  wall.setEnabled(false);
  plate.setEnabled(false);
  const ball = MeshBuilder.CreateSphere("Facet Ball", { segments: 2, diameter: 2.5 }, scene);
  ball.position.set(0, 1, 0);
  ball.material = crate.material;
  const facetsOff = await draw();
  effects.ambientOcclusion.enabled = true;
  const facets = await draw();
  return { off, on, linear, orthographic, orthographicOff, disabled, grazingOff, grazing, haloOff, halo, facetsOff, facets };
}

/** The render mode the proof's next draw applies. */
type ReflectionRender = { mode: RenderMode };

/**
 * A red unlit box over a floor, drawn without and with Real-Time Reflections for each surface kind: an authored
 * graph mirror in PBR and in CEL, and a floor drawn with the engine's unlit Material, which writes no reflectivity.
 */
async function captureReflections(
  floor: Mesh,
  mirror: Material,
  render: ReflectionRender,
  effects: ReturnType<typeof normalizeRenderEffectsSettings>,
  draw: () => Promise<number[]>,
) {
  const pair = async (material: Material | (() => Material), mode: RenderMode) => {
    if (typeof material === "function") material = material();
    else floor.material = material;
    render.mode = mode;
    const capture = async (enabled: boolean) => {
      effects.reflections.enabled = enabled;
      try {
        return await draw();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${material.name}, ${mode}, reflections ${enabled ? "on" : "off"}: ${message}`, { cause: error });
      }
    };
    const off = await capture(false);
    const on = await capture(true);
    return { off, on };
  };
  const unlit = () => setUnlitMaterial(floor, { textured: false, backFaceCulling: true, fog: true, role: "world" }, {
    texture: null, color: [0.1, 0.1, 0.1], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
  });
  return {
    pbr: await pair(mirror, "pbr"),
    cel: await pair(mirror, "cel"),
    unlit: await pair(unlit, "pbr"),
  };
}

/** The proof's fog spot light: at (0, 3, 0) aiming down, a 90-degree cone of range 12. */
const FOG_LIGHT = { position: new Vector3(0, 3, 0), cosHalfAngle: Math.cos(Math.PI / 4), range: 12 };
/** The beam occluder's box, 2 x 0.2 x 2 centred at (0, 1.5, 0). */
const OCCLUDER = { min: new Vector3(-1, 1.4, -1), max: new Vector3(1, 1.6, 1) };

/** Whether the segment from `from` to `to` passes through the occluder's box (the slab test). */
function crossesOccluder(from: Vector3, to: Vector3): boolean {
  let enter = 0;
  let leave = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-9) {
      if (from[axis] < OCCLUDER.min[axis] || from[axis] > OCCLUDER.max[axis]) return false;
      continue;
    }
    let near = (OCCLUDER.min[axis] - from[axis]) / delta;
    let far = (OCCLUDER.max[axis] - from[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    leave = Math.min(leave, far);
    if (enter > leave) return false;
  }
  return true;
}

/**
 * Per pixel, in readPixels' rows (WebGL2's bottom-up, WebGPU's top-down): how far the camera's ray travels through the
 * fog light's cone where the occluder blocks the light (`shadowed`), in metres, up to the march's distance or the
 * first surface, and through it in the march step past that surface
 * (`shadowedBeyond`: the march's samples lie a step apart, so its last one may lie up to a step beyond the surface).
 */
function beamLengths(scene: Scene, camera: FreeCamera, engine: AbstractEngine, maxDistance: number, marchStep: number) {
  const width = engine.getRenderWidth();
  const height = engine.getRenderHeight();
  const shadowed: number[] = [];
  const shadowedBeyond: number[] = [];
  const step = 0.01;
  for (let row = 0; row < height; row++) {
    const y = engine.isWebGPU ? row + 0.5 : height - row - 0.5;
    for (let column = 0; column < width; column++) {
      const ray = scene.createPickingRay(column + 0.5, y, Matrix.Identity(), camera);
      const hit = scene.pickWithRay(ray);
      const surface = Math.min(hit?.hit ? hit.distance : Infinity, maxDistance);
      const end = Math.min(surface + marchStep, maxDistance);
      let inShadow = 0;
      let beyond = 0;
      for (let distance = step / 2; distance < end; distance += step) {
        const point = ray.origin.add(ray.direction.scale(distance));
        const toPoint = point.subtract(FOG_LIGHT.position);
        const length = toPoint.length();
        if (length >= FOG_LIGHT.range || -toPoint.y / length < FOG_LIGHT.cosHalfAngle) continue;
        if (!crossesOccluder(point, FOG_LIGHT.position)) continue;
        if (distance < surface) inShadow += step;
        else beyond += step;
      }
      shadowed.push(Math.round(inShadow * 100) / 100);
      shadowedBeyond.push(Math.round(beyond * 100) / 100);
    }
  }
  return { width, height, shadowed, shadowedBeyond };
}

/**
 * Actual numeric pixels from authored materials and scene lights, without editor chrome, on the light
 * block. `volumetricShadows`: the shadowed fog spot light without and with volumetric lighting, its shadow cast and not,
 * over unlit surfaces, with how far each pixel's view ray runs through the beam's shadowed and open parts.
 */
export async function runSpatialEffectsProof(
  backend: "webgl2" | "webgpu",
  kind: "combined" | "fogVolumes" | "ambientOcclusion" | "reflections" | "volumetricShadows",
) {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine =
    backend === "webgpu"
      ? await createAppWebGpuEngine(canvas)
      : new Engine(canvas, false, {
          preserveDrawingBuffer: true,
          stencil: true,
        });
  engine.setSize(96, 72);
  try {
    const captureScene = async () => {
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 1);
      const library = new MaterialLibrary();
      const camera = new FreeCamera(
        "Spatial Camera",
        new Vector3(0, 2.5, -6),
        scene,
      );
      camera.minZ = 0.1;
      camera.maxZ = 30;
      camera.setTarget(new Vector3(0, 0.6, 0));
      if (kind === "fogVolumes") {
        camera.position.set(0, 0, -8);
        camera.setTarget(Vector3.Zero());
        camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
        camera.orthoLeft = -6;
        camera.orthoRight = 6;
        camera.orthoTop = 4.5;
        camera.orthoBottom = -4.5;
      }
      scene.activeCamera = camera;
      const black = new PBRMaterial("Neutral Occluders", scene);
      black.unlit = true;
      black.albedoColor = new Color3(0.08, 0.08, 0.08);
      const floor = MeshBuilder.CreateGround(
        "Floor",
        { width: 20, height: 20 },
        scene,
      );
      floor.material = black;
      if (kind === "fogVolumes") {
        black.albedoColor.set(0.6, 0.6, 0.6);
        black.backFaceCulling = false;
        floor.rotation.x = -Math.PI / 2;
        floor.position.z = 8;
      }
      let light: SpotLight | undefined;
      if (kind === "ambientOcclusion") {
        black.albedoColor.set(0.7, 0.7, 0.7);
        const crate = MeshBuilder.CreateBox("Occluding Crate", { size: 1.5 }, scene);
        crate.position.y = 0.75;
        crate.material = black;
      }
      let mirror: Material | undefined;
      if (kind === "combined" || kind === "reflections") {
        const document = createDefaultMaterialDocument("Authored Mirror");
        document.nodes.find(
          (node) => node.id === "baseColor",
        )!.properties.value = [0.9, 0.9, 0.9];
        Object.assign(
          document.nodes.find((node) => node.id === "output")!.properties,
          { "default:metallic": [1], "default:roughness": [0.05] },
        );
        const compiled = library.acquire(scene, "mirror", document);
        if (
          !compiled.ok ||
          (await compiled.ready).some((d) => d.severity === "error")
        )
          throw new Error("Mirror compilation failed");
        floor.material = mirror = compiled.material;
        const red = new PBRMaterial("Red Reflection Subject", scene);
        red.unlit = true;
        red.albedoColor = new Color3(0.6, 0, 0);
        const box = MeshBuilder.CreateBox(
          "Reflection Subject",
          { size: 1.5 },
          scene,
        );
        box.position.y = 1.3;
        box.material = red;
      }
      if (kind === "combined" || kind === "volumetricShadows") {
        light = new SpotLight(
          "Fog Light",
          FOG_LIGHT.position.clone(),
          Vector3.Down(),
          Math.PI / 2,
          1,
          scene,
        );
        applyAuthoredLightProperties(light, {
          intensity: 20,
          range: 12,
          outerAngle: 90,
          innerAngle: 60,
          castShadows: true,
        });
        const blocker = MeshBuilder.CreateBox(
          "Beam Occluder",
          { width: 2, height: 0.2, depth: 2 },
          scene,
        );
        blocker.position.copyFrom(OCCLUDER.min.add(OCCLUDER.max).scale(0.5));
        blocker.material = black;
      }
      const effects = normalizeRenderEffectsSettings({
        ambientOcclusion: { enabled: false, resolutionScale: 1, radius: 0.6, strength: 2 },
        reflections: { enabled: false, maxSteps: 96, thickness: 0.3 },
        volumetricLighting: {
          enabled: false,
          steps: 32,
          density: 0.12,
          // The same density at every height: the beam's reference (`beamLengths`) is uniform fog.
          heightFalloff: 0,
          maxDistance: 12,
          intensity: 2,
          anisotropy: 0,
        },
      });
      if (kind === "fogVolumes") {
        Object.assign(effects.volumetricLighting, {
          enabled: false, density: 0, intensity: 0, resolutionScale: 1, maxDistance: 20,
        });
      }
      const render: ReflectionRender = { mode: "pbr" };
      const settings = () =>
        setSceneRenderSettings(scene, {
          mode: render.mode,
          cel: normalizeCelShadingSettings({}),
          effects,
          // Medium, the default tier, skips reflections and scene-wide volumetrics.
          quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
          shadows: normalizeShadowSettings({
            mapSize: 256,
            localMapSize: 256,
            cascades: 2,
            maxLocalLights: 1,
            distance: 20,
          }),
        });
      settings();
      const graph = new ForwardSceneFrameGraph(scene);
      const draw = async (activeCamera = camera) => {
        scene.activeCamera = activeCamera;
        settings();
        await graph.prepare(activeCamera);
        const deadline = performance.now() + 15_000;
        while (!graph.readiness(activeCamera).ready) {
          if (performance.now() > deadline)
            throw new Error("Spatial readiness timed out");
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
        }
        // Warm the native prepass and updated shadow map before readback.
        for (let presented = 0; presented < 2;) {
          engine.beginFrame();
          let rendered: boolean;
          try {
            const result = graph.render(activeCamera, false);
            rendered = result.rendered !== false;
          } finally {
            engine.endFrame();
          }
          if (rendered) presented++;
          else {
            if (performance.now() > deadline)
              throw new Error("Spatial presentation timed out");
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
            await graph.prepare(activeCamera);
          }
        }
        const pixels = await engine.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
        );
        return toRgbaPixels(
          new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
          readbackChannelOrder(engine.isWebGPU),
        );
      };
      try {
        if (kind === "fogVolumes") {
          return { fogCaptures: [await captureFogVolumes(scene, camera, effects, draw)] };
        }
        if (kind === "ambientOcclusion") {
          return { occlusionCaptures: [await captureAmbientOcclusion(camera, effects, draw)] };
        }
        if (kind === "reflections") {
          return { reflectionCaptures: [await captureReflections(floor, mirror!, render, effects, draw)] };
        }
        if (kind === "volumetricShadows") {
          if (!light) throw new Error("The volumetric shadow capture has no spot light");
          const off = await draw();
          effects.volumetricLighting.enabled = true;
          const shadowed = await draw();
          applyAuthoredLightProperties(light, { intensity: 20, range: 12, outerAngle: 90, innerAngle: 60, castShadows: false });
          const open = await draw();
          const { maxDistance, steps } = effects.volumetricLighting;
          const beam = beamLengths(scene, camera, engine, maxDistance, maxDistance / steps);
          // Fog Height far below the scene with a steep falloff: the scene-wide fog all but vanishes over it.
          Object.assign(effects.volumetricLighting, { height: -5, heightFalloff: 2 });
          const aboveFog = await draw();
          return { volumetricShadowCaptures: [{ off, shadowed, open, beam, aboveFog }] };
        }
        const off = await draw();
        effects.reflections.enabled = true;
        effects.volumetricLighting.enabled = true;
        const on = await draw();
        effects.vignette.enabled = true;
        effects.vignette.weight = 0;
        const identityDisplay = await draw();
        effects.vignette.enabled = false;
        // Scene Linear without a tone curve: the pipeline alone keeps the spatial colour.
        effects.colorPipeline.mode = "sceneLinear";
        effects.toneMapping = "none";
        const linear = await draw();
        effects.colorPipeline.mode = "legacyDisplay";
        if (!light) throw new Error("The combined capture has no spot light");
        applyAuthoredLightProperties(light, {
          intensity: 20,
          range: 12,
          outerAngle: 90,
          innerAngle: 60,
          castShadows: false,
        });
        const changed = await draw();
        applyAuthoredLightProperties(light, {
          intensity: 20,
          range: 12,
          outerAngle: 90,
          innerAngle: 60,
          castShadows: true,
        });
        effects.reflections.enabled =
          effects.volumetricLighting.enabled = false;
        const disabled = await draw();
        return { captures: [{
          off,
          on,
          identityDisplay,
          linear,
          changed,
          disabled,
        }] };
      } finally {
        graph.dispose();
        await graph.whenReleased();
        library.dispose();
        scene.dispose();
        // This fixture owns the entire engine. Drain queued WebGPU destruction
        // after CPU teardown, just as the host's next frame or Engine.dispose does.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        engine.beginFrame();
        engine.endFrame();
      }
    };
    const scenes = [await captureScene()];
    return {
      captures: scenes.flatMap((scene) => scene.captures ?? []),
      fogCaptures: scenes.flatMap((scene) => scene.fogCaptures ?? []),
      occlusionCaptures: scenes.flatMap((scene) => scene.occlusionCaptures ?? []),
      reflectionCaptures: scenes.flatMap((scene) => scene.reflectionCaptures ?? []),
      volumetricShadowCaptures: scenes.flatMap((scene) => scene.volumetricShadowCaptures ?? []),
      reservations: managedRenderReservations(engine),
    };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
