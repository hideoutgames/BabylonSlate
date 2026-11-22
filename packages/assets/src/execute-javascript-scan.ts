import { findExecuteJavaScriptNodes, type ExecuteJavaScriptAsset } from "@haptic/core";
import { DOCUMENT_CHUNK_ID } from "./document-chunk";
import { decodeHassetChunk, readHassetHeader } from "./hasset";
import { HASSET_MAX_NESTING_DEPTH } from "./import-limits";
import { importHasset } from "./importers/hasset";
import { importerForExtension } from "./importers/index";
import type { ImportResult } from "./importers/types";
import { extensionOf } from "./importers/util";
import type { InspectedHplugin } from "./plugin-package";

const textDecoder = new TextDecoder();

/** The asset's Execute JavaScript nodes: its document (the `document` chunk, else the header payload) and header payload. */
function assetFinding(
  identity: { guid: string; name: string; type: string; path?: string },
  documents: readonly unknown[],
): ExecuteJavaScriptAsset | null {
  const nodes = documents.flatMap((document) => findExecuteJavaScriptNodes(document));
  return nodes.length > 0 ? { ...identity, nodes } : null;
}

/** A `document` chunk's JSON; null when it does not parse, as no reader could load it either. */
function parsedDocumentChunk(data: Uint8Array | null | undefined): unknown {
  if (!data) return null;
  try {
    return JSON.parse(textDecoder.decode(data));
  } catch {
    return null;
  }
}

/** The import results (one per asset, nested ones included) that hold Execute JavaScript with a body. */
export function executeJavaScriptInImportResults(results: readonly ImportResult[], path?: string): ExecuteJavaScriptAsset[] {
  return results.flatMap((result) => {
    const document = parsedDocumentChunk(result.chunks.find((chunk) => chunk.id === DOCUMENT_CHUNK_ID)?.data);
    const finding = assetFinding({ guid: result.guid, name: result.name, type: result.type, ...(path ? { path } : {}) }, [document, result.payload]);
    return finding ? [finding] : [];
  });
}

/**
 * What a file would import with Execute JavaScript, before anything is written. Only `.hasset` files
 * (read by `importHasset`, which keeps whatever asset types they hold) can carry graphs; every other
 * importer makes Textures, Models, Materials, Animations, Skeletons, Audio or Fonts, which hold none.
 * `AssetRegistry.importFile` checks its results again and refuses Execute JavaScript it was not
 * told was confirmed, so a file this misjudges fails its import instead of slipping through.
 */
export async function executeJavaScriptInImportFile(fileName: string, bytes: Uint8Array, path = fileName): Promise<ExecuteJavaScriptAsset[]> {
  if (importerForExtension(extensionOf(fileName)) !== importHasset) return [];
  const results = await importHasset(bytes, { fileName, existingGuids: new Set() });
  return executeJavaScriptInImportResults(results, path);
}

/** Refuses an import that carries Execute JavaScript its caller did not confirm with the user. */
export class UnconfirmedExecuteJavaScriptError extends Error {
  readonly assets: ExecuteJavaScriptAsset[];
  constructor(assets: ExecuteJavaScriptAsset[]) {
    super(`It contains Execute JavaScript (${assets.map((asset) => asset.name).join(", ")}), which was not confirmed for import.`);
    this.name = "UnconfirmedExecuteJavaScriptError";
    this.assets = assets;
  }
}

/** A `.blobs/<sha256>` file of the archive by its digest, wherever its root is. */
function archiveBlobs(files: InspectedHplugin["files"]): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>();
  for (const file of files) {
    const match = /(?:^|\/)\.blobs\/([0-9a-f]{64})$/.exec(file.path);
    if (match) blobs.set(match[1]!, file.data);
  }
  return blobs;
}

async function pluginAssetFindings(
  bytes: Uint8Array,
  path: string,
  readBlob: (sha256: string) => Promise<Uint8Array>,
  depth: number,
  out: ExecuteJavaScriptAsset[],
): Promise<void> {
  const header = readHassetHeader(bytes);
  // Each file reads as the editor would read it: its document chunk, inline or from the plugin's blobs.
  const document = header.chunks.some((chunk) => chunk.id === DOCUMENT_CHUNK_ID)
    ? parsedDocumentChunk(await decodeHassetChunk(bytes, DOCUMENT_CHUNK_ID, readBlob))
    : null;
  const finding = assetFinding({ guid: header.guid, name: header.name, type: header.type, path }, [document, header.payload]);
  if (finding) out.push(finding);
  if (depth >= HASSET_MAX_NESTING_DEPTH) return;
  for (const entry of header.chunks) {
    if (entry.kind !== "asset" || !entry.id.startsWith("nested:")) continue;
    const nested = await decodeHassetChunk(bytes, entry.id, readBlob);
    if (nested) await pluginAssetFindings(nested, path, readBlob, depth + 1, out);
  }
}

/**
 * The `.hasset` files of an inspected `.hplugin` that hold Execute JavaScript with a body. A file
 * whose document cannot be read (a blob missing from the archive) fails the scan, so a plugin whose
 * code cannot be checked is not installed.
 */
export async function executeJavaScriptInPlugin(incoming: InspectedHplugin): Promise<ExecuteJavaScriptAsset[]> {
  const blobs = archiveBlobs(incoming.files);
  const readBlob = async (sha256: string) => {
    const blob = blobs.get(sha256);
    if (!blob) throw new Error(`blob ${sha256} is not in the plugin`);
    return blob;
  };
  const found: ExecuteJavaScriptAsset[] = [];
  for (const file of incoming.files) {
    if (!file.path.toLowerCase().endsWith(".hasset")) continue;
    try {
      await pluginAssetFindings(file.data, file.path, readBlob, 0, found);
    } catch (error) {
      throw new Error(`${file.path} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return found;
}
