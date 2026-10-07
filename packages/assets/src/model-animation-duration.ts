import type { RetargetAnimationLoad } from "./animation-payload";
import { gltfAnimationClips, splitGlbJsonBin } from "./importers/glb-parse";

/** Parse source clip metadata once per model revision, before scene hydration. */
export function modelAnimationDurations(bytes: Uint8Array): Map<string, number | undefined> {
  try {
    const json = splitGlbJsonBin(bytes)?.json ?? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return new Map(gltfAnimationClips(json).map((clip) => [clip.name, clip.durationMs]));
  } catch {
    // Unavailable or unsupported source retains authored duration metadata.
    return new Map();
  }
}

/** Repair legacy clip durations from source takes without rewriting project assets. */
export function resolveModelAnimationDurations<
  T extends {
    guid: string;
    type: string;
    modelGuid?: string;
    clipName?: string;
    durationMs?: number;
  },
>(
  catalog: readonly T[],
  models: ReadonlyMap<string, Uint8Array>,
  retargetLoads: ReadonlyMap<
    string,
    readonly RetargetAnimationLoad[]
  > = new Map(),
  preparedDurations: ReadonlyMap<string, ReadonlyMap<string, number | undefined>> = new Map(),
): T[] {
  const sources = new Map(
    [...retargetLoads.values()]
      .flat()
      .map((load) => [load.animationGuid, load.sourceModelGuid]),
  );
  const durations = new Map<string, ReadonlyMap<string, number | undefined>>(preparedDurations);
  return catalog.map((entry) => {
    if (entry.type !== "Animation" || !entry.clipName) return entry;
    const modelGuid = sources.get(entry.guid) ?? entry.modelGuid;
    if (!modelGuid) return entry;
    let clips = durations.get(modelGuid);
    if (!clips) {
      const bytes = models.get(modelGuid);
      clips = bytes ? modelAnimationDurations(bytes) : new Map();
      durations.set(modelGuid, clips);
    }
    const durationMs = clips.get(entry.clipName);
    return durationMs === undefined ? entry : { ...entry, durationMs };
  });
}
