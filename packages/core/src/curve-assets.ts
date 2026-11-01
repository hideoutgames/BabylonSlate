import { normalizeCurve, type Curve, type CurveKind, type CurveValueOf } from "./curves";

/** Curve asset header types, by the value kind their keys hold. */
export const CURVE_ASSET_TYPES = {
  float: "FloatCurve",
  vec3: "VectorCurve",
  color: "ColorCurve",
} as const satisfies Record<CurveKind, string>;

export type CurveAssetType = (typeof CURVE_ASSET_TYPES)[CurveKind];

/** Engine classes of the read-only objects scripts get for curve assets (`Get <Type> Curve Object`). */
export const CURVE_OBJECT_CLASS_IDS = {
  float: "FloatCurveObject",
  vec3: "VectorCurveObject",
  color: "ColorCurveObject",
} as const satisfies Record<CurveKind, string>;

/** A Float, Vector or Color Curve asset's payload: the curve value, as the curve Structures store it, and a note. */
export interface CurveAssetPayload<V = unknown> {
  curve: Curve<V>;
  description: string;
}

/** A packaged curve asset as Play and exported games carry it to the runtime. */
export interface CurveAssetCatalogEntry {
  guid: string;
  type: CurveAssetType;
  name: string;
  payload: CurveAssetPayload;
}

export function curveKindForAssetType(type: string | null | undefined): CurveKind | undefined {
  for (const [kind, assetType] of Object.entries(CURVE_ASSET_TYPES)) if (assetType === type) return kind as CurveKind;
  return undefined;
}

export function isCurveAssetType(type: string | null | undefined): type is CurveAssetType {
  return curveKindForAssetType(type) !== undefined;
}

/** A payload with sorted keys, known names and a string description; anything missing reads as empty. */
export function normalizeCurveAssetPayload<K extends CurveKind>(kind: K, content: unknown): CurveAssetPayload<CurveValueOf<K>> {
  const source = content && typeof content === "object" ? content as Record<string, unknown> : {};
  return {
    curve: normalizeCurve(kind, source.curve),
    description: typeof source.description === "string" ? source.description : "",
  };
}

function key<V>(Time: number, Value: V, zero: V) {
  return { Time, Value, Interpolation: "auto" as const, ArriveTangent: zero, LeaveTangent: zero };
}

/** New assets start as a rising line from 0 to 1 over one second (Color: transparent black to opaque white). */
export function createDefaultCurveAssetPayload(kind: CurveKind): CurveAssetPayload {
  const curve = (keys: unknown[]) => ({ Keys: keys, Before: "constant", After: "constant" });
  if (kind === "float") return normalizeCurveAssetPayload(kind, { curve: curve([key(0, 0, 0), key(1, 1, 0)]) });
  if (kind === "vec3") {
    const zero = { x: 0, y: 0, z: 0 };
    return normalizeCurveAssetPayload(kind, { curve: curve([key(0, zero, zero), key(1, { x: 1, y: 1, z: 1 }, zero)]) });
  }
  const zero = { x: 0, y: 0, z: 0, w: 0 };
  return normalizeCurveAssetPayload(kind, { curve: curve([key(0, zero, zero), key(1, { x: 1, y: 1, z: 1, w: 1 }, zero)]) });
}
