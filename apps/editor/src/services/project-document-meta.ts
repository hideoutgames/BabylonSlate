import { normalizeDataDefinitionAsset, normalizeDataTreeAsset } from "@haptic/core";
import type {
  DocumentKind,
  SerializedGraph,
  SerializedScene,
  SerializedSceneLayer,
} from "@haptic/core";
import {
  assetTypeForDocumentKind,
  classHeaderMeta,
  isAssetDocumentKind,
  isInputAssetType,
  normalizeInputAssetPayload,
  normalizePrefab,
} from "@haptic/core";
import {
  ATLAS_REFERRER_TYPES,
  ATLAS_TEXTURES_META,
  atlasTextureGuids,
  DOCUMENT_CHUNK_ID,
  isCarriedChunk,
  isEnvironmentTexturePayload,
  parseSpriteAnimationPayload,
  spriteAnimationDurationMs,
  stripAssetFileSuffix,
  type EncodableChunk,
  type HassetHeader,
} from "@haptic/assets";
import { materialHeaderMeta } from "../lib/content-browser-helpers";
import { asEnumAsset, asStructureAsset } from "../lib/type-asset-payload";

export function headerMetaForSave(
  type: string,
  content:
    | SerializedScene
    | SerializedSceneLayer
    | SerializedGraph
    | Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Sheets render indexed values without loading one document per visible row.
  // This header snapshot is always derived from the body being saved.
  if (type === "DataDefinition") return { ...normalizeDataDefinitionAsset(content) };
  if (type === "DataTree") return { ...normalizeDataTreeAsset(content) };
  if (isInputAssetType(type)) {
    const input = normalizeInputAssetPayload(type, content);
    return { valueType: input.valueType };
  }
  const materialMeta = materialHeaderMeta(
    type,
    content as Record<string, unknown>,
  );
  if (materialMeta) return materialMeta;
  // Closed Prefabs sync placed instances and place new ones from the header alone.
  if (type === "Prefab") return { components: normalizePrefab(content).components };
  if (type === "Class") {
    return classHeaderMeta(
      content as {
        members?: Array<{
          id?: string;
          kind: string;
          name: string;
          typeId?: string;
          typeClassId?: string;
          functionId?: string;
          assetGuid?: string;
          overridable?: boolean;
          implementsInterface?: { assetGuid: string; methodName: string };
          overrides?: { classId: string; name: string };
          pins?: Array<{
            name: string;
            typeId?: string;
            direction?: "in" | "out";
            typeClassId?: string;
            unit?: string;
          }>;
          unit?: string;
        }>;
      },
    );
  }
  // Closed Structures and Enums supply their fields and members to type catalogs,
  // data reads and dependency collection.
  if (type === "Structure") return { ...asStructureAsset(content as Record<string, unknown>) };
  if (type === "Enum") return { ...asEnumAsset(content as Record<string, unknown>) };
  if (type === "ScriptInterface") {
    const payload = content as {
      guid?: string;
      name?: string;
      methods?: Array<{
        name: string;
        pins: Array<{
          name: string;
          typeId: string;
          direction: "in" | "out";
          typeClassId?: string;
        }>;
      }>;
    };
    return {
      guid: typeof payload.guid === "string" ? payload.guid : "",
      name: typeof payload.name === "string" ? payload.name : "Interface",
      methods: Array.isArray(payload.methods) ? payload.methods : [],
    };
  }
  if (type === "SpriteAnimation") {
    const parsed = parseSpriteAnimationPayload(content);
    return {
      durationMs: spriteAnimationDurationMs(parsed),
      [ATLAS_TEXTURES_META]: atlasTextureGuids(type, content as Record<string, unknown>),
    };
  }
  if (ATLAS_REFERRER_TYPES.has(type)) {
    // The registry reads a referrer's atlases from its header, never its document.
    return { [ATLAS_TEXTURES_META]: atlasTextureGuids(type, content as Record<string, unknown>) };
  }
  return undefined;
}

/** Environment cube fields the registry rewrites when a Face Size change converts the `.hdr` again. */
const ENVIRONMENT_TEXTURE_STATE_KEYS = [
  "container",
  "encoding",
  "width",
  "height",
  "mipLevels",
  "hasIrradiance",
  "hdrFaceSize",
] as const;

/** Texture payload fields owned by the registry's encode queue, not the document. */
const TEXTURE_ENCODE_STATE_KEYS = [
  "compressionState",
  "ktx2ChunkId",
  "encodeError",
  "encodeWallMs",
  "ktx2Width",
  "ktx2Height",
  "ktx2BlockAlign",
  "ktx2Sha256",
] as const;

/**
 * An open Texture document keeps the payload it opened with, but encodes can
 * commit meanwhile. Saving takes these fields from the file (absent stays
 * absent) so `ktx2ChunkId` never points back at a superseded encode.
 */
export function withSavedTextureEncodeState(
  content: Record<string, unknown>,
  saved: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...content };
  const keys = isEnvironmentTexturePayload(saved)
    ? [...TEXTURE_ENCODE_STATE_KEYS, ...ENVIRONMENT_TEXTURE_STATE_KEYS]
    : TEXTURE_ENCODE_STATE_KEYS;
  for (const key of keys) {
    if (key in saved) next[key] = saved[key];
    else delete next[key];
  }
  return next;
}

/** sha256 of the KTX2 chunk a Texture's header commits to (`ktx2ChunkId`), if any. */
export function committedKtx2Sha256(header: Pick<HassetHeader, "payload" | "chunks"> | undefined): string | null {
  const id = header?.payload.ktx2ChunkId;
  return header?.chunks.find((chunk) => chunk.id === id)?.sha256 ?? null;
}

/**
 * What a rewrite supplies itself, for `storeDocumentBytes` to verify against
 * the file: the document body and every chunk it did not carry over.
 */
export function suppliedChunkIds(chunks: readonly EncodableChunk[]): string[] {
  return [DOCUMENT_CHUNK_ID, ...chunks.filter((chunk) => !isCarriedChunk(chunk)).map((chunk) => chunk.id)];
}

export function fallbackDocumentType(kind: Exclude<DocumentKind, "content-browser">): string {
  return isAssetDocumentKind(kind) ? assetTypeForDocumentKind(kind) : "Class";
}

export function newGuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function assetName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return stripAssetFileSuffix(file) || file.replace(/\.hasset$/, "");
}

export function parentDir(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}
