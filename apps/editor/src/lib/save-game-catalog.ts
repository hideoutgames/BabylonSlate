import { validateSaveGameDefinition, type SaveGameDefinition } from "@haptic/core";
import type { TypeSchemas } from "@haptic/scripting";

type SaveAsset = { path: string; header: { guid?: string; type: string; payload?: Record<string, unknown> } };
type SaveDocument = { ref: { path?: string; kind: string }; content: unknown };

/** Default definition, including unsaved edits in its open asset document. */
export function defaultSaveGameDefinition(
  guid: string | null | undefined,
  assets: ReadonlyArray<SaveAsset>,
  documents: ReadonlyArray<SaveDocument>,
): SaveGameDefinition | undefined {
  if (!guid) return undefined;
  const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "SaveGame");
  if (!asset) return undefined;
  const open = documents.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === asset.path);
  try { return validateSaveGameDefinition(open?.content ?? asset.header.payload); }
  catch { return undefined; }
}

/** Registry headers omit document chunks; closed definitions must be loaded. */
export async function loadDefaultSaveGameDefinition(
  guid: string | null | undefined,
  assets: ReadonlyArray<SaveAsset>,
  documents: ReadonlyArray<SaveDocument>,
  loadAssetDocument: (kind: "save-game", path: string) => Promise<unknown>,
): Promise<SaveGameDefinition | undefined> {
  if (!guid) return undefined;
  const asset = assets.find((entry) => entry.header.guid === guid && entry.header.type === "SaveGame");
  if (!asset) return undefined;
  const open = documents.find((entry) => entry.ref.kind === "save-game" && entry.ref.path === asset.path);
  try { return validateSaveGameDefinition(open ? open.content : await loadAssetDocument("save-game", asset.path)); }
  catch { return undefined; }
}

const OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["object", "class", "delegate", "wildcard", "actor"]);

/**
 * Structures a Save Game field can hold: those whose fields, nested Structures included, carry no object,
 * class or delegate references, since a save stores plain values. Built-in ranges and curves qualify.
 */
export function saveableStructures<T extends { guid: string; name: string }>(
  structures: readonly T[],
  schemas: TypeSchemas,
): T[] {
  const verdicts = new Map<string, boolean>();
  const plain = (guid: string, visiting: ReadonlySet<string>): boolean => {
    const known = verdicts.get(guid);
    if (known !== undefined) return known;
    if (visiting.has(guid)) return true;
    const schema = schemas.structs[guid];
    if (!schema) return false;
    const next = new Set([...visiting, guid]);
    const result = schema.fields.every((field) => {
      if (OBJECT_TYPE_IDS.has(field.typeId) || (field.keyTypeId && OBJECT_TYPE_IDS.has(field.keyTypeId))) return false;
      if (field.typeId === "struct" && field.typeClassId && !plain(field.typeClassId, next)) return false;
      if (field.keyTypeId === "struct" && field.keyTypeClassId && !plain(field.keyTypeClassId, next)) return false;
      return true;
    });
    verdicts.set(guid, result);
    return result;
  };
  return structures.filter((entry) => plain(entry.guid, new Set())).sort((a, b) => a.name.localeCompare(b.name));
}
