import type { IndexedAsset } from "@haptic/assets";
import { areaEmissionTextureGuids, type SerializedScene } from "@haptic/core";
import {
  environmentTextureGuidsFromScenes, materialGuidsFromScenes, modelAssetGuidsFromScene,
  overlayTextureGuidsFromScene, playFontGuidsFromScenes, postProcessTextureGuidsFromScenes, materialInstanceTextureGuidsFromScenes,
  skyboxFaceGuidsFromScene, spriteAssetGuidsFromScene, tilemapAssetGuidsFromScene,
} from "./play-content";
import { assetHeaderDependencyMetadata } from "./content-browser-helpers";
import { textureContentSignature, textureEncodingSignature } from "./texture-upload-signature";

const resourceTypes = new Set(["Water", "Material", "MaterialInstance", "MaterialFunction", "RenderTarget", "RenderTargetTexture", "Model", "Texture", "Sprite",
  "SpriteAnimation", "Tilemap", "Tileset", "Font", "Animation", "Skeleton"]);

/** Live authored values choose roots; deferred Scene/prefab references stay cold. */
export function sceneViewportRequiredAssets(scene: SerializedScene, assets: readonly IndexedAsset[], extraGuids: readonly string[] = []): Set<string> {
  const byGuid = new Map(assets.map((asset) => [asset.header.guid, asset]));
  const pending = [...assetHeaderDependencyMetadata("Scene", scene as unknown as Record<string, unknown>, assets).requiredDependencies, ...extraGuids];
  const result = new Set<string>();
  while (pending.length) {
    const guid = pending.pop()!;
    if (result.has(guid)) continue;
    result.add(guid);
    const asset = byGuid.get(guid);
    if (asset && !asset.placeholder) pending.push(...asset.header.requiredDependencies);
  }
  return result;
}

/** Match the viewport collectors. Transforms and scene autosaves do not alter
 * their inputs. Include saved resource revisions for transitive model slots,
 * material functions, fonts and late texture/emission publication. */
export function sceneViewportAssetKey(scene: SerializedScene | null, assets: readonly IndexedAsset[]): string {
  const guids = new Set([
    ...spriteAssetGuidsFromScene(scene), ...tilemapAssetGuidsFromScene(scene),
    ...modelAssetGuidsFromScene(scene), ...materialGuidsFromScenes([scene]),
    ...playFontGuidsFromScenes([scene]), ...environmentTextureGuidsFromScenes([scene]),
    ...postProcessTextureGuidsFromScenes([scene]), ...materialInstanceTextureGuidsFromScenes([scene]), ...skyboxFaceGuidsFromScene(scene),
    ...overlayTextureGuidsFromScene(scene), ...areaEmissionTextureGuids(scene),
  ]);
  return `${JSON.stringify([...guids].sort())}\n${resourceRevisionKey(assets)}`;
}

type ResourceSource = readonly [asset: IndexedAsset, header: unknown, payload: unknown, chunks: unknown];
let resourceKeyCache: { sources: readonly ResourceSource[]; key: string } | null = null;

/** One resource's serialized entry in the key, valid while its header, guid, type, payload and chunk list are the same objects and values. */
const resourceEntries = new WeakMap<IndexedAsset["header"], { guid: string; type: string; payload: unknown; chunks: unknown; json: string }>();

/** The entry as `JSON.stringify` writes it inside the key's array. */
function resourceEntryJson({ header }: IndexedAsset): string {
  const known = resourceEntries.get(header);
  if (known && known.guid === header.guid && known.type === header.type && known.payload === header.payload && known.chunks === header.chunks) return known.json;
  const json = JSON.stringify(header.type === "Texture"
    // A Texture's stored encoding changes without touching what it shows; that is
    // `sceneViewportTextureEncodings`, so an encode never reloads the viewport.
    ? [header.guid, header.type, ...textureContentSignature(header)]
    : [header.guid, header.type, header.payload, header.chunks.map((chunk) => [chunk.id, chunk.sha256])]);
  resourceEntries.set(header, { guid: header.guid, type: header.type, payload: header.payload, chunks: header.chunks, json });
  return json;
}

