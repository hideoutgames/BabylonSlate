export interface ImportResultChunk {
  id: string;
  kind: string;
  mime: string;
  data: Uint8Array;
}

export interface ImportResult {
  /** Texture, Model, Material, Animation, Audio, Font, etc. */
  type: string;
  name: string;
  guid: string;
  version: number;
  dependencies: string[];
  requiredDependencies?: string[];
  requiredVariableNames?: string[];
  classReferences?: string[];
  requiredClassReferences?: string[];
  consoleCommand?: import("@haptic/core").ConsoleCommandMetadata;
  dependencyMetadataVersion?: number;
  parentClass?: string | null;
  payload: Record<string, unknown>;
  chunks: ImportResultChunk[];
  /** If set, attach to existing Font guid instead of creating new asset. */
  attachToGuid?: string;
}

export interface ImportOptions {
  fileName: string;
  /** Existing guids in the project (for collision remap). */
  existingGuids: Set<string>;
  /** For font attach: map of font name to guid. */
  fontGuidsByName?: Map<string, string>;
  /** Force attach onto this Font even when the family name differs. */
  attachToGuid?: string;
  /** Uniform Model import multiplier. Defaults to DEFAULT_MODEL_IMPORT_SCALE. */
  modelImportScale?: number;
  /**
   * Sidecar image / BIN bytes for pack GLBs that use relative URIs
   * (`Textures/colormap.png`). Keys may be the glTF URI or a basename.
   */
  sidecars?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  /** Largest cube face edge for an `.hdr` panorama (128, 256 or 512; default 256). */
  hdrFaceSize?: number;
  /** Aborts a slow conversion; the importer rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Fraction of this file's import done, from 0 to 1, for importers that can tell. */
  onProgress?: (fraction: number) => void;
}

export type Importer = (
  bytes: Uint8Array,
  options: ImportOptions,
) => Promise<ImportResult[]>;

/**
 * Runs the importer for a file name. The registry defaults to
 * `importByExtension`; the editor passes one that moves slow, pure-CPU
 * importers to a Web Worker (`import-worker-client.ts`).
 */
export type ImportRunner = (
  fileName: string,
  bytes: Uint8Array,
  options: ImportOptions,
) => Promise<ImportResult[]>;
