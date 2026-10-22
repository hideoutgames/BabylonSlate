/**
 * Browse-quality GLB/glTF parse for Content Browser dependents (P2).
 * Extracts materials, embedded images/textures, animation names, and rig
 * classification (`skin` joints, parented-mesh `hierarchy`, or `none`) from the
 * glTF JSON + BIN chunk. Play/preview load the stored GLB with both skeleton
 * kinds; this parse only names Catalog dependents.
 */

export const MISSING_GLTF_BIN =
  "glTF import needs the matching .bin buffer. Select the .gltf file together with its .bin sidecar.";

export interface GlbBrowseImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface GlbBrowseMaterial {
  source?: Record<string, unknown>;
  textureImages?: Array<number | null>;
  name: string;
  /** Index into `images` when a baseColor / metallicRoughness texture is present. */
  albedoImageIndex: number | null;
  /** True when the glTF material uses `KHR_materials_unlit`. */
  unlit: boolean;
}

export interface GlbBrowseAnimation {
  name: string;
  startTimeMs?: number;
  durationMs?: number;
}

export type GlbRigKind = "skin" | "hierarchy" | "none";

export interface GlbBrowseParse {
  materials: GlbBrowseMaterial[];
  images: GlbBrowseImage[];
  animations: GlbBrowseAnimation[];
  rigKind: GlbRigKind;
  boneNames: string[];
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function decodeJsonChunk(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as Record<string, unknown>;
}

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

/** Split a GLB into JSON + BIN, or null when the container is invalid. */
export function splitGlbJsonBin(
  bytes: Uint8Array,
): { json: Record<string, unknown>; bin: Uint8Array } | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readU32(view, 0) !== GLB_MAGIC) return null;
  const version = readU32(view, 4);
  if (version !== 2) return null;

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array = new Uint8Array(0);

  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = readU32(view, offset);
    const chunkType = readU32(view, offset + 4);
    offset += 8;
    if (offset + chunkLength > bytes.byteLength) break;
    const chunk = bytes.subarray(offset, offset + chunkLength);
    offset += chunkLength;
    if (chunkType === CHUNK_JSON) {
      try {
        json = decodeJsonChunk(chunk);
      } catch {
        return null;
      }
    } else if (chunkType === CHUNK_BIN) {
      bin = chunk;
    }
  }

  if (!json) return null;
  return { json, bin };
}

/** Encode glTF JSON + BIN as a GLB. */
export function encodeGlbJsonBin(
  json: Record<string, unknown>,
  bin: Uint8Array,
): Uint8Array<ArrayBuffer> {
  // Pad by UTF-8 byte length; non-ASCII names make it differ from the UTF-16 length.
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonBytes = new Uint8Array(encoded.byteLength + pad4(encoded.byteLength));
  jsonBytes.set(encoded);
  jsonBytes.fill(0x20, encoded.byteLength);
  const binPad = pad4(bin.byteLength);
  const binBytes = new Uint8Array(bin.byteLength + binPad);
  binBytes.set(bin, 0);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + binBytes.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let o = 12;
  view.setUint32(o, jsonBytes.byteLength, true);
  view.setUint32(o + 4, CHUNK_JSON, true);
  out.set(jsonBytes, o + 8);
  o += 8 + jsonBytes.byteLength;
  view.setUint32(o, binBytes.byteLength, true);
  view.setUint32(o + 4, CHUNK_BIN, true);
  out.set(binBytes, o + 8);
  return out;
}

function toSidecarMap(
  sidecars: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): Map<string, Uint8Array> {
  return sidecars instanceof Map
    ? sidecars
    : new Map(Object.entries(sidecars));
}

function isRelativeResourceUri(uri: string): boolean {
  return uri.length > 0 && !uri.startsWith("data:") && !/^[a-z][a-z0-9+.-]*:/i.test(uri);
}

/** Look up sidecar bytes by glTF URI, decoded URI, or basename. */
export function sidecarBytesForUri(
  uri: string,
  sidecars: ReadonlyMap<string, Uint8Array>,
): Uint8Array | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    decoded = uri;
  }
  const keys = [
    uri,
    decoded,
    uri.replace(/\\/g, "/"),
    decoded.replace(/\\/g, "/"),
  ];
  for (const key of keys) {
    const exact = sidecars.get(key);
    if (exact && exact.byteLength > 0) return exact;
    const base = key.split("/").pop();
    if (!base) continue;
    const byBase = sidecars.get(base);
    if (byBase && byBase.byteLength > 0) return byBase;
  }
  return null;
}

