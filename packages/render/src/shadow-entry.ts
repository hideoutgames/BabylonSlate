import {
  CascadedShadowGenerator,
  DirectionalLight,
  type PointLight,
  type SpotLight,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { ShadowSettings } from "@haptic/core";

export type ShadowLight = DirectionalLight | PointLight | SpotLight;
export type EffectiveShadowBias = {
  layer: number;
  cameraId: string | null;
  renderId: number;
  depthBias: number;
  normalBias: number;
  worldTexelSize: number;
  depthScale: number;
  mode: "directional-auto" | "manual" | "local-authored";
};
export type ShadowLightStatus =
  | "active"
  | "disabled"
  | "not-requested"
  | "non-illuminating"
  | "shadows-disabled"
  | "outside-relevant-area"
  | "budget-limited"
  | "allocation-failed";
/** The shadow controller's record of one registered light: its request, admission and map. */
export type ShadowEntry = {
  light: ShadowLight;
  requested: boolean;
  priority: number;
  generator: ShadowGenerator | null;
  key: AllocationKey | null;
  settings: ShadowSettings | null;
  mapSize: number;
  reason: string | null;
  failedKey: string;
  recovery: { requestKey: string; mapSize: number; error: string } | null;
  resetAllocation: boolean;
  status: ShadowLightStatus;
  /** Keeps a camera-rejected local map attached, neutral and unrendered for reuse. */
  standby: boolean;
  admittedAt: number;
  distanceSquared: number;
  effectiveBias: EffectiveShadowBias[];
};

/** An admitted map's allocation shape; a change replaces the generator. */
export type AllocationKey = {
  readonly mapSize: number;
  readonly cube: boolean;
  readonly cascades: number;
};

export function allocationKey(
  mapSize: number,
  light: ShadowLight,
  cascades: number,
): AllocationKey {
  return {
    mapSize,
    cube: light.needCube(),
    cascades: light instanceof DirectionalLight ? cascades : 1,
  };
}

/** JSON equality of two numbers: every non-finite value serializes as null. */
function sameJsonNumber(a: number, b: number): boolean {
  return a === b || (!Number.isFinite(a) && !Number.isFinite(b));
}

/** Whether `key` equals the allocation shape of these inputs, without building one. */
export function matchesAllocationKey(
  key: AllocationKey | null,
  mapSize: number,
  light: ShadowLight,
  cascades: number,
): boolean {
  return (
    key !== null &&
    sameJsonNumber(key.mapSize, mapSize) &&
    key.cube === light.needCube() &&
    sameJsonNumber(key.cascades, light instanceof DirectionalLight ? cascades : 1)
  );
}

/** Faces admission charges a light under the effective settings. */
export function admissionPasses(light: ShadowLight, settings: ShadowSettings): number {
  return light instanceof DirectionalLight
    ? settings.cascades
    : light.needCube()
      ? 6
      : 1;
}

/** Material samplers admission charges a light under the effective settings. */
export function admissionSamplers(light: ShadowLight, settings: ShadowSettings): number {
  return settings.filter === "pcss" && !light.needCube() ? 2 : 1;
}

/** Faces a live generator renders: its cascades, a cube's six, otherwise one. */
export function generatorPasses(generator: ShadowGenerator): number {
  return generator instanceof CascadedShadowGenerator
    ? generator.numCascades
    : generator.getLight().needCube()
      ? 6
      : 1;
}

/** The allocation a light requests under the effective settings, which a failure and its recovery are keyed to. */
export function allocationRequestKey(light: ShadowLight, settings: ShadowSettings): string {
  return JSON.stringify([
    light instanceof DirectionalLight
      ? settings.mapSize
      : settings.localMapSize,
    light.needCube(),
    light instanceof DirectionalLight ? settings.cascades : 1,
    settings.profile,
  ]);
}
