import type { RetargetAnimationLoad } from "./animation-payload";
import { gltfAnimationClips, splitGlbJsonBin } from "./importers/glb-parse";

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
): T[] {
  const sources = new Map(
    [...retargetLoads.values()]
      .flat()
      .map((load) => [load.animationGuid, load.sourceModelGuid]),
  );
  const durations = new Map<string, Map<string, number | undefined>>();
  return catalog.map((entry) => {
    if (entry.type !== "Animation" || !entry.clipName) return entry;
    const modelGuid = sources.get(entry.guid) ?? entry.modelGuid;
    if (!modelGuid) return entry;
    let clips = durations.get(modelGuid);
    if (!clips) {
      const bytes = models.get(modelGuid);
      let json: Record<string, unknown> | undefined;
      if (bytes) {
        try {
          json =
            splitGlbJsonBin(bytes)?.json ??
            JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          /* Unavailable or unsupported source: retain persisted metadata. */
        }
      }
      clips = new Map(
        json
          ? gltfAnimationClips(json).map((clip) => [clip.name, clip.durationMs])
          : [],
      );
      durations.set(modelGuid, clips);
    }
    const durationMs = clips.get(entry.clipName);
    return durationMs === undefined ? entry : { ...entry, durationMs };
  });
}