function mimeFromImageUri(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

/**
 * Rewrite external image `uri`s into BIN bufferViews so the stored Model is a
 * self-contained GLB. Unmatched URIs are left for `stripUnmatchedGltfImageUris`.
 */
export function embedGlbExternalImages(
  bytes: Uint8Array,
  sidecars: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): Uint8Array {
  const map = toSidecarMap(sidecars);
  const split = splitGlbJsonBin(bytes);
  if (!split) return bytes;
  const images = Array.isArray(split.json.images)
    ? (split.json.images as Record<string, unknown>[])
    : [];
  const bufferViews = Array.isArray(split.json.bufferViews)
    ? [...(split.json.bufferViews as Record<string, unknown>[])]
    : [];
  let bin = new Uint8Array(split.bin);
  let changed = false;
  for (const image of images) {
    const uri = typeof image.uri === "string" ? image.uri : "";
    if (!uri || uri.startsWith("data:")) continue;
    const sidecar = sidecarBytesForUri(uri, map);
    if (!sidecar) continue;
    const byteOffset = bin.byteLength;
    const pad = pad4(sidecar.byteLength);
    const next = new Uint8Array(byteOffset + sidecar.byteLength + pad);
    next.set(bin, 0);
    next.set(sidecar, byteOffset);
    bin = next;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: sidecar.byteLength,
    });
    image.bufferView = bufferViews.length - 1;
    image.mimeType =
      typeof image.mimeType === "string" && image.mimeType.length > 0
        ? image.mimeType
        : mimeFromImageUri(uri);
    delete image.uri;
    changed = true;
  }
  if (!changed) return bytes;
  split.json.bufferViews = bufferViews;
  split.json.images = images;
  const buffers = Array.isArray(split.json.buffers)
    ? [...(split.json.buffers as Record<string, unknown>[])]
    : [{}];
  buffers[0] = { ...buffers[0], byteLength: bin.byteLength };
  split.json.buffers = buffers;
  return encodeGlbJsonBin(split.json, bin);
}

function collectJsonExternalUris(json: Record<string, unknown>): string[] {
  const uris: string[] = [];
  const images = Array.isArray(json.images) ? json.images : [];
  for (const entry of images) {
    const uri = (entry as Record<string, unknown>).uri;
    if (typeof uri === "string" && isRelativeResourceUri(uri)) uris.push(uri);
  }
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  for (const entry of buffers) {
    const uri = (entry as Record<string, unknown>).uri;
    if (typeof uri === "string" && isRelativeResourceUri(uri)) uris.push(uri);
  }
  return uris;
}

/** External image / BIN URIs in a GLB or glTF JSON document. */
export function collectGltfExternalUris(
  fileName: string,
  bytes: Uint8Array,
): string[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".glb")) {
    const split = splitGlbJsonBin(bytes);
    return split ? collectJsonExternalUris(split.json) : [];
  }
  if (lower.endsWith(".gltf")) {
    try {
      return collectJsonExternalUris(
        JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
      );
    } catch {
      return [];
    }
  }
  return [];
}

/** The objects that can name a texture's image: the texture itself and its extensions (`EXT_texture_webp`, `KHR_texture_basisu`). */
function textureSourceHolders(texture: unknown): Array<Record<string, unknown>> {
  if (!texture || typeof texture !== "object") return [];
  const holders = [texture as Record<string, unknown>];
  const extensions = holders[0]!.extensions;
  if (extensions && typeof extensions === "object") {
    for (const extension of Object.values(extensions)) {
      if (extension && typeof extension === "object") {
        holders.push(extension as Record<string, unknown>);
      }
    }
  }
  return holders;
}

/** Repoint material texture references through `indexMap`; a reference to a texture it lacks is removed. */
function remapMaterialTextureRefs(
  node: unknown,
  indexMap: ReadonlyMap<number, number>,
): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "extras") continue;
    const value = record[key];
    if (!value || typeof value !== "object") continue;
    // glTF names every texture reference `*Texture` (`baseColorTexture`, `clearcoatTexture`, ...).
    const index = (value as { index?: unknown }).index;
    if (key.endsWith("Texture") && typeof index === "number") {
      const next = indexMap.get(index);
      if (next === undefined) delete record[key];
      else (value as { index: number }).index = next;
    } else {
      remapMaterialTextureRefs(value, indexMap);
    }
  }
}

