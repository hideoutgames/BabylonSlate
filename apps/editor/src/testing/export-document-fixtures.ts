import {
  loadExportDocuments,
  type ExportDocumentLoaders,
  type LoadedExportDocuments,
} from "../services/export-game-inputs";

/**
 * `loadExportDocuments` over fixture loaders. Fixture sources cannot change
 * between reads, so a document with its chunks is its separate reads, and
 * chunks are selected from the listed header. Tests of the one-version read
 * use `ProjectService.loadDocumentWithChunks` instead.
 */
export function loadFixtureExportDocuments(
  loaders: Omit<ExportDocumentLoaders, "loadDocumentWithChunks">,
): Promise<LoadedExportDocuments> {
  return loadExportDocuments({
    ...loaders,
    loadDocumentWithChunks: async (kind, path, selection) => {
      const asset = loaders.assets.find((entry) => entry.path === path);
      if (!asset) throw new Error(`Fixture asset is missing: ${path}`);
      // A Texture keeps its settings on the header, as imported Textures do.
      const document = kind === "texture" ? asset.header.payload : await loaders.loadDocument(kind, path);
      const chunks = new Map<string, Uint8Array>();
      const chunkIds = typeof selection === "function" ? selection(asset.header) : selection;
      for (const chunkId of chunkIds) {
        const bytes = await loaders.readAssetChunk(path, chunkId);
        if (bytes) chunks.set(chunkId, bytes);
      }
      return { document, header: asset.header, chunks };
    },
  });
}
