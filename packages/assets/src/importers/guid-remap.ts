import { newAssetGuid } from "../guid";
import {
  isDataAssetPayload,
  isDataGraphNodePayload,
  mapDataAssetReferences,
  mapDataGraphLiteralReferences,
  mapDataGraphReferences,
  remapDataPayloadGuids,
  type DataDefinitionFieldsResolver,
} from "../data-asset-refs";
import type { ImportResult } from "./types";

const DATA_TYPES = new Set(["DataDefinition", "DataTree", "Structure", "Enum"]);

/** Declared slot types whose values are authored text, never an asset id. */
const TEXT_SLOT_TYPES = new Set(["string", "name", "text", "tag", "enum"]);

const isTextSlot = (type: unknown): boolean => typeof type === "string" && TEXT_SLOT_TYPES.has(type);

/** Components whose `text` places Texture images with `[img=<guid>]`. */
const RICH_TEXT_COMPONENTS = new Set(["2DTextComponent", "2DRichTextComponent"]);

function remapRichTextImages(text: string, remap: ReadonlyMap<string, string>): string {
  return text.replace(/(\[img\s*=)([^\s\]]+)/gi, (tag, open: string, guid: string) => {
    const next = remap.get(guid);
    return next ? `${open}${next}` : tag;
  });
}

/** Keys that hold a declared slot's value: a member default or a node's pin default. */
const isSlotValueKey = (key: string): boolean =>
  key === "defaultValue" || key === "value" || key.startsWith("default:");

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function mapArray(entries: unknown[], transform: (entry: unknown) => unknown): unknown[] {
  let changed = false;
  const mapped = entries.map((entry) => {
    const next = transform(entry);
    changed ||= next !== entry;
    return next;
  });
  return changed ? mapped : entries;
}

/** A remapped asset id, alone or as a Class's `scene:` reference. */
function remapReference(value: string, remap: ReadonlyMap<string, string>): string {
  const direct = remap.get(value);
  if (direct) return direct;
  if (value.startsWith("scene:")) {
    const scene = remap.get(value.slice(6));
    if (scene) return `scene:${scene}`;
  }
  return value;
}

/**
 * Rewrite every reference to a remapped asset in a JSON payload: any string
 * that is exactly a remapped id (Scene and Prefab component fields, Class
 * defaults, Material nodes, Sprite and Tileset textures, Tilemap tilesets,
 * Font fallbacks, ...), as deleting an asset clears them. Values whose
 * declared type is text (a String variable, a Data field) stay as authored.
 */
function remapAssetReferences(
  value: unknown,
  remap: ReadonlyMap<string, string>,
  definitionFields: DataDefinitionFieldsResolver,
): unknown {
  const map = (reference: string) => remapReference(reference, remap);
  const slotValue = (slot: Record<string, unknown>, entry: unknown): unknown => {
    if (slot.container === "map" && Array.isArray(entry)) {
      return mapArray(entry, (item) => {
        const pair = record(item);
        if (!pair) return item;
        const key = isTextSlot(slot.keyTypeId) ? pair.key : walk(pair.key);
        const mapped = isTextSlot(slot.typeId) ? pair.value : walk(pair.value);
        return key === pair.key && mapped === pair.value ? item : { ...pair, key, value: mapped };
      });
    }
    return isTextSlot(slot.typeId) ? entry : walk(entry);
  };
  const walk = (entry: unknown): unknown => {
    if (typeof entry === "string") return map(entry);
    if (Array.isArray(entry)) return mapArray(entry, walk);
    const row = record(entry);
    if (!row) return entry;
    // Data nodes and payloads say which of their values are references.
    if (isDataGraphNodePayload(row)) return mapDataGraphReferences(row, map, definitionFields);
    if (isDataAssetPayload(row)) return mapDataAssetReferences(row, map, definitionFields);
    // A Data literal's schema decides its references, whether or not any changed.
    const schemaTyped = Array.isArray(row.dataSchema);
    const literal = schemaTyped ? mapDataGraphLiteralReferences(row, map, definitionFields) : row;
    const declaresSlot = typeof row.typeId === "string" || typeof row.keyTypeId === "string";
    let next = row;
    for (const [key, child] of Object.entries(row)) {
      const mapped = schemaTyped && (key === "dataSchema" || key === "default:values") ? literal[key]
        : declaresSlot && isSlotValueKey(key) ? slotValue(row, child)
          : walk(child);
      if (mapped === child) continue;
      if (next === row) next = { ...row };
      next[key] = mapped;
    }
    const properties = record(next.properties);
    if (typeof next.classId === "string" && RICH_TEXT_COMPONENTS.has(next.classId) && typeof properties?.text === "string") {
      const text = remapRichTextImages(properties.text, remap);
      if (text !== properties.text) next = { ...next, properties: { ...properties, text } };
    }
    return next;
  };
  return walk(value);
}

