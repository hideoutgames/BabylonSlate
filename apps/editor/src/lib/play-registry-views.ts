import type { IndexedAsset } from "@haptic/assets";
import { animClipCatalogFromAssets } from "./anim-clip-catalog";
import { classIdFromClassAsset } from "./class-asset-lookup";

/**
 * What a running game reads from the asset registry: the Scenes it may load, each Class's asset by
 * class id (spawning by class), the console command Classes, the Audio it may play and the
 * animation clips. Editor Play and the Feature Test gate build their sessions from the same lists.
 */
export function playRegistryViews(assets: readonly IndexedAsset[]) {
  return {
    sceneCatalog: assets
      .filter((asset) => asset.header.type === "Scene")
      .map((asset) => ({ guid: asset.header.guid, name: asset.header.name })),
    classAssetGuids: Object.fromEntries(
      assets
        .filter((asset) => asset.header.type === "Class")
        .map((asset) => [classIdFromClassAsset(asset), asset.header.guid]),
    ),
    consoleCommands: assets.flatMap((asset) =>
      asset.header.consoleCommand
        ? [{
            ...asset.header.consoleCommand,
            classId: classIdFromClassAsset(asset),
            assetGuid: asset.header.guid,
            name: asset.header.consoleCommand.name || classIdFromClassAsset(asset).toLowerCase(),
          }]
        : [],
    ),
    audioAssetGuids: assets
      .filter((asset) => asset.header.type === "Audio")
      .map((asset) => asset.header.guid),
    animClipCatalog: animClipCatalogFromAssets(assets),
  };
}
