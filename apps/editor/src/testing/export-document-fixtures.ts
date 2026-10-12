import {
  loadExportDocuments,
  type ExportDocumentLoaders,
  type LoadedExportDocuments,
} from "../services/export-game-inputs";

/**
 * `loadExportDocuments` over fixture loaders. Fixture sources cannot change
 * between reads, so a document with its chunks is its separate reads. Tests of
 * the one-version read use `ProjectService.loadDocumentWithChunks` instead.
 */
export function loadFixtureExportDocuments(
  loaders: Omit<ExportDocumentLoaders, "loadDocumentWithChunks">,
): Promise<LoadedExportDocuments> {
  return loadExportDocuments({
    ...loaders,
    loadDocumentWithChunks: async (kind, path, chunkIds) => {
      const document = await loaders.loadDocument(kind, path);
      const chunks = new Map<string, Uint8Array>();
      for (const chunkId of chunkIds) {
        const bytes = await loaders.readAssetChunk(path, chunkId);
        if (bytes) chunks.set(chunkId, bytes);
      }
      return { document, chunks };
    },
  });
}
