/** Authored participation is independent of realtime shadow/quality admission. */
export type LightMobility = "static" | "stationary" | "dynamic";
export type MeshBakeParticipation =
  "none" | "staticReceiver" | "staticOccluder";

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
