/**
 * Fixed world layout of the FeatureTest main scene. Every area places its
 * actors inside its own zone so features never overlap and performance runs
 * always see the same scene. +X right, +Y up, +Z away from the main camera.
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
  | "lod"
  | "world";

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
  world: { id: "world", title: "Landscape And Water", center: [0, 144], size: [112, 80] },
};

/** Static main camera: frames the three zone rows from behind and above. */
export const FEATURE_TEST_MAIN_CAMERA = {
  actorId: "ft-camera-main",
  componentId: "ft-camera-main-cam",
  position: [0, 38, -52] as [number, number, number],
  target: [0, 0, 36] as [number, number, number],
};

/** Global Water Volume elevation: below every zone floor so nothing floods. */
export const FEATURE_TEST_SEA_LEVEL = -6;

/** World position from a zone-local offset (x, y, z). */
export function zonePoint(
  zone: FeatureTestZoneId,
  offset: readonly [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const { center } = FEATURE_TEST_ZONES[zone];
  return [center[0] + offset[0], offset[1], center[1] + offset[2]];
}
