import { IMAGE_EXTENSIONS } from "./image";
import {
  collectGltfExternalUris,
  ingestGltfForImport,
  sidecarBytesForUri,
} from "./glb-parse";
import type { ImportFileBytes } from "./obj-import-batch";
import { fileNameOf } from "./file-name";
import { extensionOf } from "./util";

export type { ImportFileBytes } from "./obj-import-batch";

const GLTF_EXTENSIONS = new Set(["glb", "gltf"]);
const GLTF_SIDECAR_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "bin"]);

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

/** `uri` resolved against the model's folder in the batch (`Chair/textures/wood.png`), or null when it climbs out. */
function batchPathForUri(modelName: string, uri: string): string | null {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // Not percent-encoded.
  }
  const parts = modelName.replace(/\\/g, "/").split("/").slice(0, -1);
  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join("/").toLowerCase();
}

/**
 * The batch file `uri` names: the one at its path from the model's folder,
 * as a ZIP or folder import keeps it, else one with its file name (a flat
 * pick holds a texture without the folder its URI names).
 */
function sidecarForUri(
  model: ImportFileBytes,
  uri: string,
  candidates: readonly ImportFileBytes[],
): ImportFileBytes | undefined {
  const path = batchPathForUri(model.name, uri);
  return candidates.find((file) => path !== null && file.name.replace(/\\/g, "/").toLowerCase() === path) ??
    candidates.find((file) => sidecarMatchesUri(file, uri));
}

/** Split a picker batch into glTF/GLB + image/BIN sidecars vs files to import as-is. */
export function groupGltfImportSidecars(files: ImportFileBytes[]): {
  models: Array<{ model: ImportFileBytes; sidecars: ImportFileBytes[] }>;
  rest: ImportFileBytes[];
} {
  const models: Array<{ model: ImportFileBytes; sidecars: ImportFileBytes[] }> =
    [];
  const usedSidecars = new Set<ImportFileBytes>();
  const candidates = files.filter((file) => GLTF_SIDECAR_EXTENSIONS.has(extensionOf(file.name)));

  for (const file of files) {
    if (!GLTF_EXTENSIONS.has(extensionOf(file.name))) continue;
    const sidecars: ImportFileBytes[] = [];
    for (const uri of collectGltfExternalUris(file.name, file.bytes)) {
      const entry = sidecarForUri(file, uri, candidates);
      if (!entry || sidecars.includes(entry)) continue;
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

const MAX_LISTED_TEXTURES = 5;

function missingTexturesWarning(
  modelName: string,
  uris: readonly string[],
): string {
  const listed = uris.slice(0, MAX_LISTED_TEXTURES).join(", ");
  const more =
    uris.length > MAX_LISTED_TEXTURES
      ? ` and ${uris.length - MAX_LISTED_TEXTURES} more`
      : "";
  return `${modelName}: Imported without ${uris.length} texture file${uris.length === 1 ? "" : "s"} it references (${listed}${more}). Select the model and its textures together to include them.`;
}

/**
 * Embed matching sidecars into each GLB/glTF; embedded images are not
 * re-imported. A model that cannot be embedded (its BIN is missing) is kept
 * as picked, and its sidecars no other model embedded import on their own.
 * `warnings` names the texture files a model references that were not picked:
 * the model still imports, untextured.
 */
export function embedGltfImportBatch(files: ImportFileBytes[]): {
  files: ImportFileBytes[];
  warnings: string[];
} {
  const { models, rest } = groupGltfImportSidecars(files);
  const prepared: ImportFileBytes[] = [];
  const warnings: string[] = [];
  const unusedSidecars = files.filter(
    (file) =>
      isGltfSidecar(file) &&
      !models.some((entry) => entry.model === file) &&
      !models.some((entry) => entry.sidecars.includes(file)),
  );
  const consumedExtras = new Set<ImportFileBytes>();
  const embedded = new Set<ImportFileBytes>();
  const released = new Set<ImportFileBytes>();
  for (const { model, sidecars } of models) {
    const extras = unusedSidecars.filter((file) => !sidecars.includes(file));
    const map = sidecarLookupMap([...extras, ...sidecars]);
    // Each URI's own file first: the lookup tries the exact URI before any file name.
    const resolved = new Set<ImportFileBytes>();
    for (const uri of collectGltfExternalUris(model.name, model.bytes)) {
      const file = sidecarForUri(model, uri, [...sidecars, ...extras]);
      if (!file) continue;
      map.set(uri, file.bytes);
      resolved.add(file);
    }
    try {
      const ingested = ingestGltfForImport(model.name, model.bytes, map);
      const name = model.name.replace(/\.gltf$/i, ".glb");
      prepared.push({ name, bytes: ingested.bytes });
      if (ingested.missingImageUris.length > 0) {
        warnings.push(
          missingTexturesWarning(model.name, ingested.missingImageUris),
        );
      }
      for (const sidecar of sidecars) embedded.add(sidecar);
      for (const extra of extras) {
        if (resolved.has(extra)) consumedExtras.add(extra);
      }
    } catch {
      prepared.push(model);
      for (const sidecar of sidecars) released.add(sidecar);
    }
  }
  return {
    files: [
      ...prepared,
      ...rest.filter((file) => !consumedExtras.has(file)),
      ...files.filter((file) => released.has(file) && !embedded.has(file)),
    ],
    warnings,
  };
}
