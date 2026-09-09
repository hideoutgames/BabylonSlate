import {
  isInputAssetType,
  normalizeInputAssetPayload,
} from "@babylonslate/core";

/** Open documents win so unsaved dimension changes update graph pins immediately. */
export function inputAssetCatalog(
  assets: readonly {
    path: string;
    header: { guid: string; name: string; type: string; payload?: unknown };
  }[],
  documents: readonly { ref: { path: string }; content?: unknown }[] = [],
) {
  return assets.flatMap((asset) => {
    if (!isInputAssetType(asset.header.type)) return [];
    const content =
      documents.find((doc) => doc.ref.path === asset.path)?.content ??
      asset.header.payload;
    return [
      {
        guid: asset.header.guid,
        name: asset.header.name,
        type: asset.header.type,
        valueType: normalizeInputAssetPayload(asset.header.type, content)
          .valueType,
      },
    ];
  });
}