/**
 * Remove glTF textures that no image backs, and every material reference to
 * them, so the loader never throws `/textures/N/source: Failed to find index`.
 * The materials fall back to their factors. Edits `json` in place and returns
 * whether anything changed.
 */
function dropSourcelessGltfTextures(
  json: Record<string, unknown>,
): boolean {
  if (!Array.isArray(json.textures)) return false;
  const textures = json.textures as unknown[];
  const imageCount = Array.isArray(json.images) ? json.images.length : 0;
  const kept: unknown[] = [];
  const indexMap = new Map<number, number>();
  for (const [index, texture] of textures.entries()) {
    const backed = textureSourceHolders(texture).some(
      ({ source }) =>
        typeof source === "number" &&
        Number.isInteger(source) &&
        source >= 0 &&
        source < imageCount,
    );
    if (!backed) continue;
    indexMap.set(index, kept.length);
    kept.push(texture);
  }
  if (kept.length === textures.length) return false;
  if (kept.length > 0) json.textures = kept;
  else delete json.textures;
  if (Array.isArray(json.materials)) {
    for (const material of json.materials) {
      remapMaterialTextureRefs(material, indexMap);
    }
  }
  return true;
}

function stripUnmatchedImages(bytes: Uint8Array): {
  bytes: Uint8Array;
  missingUris: string[];
} {
  const split = splitGlbJsonBin(bytes);
  if (!split) return { bytes, missingUris: [] };
  const images = Array.isArray(split.json.images)
    ? [...(split.json.images as Record<string, unknown>[])]
    : [];

  const kept: Record<string, unknown>[] = [];
  const indexMap = new Map<number, number>();
  const missingUris = new Set<string>();
  let changed = false;
  for (let i = 0; i < images.length; i++) {
    const image = { ...images[i] };
    const uri = typeof image.uri === "string" ? image.uri : "";
    if (uri && isRelativeResourceUri(uri)) {
      delete image.uri;
      changed = true;
    }
    const hasView = typeof image.bufferView === "number";
    const remainingUri = typeof image.uri === "string" ? image.uri : "";
    const hasData = remainingUri.startsWith("data:");
    if (!hasView && !hasData) {
      if (uri) missingUris.add(uri);
      changed = true;
      continue;
    }
    indexMap.set(i, kept.length);
    kept.push(image);
  }
  if (changed) {
    if (kept.length > 0) split.json.images = kept;
    else delete split.json.images;
    // Textures follow their images to the new indices; one whose image was
    // dropped loses its source and is removed below.
    if (Array.isArray(split.json.textures)) {
      for (const texture of split.json.textures) {
        for (const holder of textureSourceHolders(texture)) {
          if (typeof holder.source !== "number") continue;
          const next = indexMap.get(holder.source);
          if (next === undefined) delete holder.source;
          else holder.source = next;
        }
      }
    }
  }
  const repaired = dropSourcelessGltfTextures(split.json);
  if (!changed && !repaired) return { bytes, missingUris: [] };
  return {
    bytes: encodeGlbJsonBin(split.json, split.bin),
    missingUris: [...missingUris],
  };
}

/**
 * Drop relative image URIs that were not embedded so Play/preview never fetch
 * pack-relative paths like `Textures/colormap.png`. The textures and material
 * references that used those images go with them, so every texture that stays
 * has a valid image and the Material renders from its factors.
 */
export function stripUnmatchedGltfImageUris(bytes: Uint8Array): Uint8Array {
  return stripUnmatchedImages(bytes).bytes;
}

/**
 * Replace embedded rasters with a 1×1 red PNG so the glTF loader does not
 * decode full images. Callers must only slim when every slot Material texture
 * guid exists in packed Texture bytes — otherwise construction mats stay red.
 */
