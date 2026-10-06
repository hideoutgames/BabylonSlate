import { isDataObjectAsset, isDataSheetAsset, type DataAssetCatalogEntry } from "@babylonslate/core";
import { dataTypeSchemas, resolveDataObjectValues } from "@babylonslate/scripting";

export { dataTypeSchemas } from "@babylonslate/scripting";

/** Read-only game data. Values and ordered membership are detached on every read. */
export interface RuntimeDataApi {
  readObject(reference: unknown, structureGuid?: string): Record<string, unknown> | null;
  getSheetObjects(reference: unknown, structureGuid?: string): string[];
  hasObject(reference: unknown, structureGuid?: string): boolean;
  hasSheet(reference: unknown, structureGuid?: string): boolean;
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
