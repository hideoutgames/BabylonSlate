import { DOCUMENT_CHUNK_ID, type IndexedAsset } from "@babylonslate/assets";

/** Saved content identity; registry reindexing and unrelated document edits stay stable. */
export function savedMaterialLibraryKey(assets: readonly IndexedAsset[]): string {
  return JSON.stringify(
    assets
      .filter(
        ({ header }) =>
          header.type === "Material" || header.type === "MaterialFunction",
      )
      .sort((a, b) => a.header.guid.localeCompare(b.header.guid))
      .map(({ header }) => [
        header.guid,
        header.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID)?.sha256 ??
          header.payload,
      ]),
  );
}