/** Scene edits recompute the asset key; reuse the resource part while the
 * registry still holds the same headers, payloads and chunk lists, and when it
 * does not, serialize only the resources whose own header changed. */
function resourceRevisionKey(assets: readonly IndexedAsset[]): string {
  const resources = assets.filter(({ header }) => resourceTypes.has(header.type));
  const cached = resourceKeyCache;
  if (cached && cached.sources.length === resources.length && resources.every((asset, index) => {
    const [source, header, payload, chunks] = cached.sources[index]!;
    return source === asset && header === asset.header && payload === asset.header.payload && chunks === asset.header.chunks;
  })) return cached.key;
  const key = `[${[...resources]
    .sort((a, b) => a.header.guid.localeCompare(b.header.guid))
    .map(resourceEntryJson)
    .join(",")}]`;
  resourceKeyCache = {
    sources: resources.map((asset): ResourceSource => [asset, asset.header, asset.header.payload, asset.header.chunks]),
    key,
  };
  return key;
}

const PAYLOAD_DOCUMENT_KINDS = new Map([["Tilemap", "tilemap"], ["Tileset", "tileset"], ["Water", "water"]]);
const identities = new WeakMap<object, number>();
let lastIdentity = 0;
/** A number that stays with the object, so equal numbers mean the same object. */
function identityOf(value: object): number {
  let identity = identities.get(value);
  if (identity === undefined) identities.set(value, identity = ++lastIdentity);
  return identity;
}

/**
 * A revision per Tilemap, Tileset and Water, by guid, for the engine's
 * `MeshAssetContext.payloadRevisions`: an unchanged revision means the payload
 * collected for the guid is unchanged, so the engine does not serialize it
 * again to compare installs. Collection prefers an open tab's document to the
 * saved asset, so that document's identity is the revision while a tab holds
 * one (an edit replaces the document); otherwise it is the identity of the
 * saved header's payload and chunk list, which the registry replaces when the
 * asset is saved or re-read. A document that is not an object has no revision.
 */
export function viewportPayloadRevisions(
  assets: readonly IndexedAsset[],
  openDocuments: readonly { ref: { kind: string; path: string }; content?: unknown }[],
): Map<string, string> {
  const open = new Map<string, unknown>();
  for (const { ref, content } of openDocuments) if (content) open.set(`${ref.kind}\0${ref.path}`, content);
  const revisions = new Map<string, string>();
  for (const { header, path } of assets) {
    const kind = PAYLOAD_DOCUMENT_KINDS.get(header.type);
    if (!kind) continue;
    const content = open.get(`${kind}\0${path}`);
    if (content === undefined) {
      const payload: unknown = header.payload;
      const chunks: unknown = header.chunks;
      if (payload && typeof payload === "object" && chunks && typeof chunks === "object") {
        revisions.set(header.guid, `saved:${identityOf(payload)}:${identityOf(chunks)}`);
      }
    } else if (content && typeof content === "object") {
      revisions.set(header.guid, `open:${identityOf(content)}`);
    }
  }
  return revisions;
}

/**
 * The revisions that held from before a collection to after it. A document
 * edited while the collection ran may be newer than the revision read at either
 * end, so only a revision that did not move across the collection is kept.
 */
export function stableViewportPayloadRevisions(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...after].filter(([guid, revision]) => before.get(guid) === revision));
}

/**
 * How each Texture is stored (committed KTX2 and retained encodes), by guid.
 * A change here with an unchanged `sceneViewportAssetKey` means only the stored
 * representation of the same pixels and settings changed.
 */
export function sceneViewportTextureEncodings(assets: readonly IndexedAsset[]): Map<string, string> {
  const encodings = new Map<string, string>();
  for (const { header } of assets) {
    if (header.type === "Texture") encodings.set(header.guid, textureEncodingSignature(header));
  }
  return encodings;
}

/** Installed Textures whose stored encoding differs from the one the viewport applied. */
export function changedTextureEncodings(applied: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[] {
  const changed: string[] = [];
  for (const [guid, signature] of applied) {
    if ((current.get(guid) ?? "") !== signature) changed.push(guid);
  }
  return changed;
}
