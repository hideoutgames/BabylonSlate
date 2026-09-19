/** Authored participation is independent of realtime shadow/quality admission. */
export type LightMobility = "static" | "stationary" | "dynamic";
export type MeshBakeParticipation =
  "none" | "staticReceiver" | "staticOccluder";

export interface BakeAuthoringSettings {
  resolution: number;
  paddingTexels: number;
  samples: number;
  bounces: number;
}

/** Persisted authoring controls, independent of runtime scalability. */
export function normalizeBakeAuthoringSettings(
  value?: unknown,
): BakeAuthoringSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : fallback;
  };
  return {
    resolution: integer("resolution", 32, 32, 128),
    paddingTexels: integer("paddingTexels", 2, 1, 4),
    samples: integer("samples", 16, 1, 4096),
    bounces: integer("bounces", 3, 2, 8),
  };
}

export function lightMobility(
  properties: Readonly<Record<string, unknown>>,
): LightMobility {
  const value = properties.mobility ?? "dynamic";
  if (value === "static" || value === "stationary" || value === "dynamic")
    return value;
  throw new Error("Light Mobility must be Static, Stationary or Dynamic.");
}

export function meshBakeParticipation(
  properties: Readonly<Record<string, unknown>>,
): MeshBakeParticipation {
  const value = properties.bakeParticipation ?? "none";
  if (
    value === "none" ||
    value === "staticReceiver" ||
    value === "staticOccluder"
  )
    return value;
  throw new Error(
    "Bake Participation must be None, Static Receiver or Static Occluder.",
  );
}
