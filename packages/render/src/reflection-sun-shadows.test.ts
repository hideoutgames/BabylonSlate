import { DirectionalLight, Matrix, MeshBuilder, NullEngine, Scene, SpotLight, UniversalCamera, Vector3 } from "@babylonjs/core";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeShadowSettings } from "@haptic/core";
import { buildViewProjectionMatrix, PlanarMirrorCamera, PlanarMirrorMath, type MirrorPlane } from "./planar-mirror";
import { ReflectionSunShadows } from "./reflection-sun-shadows";
import { updateSceneRenderingSettings } from "./render-settings";
import { AtlasCascadedShadowGenerator } from "./shadow-atlas";
import { sceneShadowController } from "./shadow-controller";
import { awaitsFirstDraw } from "./shadow-first-draw";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** The shadow controller's light block path on a NullEngine (as `shadow-controller.test.ts`), with a shadowed sun. */
function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16, maxTextureSize: 4096, maxCubemapTextureSize: 4096 });
  engine._features.supportCSM = true;
  engine._features.supportShadowSamplers = true;
  const scene = new Scene(engine);
  // The view: at the eye, looking toward +Z at a wall mirror 14 m ahead (its reflective side faces it).
  const view = new UniversalCamera("view", new Vector3(0, 2, -4), scene);
  view.setTarget(new Vector3(0, 2, 10));
  view.minZ = 0.1;
  view.maxZ = 1000;
  scene.activeCamera = view;
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({ profile: "high", cascades: 2, distance: 60, mapSize: 512, localMapSize: 256, maxLocalLights: 1, reflections: true }),
  });
  const controller = sceneShadowController(scene);
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2), scene);
  controller.register(sun, true);
  controller.sync();
  // The mirror camera as a Mirror places it, and the view's ordinary projection its oblique one was made from.
  const plane: MirrorPlane = { nx: 0, ny: 0, nz: -1, d: 10 };
  const mirror = new PlanarMirrorCamera("mirror", Vector3.Zero(), scene, false);
  const oblique = new Matrix(), fit = new Matrix();
  buildViewProjectionMatrix(scene, view, engine.getAspectRatio(view), fit);
  const math = new PlanarMirrorMath();
  expect(math.mirror(view.getViewMatrix(), view.globalPosition, plane, fit, engine.useReverseDepthBuffer, engine.isNDCHalfZRange,
    mirror.mirrorView, oblique)).toBe(true);
  mirror.freezeProjectionMatrix(oblique);
  mirror.position.set(math.eye[0]!, math.eye[1]!, math.eye[2]!);
  mirror.minZ = view.minZ;
  mirror.maxZ = view.maxZ;
  mirror.getViewMatrix(true);
  return { engine, scene, view, controller, sun, mirror, oblique, fit, shadows: new ReflectionSunShadows(scene, mirror, oblique) };
}

/**
 * Whether the light block's choice of cascade for world point `p` (the first whose far end lies beyond its view depth
 * by the camera the cascades were drawn for, `hapticSunShadowFactor`) has `p` inside its tile: -1 when no cascade
 * covers its depth.
 */
function chosenCascadeCovers(map: AtlasCascadedShadowGenerator, p: Vector3): boolean | -1 {
  const plane = map.cascadeDepth;
  const depth = plane.x * p.x + plane.y * p.y + plane.z * p.z + plane.w;
  const index = map.cascadeEnds.findIndex((end, cascade) => cascade < map.numCascades && end >= depth);
  if (index < 0) return -1;
  const clip = Vector3.TransformCoordinates(p, map.drawnViews[index]!);
  return Math.abs(clip.x) <= 1 && Math.abs(clip.y) <= 1;
}