function remapPayload(
  type: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
  definitionFields: DataDefinitionFieldsResolver,
): Record<string, unknown> {
  if (DATA_TYPES.has(type)) return remapDataPayloadGuids(type, payload, remap, definitionFields);
  return remapAssetReferences(payload, remap, definitionFields) as Record<string, unknown>;
}

/**
 * Rewrite any guid in `results` that collides with `existingGuids`, with
 * every reference in the set (dependencies, header payloads and document
 * chunks, and the entry's own `attachToGuid` when it points inside the same
 * batch) following it. Cross-project import remaps colliding guids; template
 * instantiate keeps guids as-is by never calling this with a colliding set.
 */
export function remapImportResultGuids(
  results: ImportResult[],
  existingGuids: ReadonlySet<string>,
): ImportResult[] {
  const remap = new Map<string, string>();
  for (const result of results) {
    // A representation for an existing Font carries that Font's guid on purpose.
    if (!result.attachToGuid && existingGuids.has(result.guid)) {
      remap.set(result.guid, newAssetGuid());
    }
  }
  return applyImportGuidRemap(results, remap);
}

/**
 * Give each asset `remap` names its new guid and rewrite every reference to it
 * in the set. `outsideDefinitionFields` resolves Data Definitions and
 * Structures the set itself does not hold (a folder copy's project assets).
 */
export function applyImportGuidRemap(
  results: ImportResult[],
  remap: ReadonlyMap<string, string>,
  outsideDefinitionFields?: DataDefinitionFieldsResolver,
): ImportResult[] {
  if (remap.size === 0) {
    return results;
  }
  const definitions = new Map<string, readonly unknown[]>();
  for (const result of results) {
    let payload = result.payload;
    const chunk = result.chunks.find((entry) => entry.id === "document");
    if (chunk && (result.type === "DataDefinition" || result.type === "Structure")) {
      try {
        const document: unknown = JSON.parse(new TextDecoder().decode(chunk.data));
        if (document && typeof document === "object" && !Array.isArray(document)) payload = document as Record<string, unknown>;
      }
      catch { /* An unreadable document is handled by its normal import validation. */ }
    }
    if (result.type === "DataObject" || result.type === "DataSheet") {
      throw new Error("Historical Data Object and Data Sheet assets cannot be imported with GUID collisions. Their original files have not been changed.");
    }
    if ((result.type === "DataDefinition" || result.type === "Structure") && Array.isArray(payload.fields)) definitions.set(result.guid, payload.fields);
  }
  const definitionFields: DataDefinitionFieldsResolver = (guid) => definitions.get(guid) ?? outsideDefinitionFields?.(guid);
  const references = (entries: readonly string[] | undefined) => entries?.map((entry) => remapReference(entry, remap));
  return results.map((result) => ({
    ...result,
    guid: remap.get(result.guid) ?? result.guid,
    dependencies: references(result.dependencies)!,
    requiredDependencies: references(result.requiredDependencies),
    classReferences: references(result.classReferences),
    requiredClassReferences: references(result.requiredClassReferences),
    chunks: result.chunks.map((chunk) => {
      if (chunk.id !== "document") return chunk;
      // The header is remapped, so a document left as it was would still
      // name the colliding guids: refuse the import instead.
      let mapped: Record<string, unknown>;
      try {
        mapped = remapPayload(result.type, JSON.parse(new TextDecoder().decode(chunk.data)), remap, definitionFields);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot give "${result.name}" (${result.type}) new asset ids: its document could not be read (${reason}). Nothing was imported.`, { cause: error });
      }
      return { ...chunk, data: new TextEncoder().encode(JSON.stringify(mapped)) };
    }),
    payload: remapPayload(result.type, result.payload, remap, definitionFields),
    attachToGuid: result.attachToGuid
      ? remap.get(result.attachToGuid) ?? result.attachToGuid
      : result.attachToGuid,
  }));
}