export function slimGlbEmbeddedImages(bytes: Uint8Array): Uint8Array {
  const split = splitGlbJsonBin(bytes);
  if (!split) return bytes;
  const images = Array.isArray(split.json.images)
    ? (split.json.images as Record<string, unknown>[])
    : [];
  if (images.length === 0) return bytes;
  const views = Array.isArray(split.json.bufferViews)
    ? (split.json.bufferViews as Record<string, unknown>[])
    : [];
  const imageViews = new Set<number>();
  for (const image of images) {
    if (typeof image.bufferView === "number") imageViews.add(image.bufferView);
  }
  if (imageViews.size === 0) return bytes;

  const png = ONE_BY_ONE_PNG;
  const pieces: Uint8Array[] = [];
  const nextViews: Record<string, unknown>[] = [];
  const indexMap = new Map<number, number>();
  let offset = 0;
  const bin = split.bin;

  const append = (data: Uint8Array, extra: Record<string, unknown> = {}) => {
    const pad = pad4(offset);
    if (pad > 0) {
      pieces.push(new Uint8Array(pad));
      offset += pad;
    }
    const viewOffset = offset;
    pieces.push(data);
    offset += data.byteLength;
    nextViews.push({
      ...extra,
      buffer: 0,
      byteOffset: viewOffset,
      byteLength: data.byteLength,
    });
    return nextViews.length - 1;
  };

  for (let i = 0; i < views.length; i++) {
    if (imageViews.has(i)) continue;
    const view = views[i]!;
    const byteOffset = typeof view.byteOffset === "number" ? view.byteOffset : 0;
    const byteLength = typeof view.byteLength === "number" ? view.byteLength : 0;
    const slice = bin.subarray(byteOffset, byteOffset + byteLength).slice();
    indexMap.set(i, append(slice, view));
  }
  const pngView = append(png);

  if (Array.isArray(split.json.accessors)) {
    split.json.accessors = (
      split.json.accessors as Record<string, unknown>[]
    ).map((accessor) => {
      const next = { ...accessor };
      if (
        typeof next.bufferView === "number" &&
        indexMap.has(next.bufferView)
      ) {
        next.bufferView = indexMap.get(next.bufferView);
      }
      return next;
    });
  }

  split.json.bufferViews = nextViews;
  split.json.buffers = [{ byteLength: offset }];
  split.json.images = images.map((image) => {
    const next = { ...image };
    delete next.uri;
    return { ...next, mimeType: "image/png", bufferView: pngView };
  });

  const outBin = new Uint8Array(offset);
  let writeAt = 0;
  for (const piece of pieces) {
    outBin.set(piece, writeAt);
    writeAt += piece.byteLength;
  }
  return encodeGlbJsonBin(split.json, outBin);
}

function gltfJsonToGlb(
  jsonText: string,
  sidecars: ReadonlyMap<string, Uint8Array>,
): Uint8Array | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
  let bin: Uint8Array = new Uint8Array(0);
  const buffers = Array.isArray(json.buffers)
    ? [...(json.buffers as Record<string, unknown>[])]
    : [];
  const buffer0 = buffers[0];
  const bufferUri = typeof buffer0?.uri === "string" ? buffer0.uri : "";
  if (bufferUri) {
    // The GLB's BIN chunk becomes buffer 0, so its bytes must come along: a
    // sidecar file or a data URI. A remote URL would leave the BIN empty.
    let bytes: Uint8Array | null;
    if (isRelativeResourceUri(bufferUri)) {
      bytes = sidecarBytesForUri(bufferUri, sidecars);
      if (!bytes) throw new Error(MISSING_GLTF_BIN);
    } else if (bufferUri.startsWith("data:")) {
      try {
        bytes = decodeDataUri(bufferUri)?.bytes ?? null;
      } catch {
        bytes = null;
      }
      if (!bytes) throw new Error("glTF buffer 0 has an unreadable data URI.");
    } else {
      throw new Error("glTF import needs buffer 0 as a .bin file or a data URI, not a URL.");
    }
    bin = bytes;
    const rest = { ...buffer0 };
    delete rest.uri;
    buffers[0] = { ...rest, byteLength: bin.byteLength };
    json.buffers = buffers;
  } else if (typeof buffer0?.byteLength === "number" && buffer0.byteLength === 0) {
    json.buffers = buffers.length > 0 ? buffers : [{ byteLength: 0 }];
  }
  return encodeGlbJsonBin(json, bin);
}

/**
 * Embed sidecars and strip leftover relative image URIs. `.gltf` becomes a GLB
 * when a BIN sidecar or external image URIs are present. `missingImageUris`
 * names the image files no sidecar supplied; the stored GLB goes without them.
 */