it("draws a reflection's own sun cascades fitted to its mirrored view, covering what only the reflection shows", () => {
  const { scene, sun, mirror, fit, shadows, oblique } = fixture();
  const main = sun.getShadowGenerator() as AtlasCascadedShadowGenerator;
  scene.incrementRenderId();
  scene.updateTransformMatrix(true);
  main.getShadowMap()!.render();
  shadows.prepare(true, fit, "mirrors", 1);
  const own = sun.getShadowGenerator(mirror);
  expect(own).toBeInstanceOf(AtlasCascadedShadowGenerator);
  expect(own).not.toBe(sun.getShadowGenerator());
  const map = own as AtlasCascadedShadowGenerator;
  // Drawn before the pass: no longer neutral, and its cascades split the shadow distance by the mirror camera's depth.
  expect(awaitsFirstDraw(map)).toBe(false);
  expect(map.cascadeEnds.slice(0, 2).every((end) => end > 0 && end <= 60 + 1e-6)).toBe(true);
  // The mirror camera's projection is the oblique one again for its pass.
  expect(mirror.getProjectionMatrix()).toBe(oblique);
  // Behind the view, seen only in the mirror: 34 m and 41 m from the mirror camera along its view, each in the cascade
  // the light block chooses for it, and beside it on the floor.
  for (const point of [new Vector3(0, 0, -10), new Vector3(3, 0, -10), new Vector3(-4, 0, -17)])
    expect(chosenCascadeCovers(map, point), point.toString()).toBe(true);
  // Beyond the shadow distance, no cascade: the sun is unshadowed there.
  expect(chosenCascadeCovers(map, new Vector3(0, 0, -60))).toBe(-1);
  // Fitted as the scene view's are, to a frustum of the same shape: the same splits and, cascade by cascade, the same
  // detail. Fitted to the oblique projection (its near plane the mirror's), they would be several times coarser.
  expect(map.cascadeEnds).toEqual(main.cascadeEnds);
  map.cascadeDensity.forEach((cascade, index) => expect(cascade.texelsPerMetre).toBeCloseTo(main.cascadeDensity[index]!.texelsPerMetre, 3));
  expect(scene.activeCamera?.name).toBe("view");
});

it("draws a reflection's maps again only when they change, and gives them back", async () => {
  const { scene, controller, sun, mirror, fit, shadows } = fixture();
  const caster = MeshBuilder.CreateBox("caster", { size: 1 }, scene);
  caster.position.set(0, 3, -10);
  controller.sync();
  controller.refreshShadowMaps();
  // Never drawn: due under Reflection Shadows, not without.
  expect(shadows.due(false, fit)).toBe(false);
  expect(shadows.due(true, fit)).toBe(true);
  shadows.prepare(true, fit, "mirrors", 1);
  expect([shadows.claimed, shadows.holdsMaps]).toEqual([true, true]);
  const own = sun.getShadowGenerator(mirror) as AtlasCascadedShadowGenerator;
  const map = own.getShadowMap()!;
  // Its first draw waits for the caster's depth variant, neutral and due meanwhile.
  expect([awaitsFirstDraw(own), shadows.due(true, fit)]).toEqual([true, true]);
  for (let tries = 0; tries < 20 && !map.isReadyForRendering(); tries++) await new Promise((resolve) => setTimeout(resolve, 0));
  shadows.prepare(true, fit, "mirrors", 1);
  expect(awaitsFirstDraw(own)).toBe(false);
  // Its first pass leaves the automatic bias of its last cascade, which draws it once more, as it does a scene view's map.
  shadows.prepare(true, fit, "mirrors", 2);
  const render = vi.spyOn(map, "render");
  // Then nothing changed: its last pass is current, and preparing the next draws nothing.
  expect(shadows.due(true, fit)).toBe(false);
  shadows.prepare(true, fit, "mirrors", 2);
  expect(render).not.toHaveBeenCalled();
  // A caster it draws moves: due, and drawn again once.
  caster.position.x += 0.5;
  controller.refreshShadowMaps();
  expect(shadows.due(true, fit)).toBe(true);
  shadows.prepare(true, fit, "mirrors", 3);
  expect(render).toHaveBeenCalledTimes(1);
  expect(shadows.due(true, fit)).toBe(false);
  // The sun turns: due again.
  sun.direction.set(-0.3, -1, 0.2);
  expect(shadows.due(true, fit)).toBe(true);
  shadows.prepare(true, fit, "mirrors", 4);
  // A spot light's shadow does not depend on the view: the reflection binds the scene view's.
  const spot = new SpotLight("spot", new Vector3(0, 4, -10), new Vector3(0, -1, 0), 1, 1, scene);
  controller.register(spot, true);
  controller.sync();
  expect(spot.getShadowGenerator(mirror)).toBeNull();
  // Reflection Shadows off: the next pass gives the maps back, and its image is due for drawing unshadowed.
  expect(shadows.due(false, fit)).toBe(true);
  shadows.prepare(false, fit, "mirrors", 5);
  await Promise.resolve();
  expect(sun.getShadowGenerator(mirror)).toBeNull();
  expect([shadows.claimed, shadows.due(false, fit)]).toEqual([false, false]);
  // On again, then idle: given back after its owner's renders pass without a draw.
  shadows.prepare(true, fit, "mirrors", 10);
  shadows.releaseIdle(130);
  expect(shadows.claimed).toBe(true);
  shadows.releaseIdle(131);
  expect(shadows.claimed).toBe(false);
  expect(sun.getShadowGenerator(mirror)).toBeNull();
  // Given back, it is due for drawing with maps again.
  expect(shadows.due(true, fit)).toBe(true);
});
