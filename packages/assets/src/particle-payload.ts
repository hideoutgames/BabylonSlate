/**
 * Particle System payload plus the reference helpers shared by both particle asset
 * types. Budgets and mode ids live in `@babylonslate/core` (`particle-settings.ts`) so
 * the Babylon-free Particle Graph IR can share them; the Basic emitter schema is in
 * `particle-basic-emitter.ts`.
 */
import {
  PARTICLE_SYSTEM_MAX_EMITTERS,
  type ParticleSpace,
} from "@babylonslate/core";
import { normalizeParticleEmitterPayload } from "./particle-basic-emitter";

export {
  PARTICLE_CAPACITY_DEFAULT,
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  PARTICLE_SYSTEM_MAX_EMITTERS,
} from "@babylonslate/core";
export type { ParticleBlendMode, ParticleSpace } from "@babylonslate/core";

export const PARTICLE_ASSET_TYPES = ["ParticleEmitter", "ParticleSystem"] as const;
export type ParticleAssetType = (typeof PARTICLE_ASSET_TYPES)[number];

/** Lifecycle (Loop, Duration, Pre Warm) belongs to each emitter; old `looping`/`duration` keys are ignored. */
export type ParticleSystemPayload = {
  /** Up to 8 ordered slots; duplicates allowed. */
  emitterGuids: string[];
  /** Maps to `isLocal` on every slot. */
  space: ParticleSpace;
  /** Editor System Preview only. Ignored at runtime. Missing → true. */
  previewSkybox: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function createDefaultParticleSystemPayload(): ParticleSystemPayload {
  return {
    emitterGuids: [],
    space: "world",
    previewSkybox: true,
  };
}

export function normalizeParticleSystemPayload(
  value: unknown,
): ParticleSystemPayload {
  const rec = asRecord(value);
  const guids: string[] = [];
  const raw = Array.isArray(rec.emitterGuids) ? rec.emitterGuids : [];
  for (const entry of raw) {
    const guid = nullableGuid(entry);
    if (!guid) continue;
    guids.push(guid);
    if (guids.length >= PARTICLE_SYSTEM_MAX_EMITTERS) break;
  }
  return {
    emitterGuids: guids,
    space: rec.space === "local" ? "local" : "world",
    previewSkybox: rec.previewSkybox === false ? false : true,
  };
}

function collectGuids(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value) unique.add(value);
  }
  return [...unique].sort();
}

/** A Basic emitter depends only on its Material; a System on its emitters. */
export function particleAssetDependencies(
  assetType: string,
  payload: Record<string, unknown>,
): string[] {
  if (assetType === "ParticleEmitter") {
    const emitter = normalizeParticleEmitterPayload(payload);
    return collectGuids([emitter.render.materialGuid]);
  }
  if (assetType === "ParticleSystem") {
    const system = normalizeParticleSystemPayload(payload);
    return collectGuids(system.emitterGuids);
  }
  return [];
}

export function remapParticlePayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (assetType === "ParticleEmitter") {
    const emitter = normalizeParticleEmitterPayload(payload);
    const guid = emitter.render.materialGuid;
    return {
      ...emitter,
      render: {
        ...emitter.render,
        materialGuid: guid ? (remap.get(guid) ?? guid) : null,
      },
    };
  }
  if (assetType === "ParticleSystem") {
    const system = normalizeParticleSystemPayload(payload);
    return {
      ...system,
      emitterGuids: system.emitterGuids.map(
        (guid) => remap.get(guid) ?? guid,
      ),
    };
  }
  return payload;
}
