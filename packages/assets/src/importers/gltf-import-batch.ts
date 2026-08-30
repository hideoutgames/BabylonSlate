import { IMAGE_EXTENSIONS } from "./image";
import {
  collectGltfExternalUris,
  ingestGltfForImport,
  sidecarBytesForUri,
} from "./glb-parse";
import type { ImportFileBytes } from "./obj-import-batch";
import { extensionOf } from "./util";

export type { ImportFileBytes } from "./obj-import-batch";

const GLTF_EXTENSIONS = new Set(["glb", "gltf"]);
const GLTF_SIDECAR_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "bin"]);

function fileNameOf(fileName: string): string {
  return (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
}

function sidecarLookupMap(
  files: readonly ImportFileBytes[],
): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const file of files) {
    map.set(file.name, file.bytes);
    map.set(fileNameOf(file.name), file.bytes);
    const base = file.name.split(/[\\/]/).pop();
    if (base) map.set(base, file.bytes);
  }
  return map;
}

function sidecarMatchesUri(file: ImportFileBytes, uri: string): boolean {
  const map = new Map<string, Uint8Array>([
    [file.name, file.bytes],
    [fileNameOf(file.name), file.bytes],
  ]);
  const base = file.name.split(/[\\/]/).pop();
  if (base) map.set(base, file.bytes);
  return sidecarBytesForUri(uri, map) != null;
}

/** Split a picker batch into glTF/GLB + image/BIN sidecars vs files to import as-is. */
export function groupGltfImportSidecars(files: ImportFileBytes[]): {
  models: Array<{ model: ImportFileBytes; sidecars: ImportFileBytes[] }>;
  rest: ImportFileBytes[];
} {
  const models: Array<{ model: ImportFileBytes; sidecars: ImportFileBytes[] }> =
    [];
  const usedSidecars = new Set<ImportFileBytes>();

  for (const file of files) {
    if (!GLTF_EXTENSIONS.has(extensionOf(file.name))) continue;
    const uris = collectGltfExternalUris(file.name, file.bytes);
    const sidecars: ImportFileBytes[] = [];
    const seen = new Set<ImportFileBytes>();
    for (const entry of files) {
      if (entry === file) continue;
      if (!GLTF_SIDECAR_EXTENSIONS.has(extensionOf(entry.name))) continue;
      const matches = uris.some((uri) => sidecarMatchesUri(entry, uri));
      if (!matches) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      sidecars.push(entry);
      usedSidecars.add(entry);
    }
    models.push({ model: file, sidecars });
  }

  const rest = files.filter((file) => {
    if (GLTF_EXTENSIONS.has(extensionOf(file.name))) return false;
    return !usedSidecars.has(file);
  });
  return { models, rest };
}

function isGltfSidecar(file: ImportFileBytes): boolean {
  return GLTF_SIDECAR_EXTENSIONS.has(extensionOf(file.name));
}

/** Embed matching sidecars into each GLB/glTF; consumed images are not re-imported. */
export function embedGltfImportBatch(
  files: ImportFileBytes[],
): ImportFileBytes[] {
  const { models, rest } = groupGltfImportSidecars(files);
  const prepared: ImportFileBytes[] = [];
  const unusedSidecars = files.filter(
    (file) =>
      isGltfSidecar(file) &&
      !models.some((entry) => entry.model === file) &&
      !models.some((entry) => entry.sidecars.includes(file)),
  );
  const consumedExtras = new Set<ImportFileBytes>();
  for (const { model, sidecars } of models) {
    const extras = unusedSidecars.filter((file) => !sidecars.includes(file));
    const map = sidecarLookupMap([...sidecars, ...extras]);
    try {
      const ingested = ingestGltfForImport(model.name, model.bytes, map);
      const name = model.name.replace(/\.gltf$/i, ".glb");
      prepared.push({ name, bytes: ingested.bytes });
      const uris = collectGltfExternalUris(model.name, model.bytes);
      for (const extra of extras) {
        if (uris.some((uri) => sidecarMatchesUri(extra, uri))) {
          consumedExtras.add(extra);
        }
      }
    } catch {
      prepared.push(model);
    }
  }
  return [
    ...prepared,
    ...rest.filter((file) => !consumedExtras.has(file)),
  ];
}
