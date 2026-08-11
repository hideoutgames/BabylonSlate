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
}

export type Importer = (
  bytes: Uint8Array,
  options: ImportOptions,
) => Promise<ImportResult[]>;
