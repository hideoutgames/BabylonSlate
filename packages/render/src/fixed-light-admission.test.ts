import {
  HemisphericLight,
  NullEngine,
  NullEngineOptions,
  PointLight,
  Scene,
  SpotLight,
  UniversalCamera,
  Vector3,
  type Light,
} from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings, qualityPresetPatch } from "@haptic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixedLightSlotTable,
  setFixedShapeLightingEnabled,
  setFixedShapeLightingWorldScene,
} from "./fixed-light-admission";
import { isForwardLightExcluded, setAuthoredLightEnabled } from "./light-policy";
import { updateSceneRenderingSettings } from "./render-settings";
import { sceneLightingLimits, syncSceneLighting } from "./scene-lighting";
import { sceneShadowController } from "./shadow-controller";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A world Scene on a headless WebGL2 Engine (nine light slots) with fixed-shape lighting on. */
function world(options: { fixed?: boolean; world?: boolean } = {}) {
  const engineOptions = new NullEngineOptions();
  engineOptions.enableMultiview = true;
  const engine = new NullEngine(engineOptions);
  engines.push(engine);
  Object.assign(engine.getCaps(), {
    maxTexturesImageUnits: 16,
    maxTextureSize: 4096,
    maxCubemapTextureSize: 4096,
    textureHalfFloatRender: true,
    textureHalfFloatLinearFiltering: true,
  });
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  if (options.world !== false) setFixedShapeLightingWorldScene(scene);
  if (options.fixed !== false) setFixedShapeLightingEnabled(engine, true);
  const shadows = sceneShadowController(scene);
  // As the forward graph's shadow admission does: lights, then maps, then lights again.
  const sync = () => {
    syncSceneLighting(scene);
    shadows.sync();
    syncSceneLighting(scene);
  };
  const table = () => fixedLightSlotTable(scene)!;
  const seatOf = (light: Light) => {
    const seat = table().seats.find((entry) => entry.light === light);
    return seat ? `${seat.classId}:${seat.index}${seat.shadowActive ? " shadowed" : ""}` : null;
  };
  return { engine, scene, camera, shadows, sync, table, seatOf };
}

function spot(scene: Scene, name: string, x: number) {
  return new SpotLight(name, new Vector3(x, 3, 0), Vector3.Down(), 1, 1, scene);
}