export function ingestGltfForImport(
  fileName: string,
  bytes: Uint8Array,
  sidecars: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array> = {},
): { bytes: Uint8Array; mime: string; missingImageUris: string[] } {
  const map = toSidecarMap(sidecars);
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".gltf")) {
    const glb = gltfJsonToGlb(new TextDecoder().decode(bytes), map);
    if (!glb) {
      return { bytes, mime: "model/gltf+json", missingImageUris: [] };
    }
    const stripped = stripUnmatchedImages(embedGlbExternalImages(glb, map));
    return {
      bytes: stripped.bytes,
      mime: "model/gltf-binary",
      missingImageUris: stripped.missingUris,
    };
  }
  const stripped = stripUnmatchedImages(embedGlbExternalImages(bytes, map));
  return {
    bytes: stripped.bytes,
    mime: "model/gltf-binary",
    missingImageUris: stripped.missingUris,
  };
}

/** Parse a `.glb` container into browse metadata + embedded image bytes. */
export function parseGlbForBrowse(bytes: Uint8Array): GlbBrowseParse | null {
  const split = splitGlbJsonBin(bytes);
  if (!split) return null;
  return browseFromGltfJson(split.json, split.bin);
}

/** Parse a `.gltf` JSON document (optional external BIN not resolved here). */
export function parseGltfJsonForBrowse(
  jsonText: string,
  bin: Uint8Array | null = null,
): GlbBrowseParse | null {
  try {
    return browseFromGltfJson(JSON.parse(jsonText) as Record<string, unknown>, bin);
  } catch {
    return null;
  }
}

function browseFromGltfJson(
  json: Record<string, unknown>,
  bin: Uint8Array | null,
): GlbBrowseParse {
  const imagesJson = Array.isArray(json.images) ? json.images : [];
  const materialsJson = Array.isArray(json.materials) ? json.materials : [];
  const animationsJson = Array.isArray(json.animations) ? json.animations : [];
  const texturesJson = Array.isArray(json.textures) ? json.textures : [];
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];

  const images: GlbBrowseImage[] = [];
  for (let i = 0; i < imagesJson.length; i++) {
    const image = imagesJson[i] as Record<string, unknown>;
    const name =
      typeof image.name === "string" && image.name.length > 0
        ? image.name
        : `Image_${i}`;
    const mime =
      typeof image.mimeType === "string" ? image.mimeType : "image/png";

    if (typeof image.uri === "string" && image.uri.startsWith("data:")) {
      const parsed = decodeDataUri(image.uri);
      if (parsed) {
        images.push({ name, mime: parsed.mime || mime, bytes: parsed.bytes });
        continue;
      }
    }

    if (typeof image.bufferView === "number" && bin) {
      const view = bufferViews[image.bufferView] as
        | Record<string, unknown>
        | undefined;
      const byteLength =
        typeof view?.byteLength === "number" ? (view.byteLength as number) : 0;
      const byteOffset = Number(view?.byteOffset ?? 0);
      if (
        view &&
        byteLength > 0 &&
        Number.isFinite(byteOffset) &&
        byteOffset >= 0 &&
        byteOffset + byteLength <= bin.byteLength
      ) {
        images.push({
          name,
          mime,
          // Copy out of the GLB BIN so Texture pixels do not alias Model.source.
          bytes: bin.slice(byteOffset, byteOffset + byteLength),
        });
        continue;
      }
    }

    // External URI or missing BIN — keep a named placeholder with empty bytes
    // so the CB still lists a Texture dependent.
    images.push({ name, mime, bytes: new Uint8Array(0) });
  }

  const images_out = images;
  const materials: GlbBrowseMaterial[] = materialsJson.map((entry, i) => {
    const material = entry as Record<string, unknown>;
    const name =
      typeof material.name === "string" && material.name.length > 0
        ? material.name
        : `Material_${i}`;
    let albedoImageIndex: number | null = null;
    const pbr = material.pbrMetallicRoughness as
      | Record<string, unknown>
      | undefined;
    const baseColor = pbr?.baseColorTexture as Record<string, unknown> | undefined;
    if (baseColor && typeof baseColor.index === "number") {
      const texture = texturesJson[baseColor.index] as
        | Record<string, unknown>
        | undefined;
      if (texture && typeof texture.source === "number") {
        albedoImageIndex = texture.source as number;
      }
    }
    return {
      name,
      albedoImageIndex,
      source: material,
      textureImages: texturesJson.map((texture) => {
        const source = (texture as Record<string, unknown>)?.source;
        return typeof source === "number" ? source : null;
      }),
      unlit: Boolean(
        (material.extensions as Record<string, unknown> | undefined)
          ?.KHR_materials_unlit,
      ),
    };
  });

  const nodesJson = Array.isArray(json.nodes) ? json.nodes : [];
  const skinsJson = Array.isArray(json.skins) ? json.skins : [];

  const animations = gltfAnimationClips(json);

  const { rigKind, boneNames } = classifyGltfRig(
    nodesJson,
    skinsJson,
    animationsJson,
  );

  return { materials, images: images_out, animations, rigKind, boneNames };
}

