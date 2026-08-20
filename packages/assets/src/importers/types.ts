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
  /** Uniform Model import multiplier. Defaults to DEFAULT_MODEL_IMPORT_SCALE. */
  modelImportScale?: number;
  /**
   * Sidecar image / BIN bytes for pack GLBs that use relative URIs
   * (`Textures/colormap.png`). Keys may be the glTF URI or a basename.
   */
  sidecars?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
}

export type Importer = (
  bytes: Uint8Array,
  options: ImportOptions,
) => Promise<ImportResult[]>;
