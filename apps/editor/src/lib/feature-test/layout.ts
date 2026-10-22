/**
 * Fixed world layout of the FeatureTest main scene. Every area places its
 * actors inside its own zone so features never overlap and performance runs
 * always see the same scene. +X right, +Y up, +Z away from the main camera.
 * Landscape and water live in the separate `FT_World` scene (`world.ts`).
 */

export type FeatureTestZoneId =
  | "hub"
  | "meshes"
  | "lights"
  | "effects"
  | "renderTargets"
  | "physics"
  | "movement"
  | "animation"
  | "particles"
  | "audio"
  | "ai"
  | "scripting"
  | "streaming"
  | "lod";

export interface FeatureTestZone {
  id: FeatureTestZoneId;
  /** Title Case label drawn as 3D Text over the zone. */
  title: string;
  /** Zone center on the ground plane (x, z). */
  center: readonly [number, number];
  /** Usable footprint (x, z) in meters. Keep content inside it. */
  size: readonly [number, number];
}

/** Zones sit on a 32 m grid; each keeps an 8 m gap to its neighbours. */
export const FEATURE_TEST_ZONES: Readonly<Record<FeatureTestZoneId, FeatureTestZone>> = {
  hub: { id: "hub", title: "Feature Test", center: [0, 0], size: [24, 24] },
  meshes: { id: "meshes", title: "Meshes And Materials", center: [-32, 0], size: [24, 24] },
  lights: { id: "lights", title: "Lights And Shadows", center: [32, 0], size: [24, 24] },
  effects: { id: "effects", title: "Effects", center: [-64, 0], size: [24, 24] },
  renderTargets: { id: "renderTargets", title: "Render Targets", center: [64, 0], size: [24, 24] },
  audio: { id: "audio", title: "Audio", center: [-64, 32], size: [24, 24] },
  physics: { id: "physics", title: "Physics", center: [-32, 32], size: [24, 24] },
  movement: { id: "movement", title: "Constraints And Movement", center: [0, 32], size: [24, 24] },
  animation: { id: "animation", title: "Animation", center: [32, 32], size: [24, 24] },
  particles: { id: "particles", title: "Particles", center: [64, 32], size: [24, 24] },
  streaming: { id: "streaming", title: "Scene Streaming", center: [-64, 64], size: [24, 24] },
  scripting: { id: "scripting", title: "Scripting", center: [-32, 64], size: [24, 24] },
  ai: { id: "ai", title: "AI And Navigation", center: [0, 64], size: [24, 24] },
  lod: { id: "lod", title: "Model LOD", center: [64, 64], size: [56, 24] },
};

/**
 * Main camera: a Spring Arm rig that tours the main scene in Play along the
 * closed `FEATURE_TEST_CAMERA_TOUR` Spline. Its authored pose is the tour's start.
 */
export const FEATURE_TEST_MAIN_CAMERA = {
  actorId: "ft-camera-main",
  componentId: "ft-camera-main-cam",
};

/**
 * Looping camera tour (world metres): along the front of the first zone row,
 * low through both gaps between rows, high behind the back row, then a high
 * sweep down the left side back to the start. Clear of every zone footprint.
 */
export const FEATURE_TEST_CAMERA_TOUR = {
  pathActorId: "ft-camera-tour-path",
  /** Metres per second along the path; one lap takes about two and a half minutes. */
  speed: 6,
  points: [
    [-72, 10, -16], [-24, 9, -16], [24, 9, -16], [72, 10, -16],
    [90, 9, 0], [72, 7, 16], [24, 6, 16], [-24, 6, 16], [-72, 7, 16],
    [-90, 8, 32], [-72, 7, 48], [-24, 6, 48], [24, 7, 48], [72, 9, 48],
    [100, 13, 66], [72, 16, 86], [24, 16, 86], [-24, 16, 86], [-72, 18, 86],
    [-100, 22, 56], [-104, 20, 16], [-94, 14, -10],
  ] as Array<[number, number, number]>,
};

/** World position from a zone-local offset (x, y, z). */
export function zonePoint(
  zone: FeatureTestZoneId,
  offset: readonly [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const { center } = FEATURE_TEST_ZONES[zone];
  return [center[0] + offset[0], offset[1], center[1] + offset[2]];
}

export type FeatureTestStressRegionId = "physics" | "particles" | "animation" | "foliage";

/**
 * `FT_Stress` scene regions (x range, z range). Heavy, scalable workloads live
 * here so the main scene stays a moderate, representative showcase.
 */
export const FEATURE_TEST_STRESS_REGIONS: Readonly<
  Record<FeatureTestStressRegionId, { center: readonly [number, number]; size: readonly [number, number] }>
> = {
  physics: { center: [-48, 0], size: [32, 32] },
  particles: { center: [-12, 0], size: [24, 32] },
  animation: { center: [20, 0], size: [24, 32] },
  foliage: { center: [56, 0], size: [32, 32] },
};

/** Static `FT_Stress` main camera (the scene's default camera, re-aimed). */
export const FEATURE_TEST_STRESS_CAMERA = {
  position: [0, 34, -58] as [number, number, number],
  target: [0, 0, 6] as [number, number, number],
};

/** World position in the `FT_Stress` scene from a region-local offset. */
export function stressPoint(
  region: FeatureTestStressRegionId,
  offset: readonly [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const { center } = FEATURE_TEST_STRESS_REGIONS[region];
  return [center[0] + offset[0], offset[1], center[1] + offset[2]];
}