/** Clip ranges in source seconds; names agree between import and Babylon loading. */
export function gltfAnimationClips(json: Record<string, unknown>): GlbBrowseAnimation[] {
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const animations = Array.isArray(json.animations) ? json.animations : [];
  const used = new Set<string>();
  return animations.map((entry, i) => {
    const animation = entry as Record<string, unknown>;
    const base =
      typeof animation.name === "string" && animation.name.trim().length > 0
        ? animation.name.trim()
        : `Animation_${i}`;
    let name = base;
    for (let suffix = 1; used.has(name); suffix++) name = `${base}_${suffix}`;
    used.add(name);
    return { name, ...clipTimeRange(animation, accessors) };
  });
}

function isCatalogBoneName(name: string): boolean {
  return name !== "__root__";
}

function nodeName(nodes: unknown[], index: number): string {
  const node = nodes[index] as Record<string, unknown> | undefined;
  if (typeof node?.name === "string" && node.name.length > 0) return node.name;
  return `Node_${index}`;
}

function clipTimeRange(
  animation: Record<string, unknown>,
  accessors: unknown[],
): Pick<GlbBrowseAnimation, "startTimeMs" | "durationMs"> {
  const samplers = Array.isArray(animation.samplers) ? animation.samplers : [];
  let maxSeconds = 0;
  let minSeconds = Infinity;
  let found = false;
  for (const sampler of samplers) {
    const row = sampler as Record<string, unknown>;
    if (typeof row.input !== "number") continue;
    const accessor = accessors[row.input] as Record<string, unknown> | undefined;
    const max = Array.isArray(accessor?.max) ? accessor.max : [];
    const seconds = typeof max[0] === "number" ? max[0] : NaN;
    // A channel keyed only at t = 0 still starts the take there.
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    found = true;
    const min = Array.isArray(accessor?.min) ? accessor.min : [];
    const start = typeof min[0] === "number" && Number.isFinite(min[0]) ? min[0] : 0;
    minSeconds = Math.min(minSeconds, start);
    if (seconds > maxSeconds) maxSeconds = seconds;
  }
  if (!found || maxSeconds <= minSeconds) return {};
  return {
    ...(minSeconds > 0 ? { startTimeMs: minSeconds * 1000 } : {}),
    durationMs: (maxSeconds - minSeconds) * 1000,
  };
}

function classifyGltfRig(
  nodes: unknown[],
  skins: unknown[],
  animations: unknown[],
): { rigKind: GlbRigKind; boneNames: string[] } {
  if (skins.length > 0) {
    const boneNames: string[] = [];
    const seen = new Set<string>();
    for (const skin of skins) {
      const joints = Array.isArray((skin as Record<string, unknown>).joints)
        ? ((skin as Record<string, unknown>).joints as unknown[])
        : [];
      for (const joint of joints) {
        if (typeof joint !== "number") continue;
        const name = nodeName(nodes, joint);
        if (!isCatalogBoneName(name) || seen.has(name)) continue;
        seen.add(name);
        boneNames.push(name);
      }
    }
    return { rigKind: "skin", boneNames };
  }

  const targeted = new Set<number>();
  for (const animation of animations) {
    const channels = Array.isArray((animation as Record<string, unknown>).channels)
      ? ((animation as Record<string, unknown>).channels as unknown[])
      : [];
    for (const channel of channels) {
      const target = (channel as Record<string, unknown>).target as
        | Record<string, unknown>
        | undefined;
      if (typeof target?.node === "number") targeted.add(target.node);
    }
  }
  if (targeted.size === 0) return { rigKind: "none", boneNames: [] };

  const parent = buildParentIndex(nodes);
  const meshParts = new Set<number>();
  for (const index of targeted) collectMeshParts(nodes, index, meshParts);
  if (!parentedMeshesShareAncestor([...meshParts], parent)) {
    return { rigKind: "none", boneNames: [] };
  }
  return {
    rigKind: "hierarchy",
    boneNames: hierarchyBoneNamesForTree(nodes, meshParts, parent),
  };
}

