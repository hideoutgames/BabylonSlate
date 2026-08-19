import {
  animationAssetGuids,
  newAssetGuid,
  nextCopyName,
  normalizeAnimationPayload,
  type AnimationPayload,
  type ImportResult,
} from "@babylonslate/assets";

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
  probeMatches: (
    sourceBytes: Uint8Array,
    targetBytes: Uint8Array,
    clipName: string,
  ) => Promise<boolean>;
  createAsset: (
    rootId: string,
    relativePath: string,
    result: ImportResult,
  ) => Promise<unknown>;
}): Promise<{ created: number; skipped: string[] }> {
  const skipped: string[] = [];
  const names = [...options.existingNames];
  let created = 0;
  const targetBytes = await options.readModelBytes(options.targetModelGuid);
  for (const source of options.sources) {
    const sourceBytes = await options.readModelBytes(source.payload.modelGuid);
    const clipName = source.payload.clipName;
    const matches =
      targetBytes &&
      sourceBytes &&
      clipName &&
      (await options.probeMatches(sourceBytes, targetBytes, clipName));
    if (!matches) {
      skipped.push(source.name);
      continue;
    }
    const name = retargetedAnimationName(
      source.name,
      options.targetSkeletonName,
      names,
    );
    names.push(name);
    const payload = retargetedAnimationPayload({
      source: source.payload,
      sourceGuid: source.guid,
      targetSkeletonGuid: options.targetSkeletonGuid,
      targetModelGuid: options.targetModelGuid,
    });
    await options.createAsset(
      options.rootId,
      joinRelative(options.folderRelative, `${sanitizeFileName(name)}.babasset`),
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
