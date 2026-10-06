import { isDataObjectAsset, isDataSheetAsset, type DataAssetCatalogEntry } from "@babylonslate/core";
import { mergeEngineTypeSchemas, resolveDataObjectValues, type EnumSchema, type StructSchema, type TypeSchemas } from "@babylonslate/scripting";

/** Read-only game data. Values and ordered membership are detached on every read. */
export interface RuntimeDataApi {
  readObject(reference: unknown, structureGuid?: string): Record<string, unknown> | null;
  getSheetObjects(reference: unknown, structureGuid?: string): string[];
  hasObject(reference: unknown, structureGuid?: string): boolean;
  hasSheet(reference: unknown, structureGuid?: string): boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Collect schema snapshots once, before any graph reads. */
export function dataTypeSchemas(entries: readonly DataAssetCatalogEntry[]): TypeSchemas {
  const structs: Record<string, StructSchema> = Object.create(null);
  const enums: Record<string, EnumSchema> = Object.create(null);
  for (const entry of entries) {
    const payload = record(entry.payload);
    if (!payload) continue;
    if (entry.type === "Structure" && Array.isArray(payload.fields)) {
      const fields = payload.fields.flatMap((raw) => {
        const field = record(raw);
        if (!field || typeof field.name !== "string" || !field.name || typeof field.typeId !== "string") return [];
        if (field.container !== undefined && field.container !== "single" && field.container !== "array" && field.container !== "map") return [];
        return [{
          name: field.name, typeId: field.typeId,
          ...(typeof field.id === "string" ? { id: field.id } : {}),
          ...(typeof field.typeClassId === "string" ? { typeClassId: field.typeClassId } : {}),
          ...(field.container ? { container: field.container as "single" | "array" | "map" } : {}),
          ...(typeof field.keyTypeId === "string" ? { keyTypeId: field.keyTypeId } : {}),
          ...(typeof field.keyTypeClassId === "string" ? { keyTypeClassId: field.keyTypeClassId } : {}),
          ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
        }];
      });
      // A malformed field must not silently disappear from the runtime type.
      if (fields.length === payload.fields.length) structs[entry.guid] = { name: entry.name, fields };
    }
    if (entry.type === "Enum" && Array.isArray(payload.members)) {
      const members = payload.members.flatMap((raw) => {
        const member = record(raw);
        return member && typeof member.name === "string" && typeof member.value === "number" && Number.isFinite(member.value)
          ? [{ name: member.name, value: member.value }] : [];
      });
      if (members.length === payload.members.length) enums[entry.guid] = { name: entry.name, members };
    }
  }
  return mergeEngineTypeSchemas({ structs, enums });
}

/**
 * Constructed per Play/player session. Validates and projects each object once;
 * graph evaluation performs only GUID map lookups and copies the requested value.
 * Shared configuration never becomes a writable runtime object.
 */
export class RuntimeDataCatalog implements RuntimeDataApi {
  private readonly objects = new Map<string, { structureGuid: string; values: Record<string, unknown> }>();
  private readonly sheets = new Map<string, { structureGuid: string; objectGuids: string[] }>();

  constructor(entries: readonly DataAssetCatalogEntry[] = []) {
    const schemas = dataTypeSchemas(entries);
    for (const entry of entries) {
      if (entry.type !== "DataObject" || !isDataObjectAsset(entry.payload) || !entry.payload.structureGuid) continue;
      try {
        const values = resolveDataObjectValues(entry.payload, schemas);
        if (values !== null) this.objects.set(entry.guid, { structureGuid: entry.payload.structureGuid, values });
      } catch {
        // Malformed external payloads fail Found without aborting unrelated data.
      }
    }
    for (const entry of entries) {
      if (entry.type !== "DataSheet" || !isDataSheetAsset(entry.payload)) continue;
      const { structureGuid, objectGuids } = entry.payload;
      if (!structureGuid || !schemas.structs[structureGuid]) continue;
      // Never shift row positions or silently conceal corrupt membership.
      if (new Set(objectGuids).size !== objectGuids.length || objectGuids.some((guid) => this.objects.get(guid)?.structureGuid !== structureGuid)) continue;
      this.sheets.set(entry.guid, { structureGuid, objectGuids: [...objectGuids] });
    }
  }

  hasObject(reference: unknown, structureGuid?: string): boolean {
    const object = typeof reference === "string" ? this.objects.get(reference) : undefined;
    return !!object && (!structureGuid || object.structureGuid === structureGuid);
  }

  readObject(reference: unknown, structureGuid?: string): Record<string, unknown> | null {
    if (!this.hasObject(reference, structureGuid)) return null;
    return structuredClone(this.objects.get(reference as string)!.values);
  }

  hasSheet(reference: unknown, structureGuid?: string): boolean {
    const sheet = typeof reference === "string" ? this.sheets.get(reference) : undefined;
    return !!sheet && (!structureGuid || sheet.structureGuid === structureGuid);
  }

  getSheetObjects(reference: unknown, structureGuid?: string): string[] {
    if (!this.hasSheet(reference, structureGuid)) return [];
    return [...this.sheets.get(reference as string)!.objectGuids];
  }
}