function nodeChildren(node: Record<string, unknown> | undefined): number[] {
  if (!Array.isArray(node?.children)) return [];
  return node.children.filter((child): child is number => typeof child === "number");
}

function buildParentIndex(nodes: unknown[]): Array<number | undefined> {
  const parent: Array<number | undefined> = Array.from({ length: nodes.length });
  for (let i = 0; i < nodes.length; i++) {
    for (const child of nodeChildren(nodes[i] as Record<string, unknown> | undefined)) {
      if (child >= 0 && child < nodes.length) parent[child] = i;
    }
  }
  return parent;
}

function collectMeshParts(
  nodes: unknown[],
  start: number,
  out: Set<number>,
): void {
  const stack = [start];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const index = stack.pop()!;
    if (seen.has(index)) continue;
    seen.add(index);
    const node = nodes[index] as Record<string, unknown> | undefined;
    if (typeof node?.mesh === "number") out.add(index);
    for (const child of nodeChildren(node)) stack.push(child);
  }
}

function ancestorChain(
  index: number,
  parent: Array<number | undefined>,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let current = parent[index];
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parent[current];
  }
  return chain;
}

/** Mannequin-style: two or more parented mesh parts share a transform ancestor. */
function parentedMeshesShareAncestor(
  meshParts: number[],
  parent: Array<number | undefined>,
): boolean {
  const parented = meshParts.filter((index) => parent[index] !== undefined);
  if (parented.length < 2) return false;
  for (let i = 0; i < parented.length; i++) {
    const a = parented[i]!;
    const related = new Set(ancestorChain(a, parent));
    related.add(a);
    for (let j = i + 1; j < parented.length; j++) {
      const b = parented[j]!;
      if (related.has(b)) return true;
      for (const ancestor of ancestorChain(b, parent)) {
        if (related.has(ancestor)) return true;
      }
    }
  }
  return false;
}

function hierarchyBoneNamesForTree(
  nodes: unknown[],
  meshParts: Iterable<number>,
  parent: Array<number | undefined>,
): string[] {
  const include = new Set<number>();
  for (const mesh of meshParts) {
    include.add(mesh);
    for (const ancestor of ancestorChain(mesh, parent)) include.add(ancestor);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    if (!include.has(i)) continue;
    const name = nodeName(nodes, i);
    if (!isCatalogBoneName(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function decodeDataUri(
  uri: string,
): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3] ?? "";
  if (isBase64) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(data)) };
}

/** Build a minimal GLB for unit / Playwright fixtures. */
export function buildMinimalGlbFixture(options?: {
  materialName?: string;
  imageRgba?: Uint8Array;
  animationName?: string;
}): Uint8Array {
  const materialName = options?.materialName ?? "FixtureMat";
  const animationName = options?.animationName ?? "FixtureClip";
  // 2x2 opaque PNG (tiny) — or raw RGBA wrapped as a bufferView with mime png
  // Using a hand-rolled 1x1 PNG keeps the fixture self-contained.
  const png = options?.imageRgba ?? ONE_BY_ONE_PNG;
  const json = {
    asset: { version: "2.0", generator: "haptic-test" },
    buffers: [{ byteLength: png.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.byteLength }],
    images: [{ mimeType: "image/png", bufferView: 0, name: "FixtureImage" }],
    textures: [{ source: 0 }],
    materials: [
      {
        name: materialName,
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    animations: [{ name: animationName, channels: [], samplers: [] }],
    meshes: [],
    nodes: [],
    scenes: [{ nodes: [] }],
    scene: 0,
  };
  return encodeGlbJsonBin(json, png);
}

/** Minimal valid 1×1 PNG (red pixel). */
const ONE_BY_ONE_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01,
  0x00, 0xf7, 0x03, 0x41, 0x43, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);
