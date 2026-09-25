import type { ParticleBillboardMode, ParticleBlendMode } from "@babylonslate/core";
import type {
  ParticleEmitterPayload,
  ParticleScalarValue,
  ParticleShapeKind,
  ParticleValueUnit,
} from "@babylonslate/assets";

/**
 * Basic Particle Emitter Details helpers: undo merge keys, display units and the
 * collapsed module summaries. Mode conversion lives in `@babylonslate/assets`
 * (`convertScalarValueMode` / `convertColorValueMode`).
 */

/** One undo entry per gesture on a field: `path` is the payload path (`initialize.lifetime`). */
export function particleFieldMergeKey(path: string): string {
  return `particle-field:${path}`;
}

const RAD_TO_DEG = 180 / Math.PI;

/** Unit shown verbatim after the label, and the factor from stored to shown values. */
export type ParticleValueDisplay = { unit?: string; scale: number };

/** Angles are stored in radians and shown in degrees; distances show no unit. */
export function particleValueDisplay(unit: ParticleValueUnit): ParticleValueDisplay {
  switch (unit) {
    case "particlesPerSecond":
      return { unit: "/s", scale: 1 };
    case "seconds":
      return { unit: "s", scale: 1 };
    case "metersPerSecond":
      return { unit: "m/s", scale: 1 };
    case "radians":
      return { unit: "deg", scale: RAD_TO_DEG };
    case "radiansPerSecond":
      return { unit: "deg/s", scale: RAD_TO_DEG };
    case "meters":
    case "multiplier":
    case "fraction":
      return { scale: 1 };
  }
}

export const PARTICLE_BLEND_MODE_LABELS: Record<ParticleBlendMode, string> = {
  additive: "Additive",
  standard: "Alpha Blend",
  add: "Alpha Additive",
  multiply: "Multiply",
  subtract: "Subtract",
};

export const PARTICLE_BILLBOARD_LABELS: Record<ParticleBillboardMode, string> = {
  all: "Camera Facing",
  y: "Y Axis",
  stretched: "Stretched",
};

export const PARTICLE_SHAPE_LABELS: Record<ParticleShapeKind, string> = {
  point: "Point",
  box: "Box",
  sphere: "Sphere",
  hemisphere: "Hemisphere",
  cylinder: "Cylinder",
  cone: "Cone",
};

/** Up to two decimals without float noise (`0.30000000000000004` → `0.3`). */
export function formatParticleNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function withUnit(text: string, unit: string | undefined): string {
  return unit ? `${text} ${unit}` : text;
}

/** `20 /s`, `0.8–1.2 s`, or `Curve`, in display units. */
export function particleScalarSummary(
  value: ParticleScalarValue,
  display: ParticleValueDisplay = { scale: 1 },
): string {
  if (value.mode === "curve") return "Curve";
  if (value.mode === "constant") {
    return withUnit(formatParticleNumber(value.value * display.scale), display.unit);
  }
  const min = formatParticleNumber(value.min * display.scale);
  const max = formatParticleNumber(value.max * display.scale);
  return withUnit(min === max ? min : `${min}–${max}`, display.unit);
}

export type ParticleModuleId =
  | "emitter"
  | "spawnRate"
  | "bursts"
  | "shape"
  | "initialize"
  | "scale"
  | "rotation"
  | "speedOverLife"
  | "speedLimit"
  | "drag"
  | "gravity"
  | "render";

export type ParticleModuleSummary = { text: string; tone: "muted" | "destructive" };

/**
 * Text a collapsed module card shows. `materialName` is the picked Material's
 * asset name, or null when the guid is unset or does not resolve.
 */
export function particleModuleSummary(
  id: ParticleModuleId,
  payload: ParticleEmitterPayload,
  materialName: string | null,
): ParticleModuleSummary {
  const muted = (text: string): ParticleModuleSummary => ({ text, tone: "muted" });
  const { spawn, initialize, overLife, forces, render } = payload;
  switch (id) {
    case "emitter":
      if (materialName) return muted(materialName);
      return {
        text: render.materialGuid ? "Missing Material" : "No Material",
        tone: "destructive",
      };
    case "spawnRate":
      return muted(particleScalarSummary(spawn.rate, { unit: "/s", scale: 1 }));
    case "bursts": {
      const count = spawn.bursts.entries.length;
      if (count === 0) return muted("No Bursts");
      return muted(`${count} ${count === 1 ? "Burst" : "Bursts"}`);
    }
    case "shape":
      return muted(PARTICLE_SHAPE_LABELS[payload.shape.kind]);
    case "initialize":
      return muted(
        `Lifetime ${particleScalarSummary(initialize.lifetime, particleValueDisplay("seconds"))}`,
      );
    case "scale":
      return muted(
        `X ${particleScalarSummary(initialize.scale.x)} · Y ${particleScalarSummary(initialize.scale.y)}`,
      );
    case "rotation":
      return muted(
        `Start ${particleScalarSummary(initialize.rotation.start, particleValueDisplay("radians"))}`,
      );
    case "speedOverLife": {
      const multiplier = overLife.velocity.multiplier;
      return muted(
        multiplier.mode === "curve" ? "Curve" : `×${particleScalarSummary(multiplier)}`,
      );
    }
    case "speedLimit":
      return muted(
        particleScalarSummary(
          overLife.speedLimit.limit,
          particleValueDisplay("metersPerSecond"),
        ),
      );
    case "drag":
      return muted(particleScalarSummary(overLife.drag.amount));
    case "gravity":
      return muted(
        `${forces.gravity.acceleration.map(formatParticleNumber).join(", ")} m/s²`,
      );
    case "render":
      return muted(
        `${PARTICLE_BLEND_MODE_LABELS[render.blendMode]} · ${PARTICLE_BILLBOARD_LABELS[render.billboard]}`,
      );
  }
}
