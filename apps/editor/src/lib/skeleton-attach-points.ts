import { normalizeModelPayload, normalizeSkeletonPayload } from "@haptic/assets";

/** One Skeleton's bones and sockets: what an attachment to a Model on it can name. */
export interface SkeletonAttachPoints {
  skeletonGuid: string;
  skeletonName: string;
  bones: string[];
  sockets: string[];
}

interface SkeletonAssetLike {
  header: { guid: string; name: string; type: string; payload?: unknown };
}

/** Every Skeleton's attach points, by Skeleton name. */
export function skeletonAttachPoints(assets: readonly SkeletonAssetLike[]): SkeletonAttachPoints[] {
  return assets
    .filter((asset) => asset.header.type === "Skeleton")
    .map((asset) => {
      const skeleton = normalizeSkeletonPayload(asset.header.payload ?? {});
      return {
        skeletonGuid: asset.header.guid,
        skeletonName: asset.header.name,
        bones: skeleton.bones.map((bone) => bone.name),
        sockets: skeleton.sockets.map((socket) => socket.name),
      };
    })
    .filter((entry) => entry.bones.length > 0 || entry.sockets.length > 0)
    .sort((a, b) => a.skeletonName.localeCompare(b.skeletonName));
}

interface ComponentLike {
  classId: string;
  properties: Record<string, unknown>;
}

/**
 * The bones of the Skeleton an actor's Model is on: the first Mesh component's Model with one. Empty when the actor
 * has no such Model.
 */
export function actorSkeletonBoneNames(
  components: readonly ComponentLike[],
  getByGuid: (guid: string) => SkeletonAssetLike | undefined,
): string[] {
  for (const component of components) {
    if (component.classId !== "MeshComponent") continue;
    const guid = typeof component.properties.assetGuid === "string" ? component.properties.assetGuid : "";
    const model = guid ? getByGuid(guid) : undefined;
    if (model?.header.type !== "Model") continue;
    const skeletonGuid = normalizeModelPayload(model.header.payload ?? {}).skeletonGuid;
    const skeleton = skeletonGuid ? getByGuid(skeletonGuid) : undefined;
    if (skeleton?.header.type === "Skeleton") return normalizeSkeletonPayload(skeleton.header.payload ?? {}).bones.map((bone) => bone.name);
  }
  return [];
}
