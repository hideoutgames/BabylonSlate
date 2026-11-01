import {
  animationAssetGuids,
  newAssetGuid,
  nextCopyName,
  normalizeAnimationPayload,
  type AnimationPayload,
  type ImportResult,
} from "@haptic/assets";

export function retargetedAnimationPayload(options: {
  source: AnimationPayload;
  sourceGuid: string;
  targetSkeletonGuid: string;
  targetModelGuid: string;
}): AnimationPayload {
  return normalizeAnimationPayload({
    clipName: options.source.clipName,
    modelGuid: options.targetModelGuid,
    skeletonGuid: options.targetSkeletonGuid,
    durationMs: options.source.durationMs,
    clipDurationMs: options.source.clipDurationMs,
    sourceAnimationGuid: options.sourceGuid,
  });
}

export function retargetedAnimationName(
  sourceName: string,
  targetSkeletonName: string,
  existingNames: readonly string[],
): string {
  return nextCopyName(
    `${sourceName}_${targetSkeletonName}`,
    [...existingNames],
  );
}

export function retargetedAnimationImport(options: {
  name: string;
  guid: string;
  payload: AnimationPayload;
}): ImportResult {
  return {
    type: "Animation",
    name: options.name,
    guid: options.guid,
    version: 1,
    dependencies: animationAssetGuids(options.payload),
    parentClass: null,
    payload: { ...options.payload },
    chunks: [],
  };
}

function joinRelative(folder: string, fileName: string): string {
  const trimmed = folder.replace(/\/+$/, "");
  return trimmed ? `${trimmed}/${fileName}` : fileName;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

export async function writeRetargetedAnimations(options: {
  sources: ReadonlyArray<{
    guid: string;
    name: string;
    payload: AnimationPayload;
  }>;
  targetSkeletonGuid: string;
  targetSkeletonName: string;
  targetModelGuid: string;
  existingNames: string[];
  folderRelative: string;
  rootId: string;
  readModelBytes: (modelGuid: string) => Promise<Uint8Array | null>;
  /** Clip names among `clipNames` that keep at least one channel on the target. */
  probeMatches: (
    sourceBytes: Uint8Array,
    targetBytes: Uint8Array,
    clipNames: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  createAsset: (
    rootId: string,
    relativePath: string,
    result: ImportResult,
  ) => Promise<unknown>;
}): Promise<{ created: number; skipped: string[] }> {
  const skipped: string[] = [];
  const names = [...options.existingNames];
  // Distinct names can sanitize to one file name (`Walk!` and `Walk?`), and
  // asset paths compare without case, so each new file stem is reserved too.
  const fileStem = (name: string) => sanitizeFileName(name).toLowerCase();
  const usedStems = new Set(names.map(fileStem));
  let created = 0;
  const targetBytes = await options.readModelBytes(options.targetModelGuid);
  // A probe loads both GLBs, so each source Model is read and probed once for
  // all of its clips; a source Model that is the target reuses its bytes.
  const clipsByModel = new Map<string, Set<string>>();
  for (const { payload } of options.sources) {
    if (!payload.clipName) continue;
    const clips = clipsByModel.get(payload.modelGuid) ?? new Set<string>();
    clips.add(payload.clipName);
    clipsByModel.set(payload.modelGuid, clips);
  }
  const matchesByModel = new Map<string, ReadonlySet<string>>();
  if (targetBytes) {
    for (const [modelGuid, clips] of clipsByModel) {
      const sourceBytes =
        modelGuid === options.targetModelGuid
          ? targetBytes
          : await options.readModelBytes(modelGuid);
      if (!sourceBytes) continue;
      matchesByModel.set(
        modelGuid,
        await options.probeMatches(sourceBytes, targetBytes, [...clips]),
      );
    }
  }
  for (const source of options.sources) {
    const { clipName, modelGuid } = source.payload;
    if (!clipName || !matchesByModel.get(modelGuid)?.has(clipName)) {
      skipped.push(source.name);
      continue;
    }
    let name = retargetedAnimationName(
      source.name,
      options.targetSkeletonName,
      names,
    );
    while (usedStems.has(fileStem(name))) {
      names.push(name);
      name = retargetedAnimationName(source.name, options.targetSkeletonName, names);
    }
    names.push(name);
    usedStems.add(fileStem(name));
    const payload = retargetedAnimationPayload({
      source: source.payload,
      sourceGuid: source.guid,
      targetSkeletonGuid: options.targetSkeletonGuid,
      targetModelGuid: options.targetModelGuid,
    });
    await options.createAsset(
      options.rootId,
      joinRelative(options.folderRelative, `${sanitizeFileName(name)}.hasset`),
      retargetedAnimationImport({
        name,
        guid: newAssetGuid(),
        payload,
      }),
    );
    created += 1;
  }
  return { created, skipped };
}