describe("fixed-shape light admission", () => {
  it("leaves the Engine on the legacy path until its switch is on, and previews always", () => {
    const off = world({ fixed: false });
    new PointLight("lamp", Vector3.Zero(), off.scene);
    off.sync();
    expect(fixedLightSlotTable(off.scene)).toBeNull();
    const preview = world({ world: false });
    new PointLight("lamp", Vector3.Zero(), preview.scene);
    preview.sync();
    expect(fixedLightSlotTable(preview.scene)).toBeNull();
  });

  it("keeps every admitted light in its seat while others are switched off, on, or ranked out", () => {
    const { scene, camera, sync, table, seatOf } = world();
    const lamps = Array.from({ length: 12 }, (_, index) => new PointLight(`lamp-${index}`, new Vector3(index * 10, 3, 0), scene));
    sync();
    const layout = table().layout;
    expect(layout.classes.find((entry) => entry.id === "LOCAL_POINT")?.seats).toBe(9);
    const before = lamps.map(seatOf);
    expect(before.slice(0, 9).every(Boolean)).toBe(true);
    expect(lamps.slice(9).every(isForwardLightExcluded)).toBe(true);

    setAuthoredLightEnabled(lamps[4]!, false);
    sync();
    expect(seatOf(lamps[4]!)).toBeNull();
    for (const index of [0, 1, 2, 3, 5, 6, 7, 8]) expect(seatOf(lamps[index]!)).toBe(before[index]);
    setAuthoredLightEnabled(lamps[4]!, true);
    sync();
    expect(seatOf(lamps[4]!)).toBe(before[4]);

    // The camera moves to the far end: lamps 3 to 8 stay and keep their seats, 9 to 11 take those of 0 to 2.
    camera.position.x = 110;
    sync();
    for (const index of [3, 4, 5, 6, 7, 8]) expect(seatOf(lamps[index]!)).toBe(before[index]);
    expect(lamps.slice(9).map(seatOf).sort()).toEqual(before.slice(0, 3).sort());
    expect(lamps.slice(0, 3).every(isForwardLightExcluded)).toBe(true);
    // None of it changed the layout, so no shader would change.
    expect(table().layout).toBe(layout);
  });

  it("hands a spot shadow to the next spot within its class", () => {
    const { scene, camera, shadows, sync, table, seatOf } = world();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }) });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const near = spot(scene, "near", 0);
    const far = spot(scene, "far", 100);
    for (const light of [near, far]) shadows.register(light, true);
    sync();
    // Two shadow casters, but the profile has one local shadow light: one shadow seat.
    expect(table().layout.classes.find((entry) => entry.id === "SPOT_SHADOW")?.seats).toBe(1);
    expect(seatOf(near)).toBe("SPOT_SHADOW:0 shadowed");
    expect(seatOf(far)).toBe("LOCAL_SPOT:0");
    const layout = table().layout;

    clock.mockReturnValue(1_000);
    camera.position.x = 100;
    sync();
    expect(shadows.generator(far)).not.toBeNull();
    expect(seatOf(far)).toBe("SPOT_SHADOW:0 shadowed");
    expect(seatOf(near)).toBe("LOCAL_SPOT:0");
    expect(table().layout).toBe(layout);
  });

  it("seats a shadowed spot beyond its class unshadowed in a local spot seat while its map stays admitted", () => {
    const { scene, shadows, sync, seatOf } = world();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 3 }) });
    const spots = [0, 5, 10].map((x, index) => spot(scene, `spot-${index}`, x));
    for (const light of spots) shadows.register(light, true);
    sync();
    expect(spots.every((light) => shadows.generator(light) !== null)).toBe(true);
    // WebGL2 seats two spot shadows; the farthest spot lights without its shadow.
    expect(spots.map(seatOf)).toEqual(["SPOT_SHADOW:0 shadowed", "SPOT_SHADOW:1 shadowed", "LOCAL_SPOT:0"]);
  });

  it("keeps a caster's shadow seat with the shadow off when scene shadows turn off, and every light's seat", () => {
    const { scene, shadows, sync, table, seatOf } = world();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }) });
    const caster = spot(scene, "caster", 0);
    shadows.register(caster, true);
    const points = [5, 10, 15].map((x, index) => new PointLight(`point-${index}`, new Vector3(x, 3, 0), scene));
    sync();
    const layout = table().layout;
    expect(seatOf(caster)).toBe("SPOT_SHADOW:0 shadowed");
    const pointSeats = points.map(seatOf);
    expect(pointSeats.every((seat) => seat?.startsWith("LOCAL_POINT:"))).toBe(true);
    // The inventory's high-water mark still holds the caster, so its seat stays; it lights unshadowed there.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1, enabled: false }) });
    sync();
    expect(table().layout).toBe(layout);
    expect(shadows.generator(caster)).toBeNull();
    expect(seatOf(caster)).toBe("SPOT_SHADOW:0");
    expect(points.map(seatOf)).toEqual(pointSeats);
    // A new plain light grows the local seats; everyone keeps their seat.
    const added = new PointLight("added", new Vector3(20, 3, 0), scene);
    sync();
    expect(table().layout.classes.find((entry) => entry.id === "LOCAL_POINT")?.seats).toBe(4);
    expect(seatOf(caster)).toBe("SPOT_SHADOW:0");
    expect(points.map(seatOf)).toEqual(pointSeats);
    expect(seatOf(added)).toBe("LOCAL_POINT:3");
  });

  it("limits lights beyond their class or the scalability local lights and names them", () => {
    const { scene, sync, seatOf } = world();
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    const extra = new HemisphericLight("extra fill", Vector3.Up(), scene);
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("low")) });
    const lamps = Array.from({ length: 6 }, (_, index) => new PointLight(`lamp-${index}`, new Vector3(index * 10, 3, 0), scene));
    sync();
    expect(seatOf(fill)).toBe("FILL:0");
    expect(seatOf(extra)).toBeNull();
    expect(isForwardLightExcluded(extra)).toBe(true);
    expect(lamps.filter(isForwardLightExcluded)).toEqual(lamps.slice(4));
    const limits = sceneLightingLimits(scene).join();
    expect(limits).toContain("Fixed-shape lighting: 5/8 requested lights admitted");
    expect(limits).toContain("extra fill (no free seat)");
    expect(limits).toContain("lamp-4 (scalability local lights)");
  });
});
