import { isDataDefinitionAsset, isDataSheetRow, type DataAssetCatalogEntry } from "@babylonslate/core";
import { dataTypeSchemas, resolveDataRowValues, validateDataDefinition } from "@babylonslate/scripting";

export { dataTypeSchemas } from "@babylonslate/scripting";

/** Read-only sheet data. Row values and ordered IDs are detached on every read. */
export interface RuntimeDataApi {
  readRow(sheet: unknown, rowId: unknown, definitionGuid?: string): Record<string, unknown> | null;
  getSheetRows(sheet: unknown, definitionGuid?: string): string[];
  hasRow(sheet: unknown, rowId: unknown, definitionGuid?: string): boolean;
  hasSheet(sheet: unknown, definitionGuid?: string): boolean;
}

type RuntimeSheet = {
  definitionGuid: string;
  rowIds: string[];
  rows: Map<string, Record<string, unknown>>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Constructed once per Play/player session. Each sheet owns its row identities;
 * validation and projection happen at load, so graph reads need only indexed
 * lookups and a copy of the requested value. No asset I/O occurs during reads.
 */
export class RuntimeDataCatalog implements RuntimeDataApi {
  private readonly sheets = new Map<string, RuntimeSheet>();

  constructor(entries: readonly DataAssetCatalogEntry[] = []) {
    const schemas = dataTypeSchemas(entries);
    const definitions = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== "DataDefinition" || !isDataDefinitionAsset(entry.payload)) continue;
      try {
        if (!validateDataDefinition(entry.payload, schemas, entry.guid).some((issue) => issue.severity === "error")) {
          definitions.add(entry.guid);
        }
      } catch {
        // Malformed external schemas must not abort unrelated Definitions.
      }
    }
    for (const entry of entries) {
      const payload = entry.payload;
      if (entry.type !== "DataSheet" || !record(payload) || payload.kind !== "dataSheet" || !Array.isArray(payload.rows)) continue;
      const { definitionGuid, rows } = payload;
      if (typeof definitionGuid !== "string" || !definitions.has(definitionGuid) || !schemas.structs[definitionGuid]) continue;
      const rowIds = rows.map((row) => record(row) && typeof row.id === "string" ? row.id : "");
      // Ambiguous identities cannot be resolved safely; never silently reindex.
      if (rowIds.some((id) => !id || id.trim() !== id) || new Set(rowIds).size !== rowIds.length) continue;
      const valuesById = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        if (!isDataSheetRow(row)) continue;
        try {
          const values = resolveDataRowValues(row, definitionGuid, schemas);
          if (values !== null) valuesById.set(row.id, values);
        } catch {
          // One malformed external row must not hide unrelated rows.
        }
      }
      this.sheets.set(entry.guid, { definitionGuid, rowIds, rows: valuesById });
    }
  }

  hasRow(sheet: unknown, rowId: unknown, definitionGuid?: string): boolean {
    return typeof rowId === "string" && this.hasSheet(sheet, definitionGuid) &&
      this.sheets.get(sheet as string)!.rows.has(rowId);
  }

  readRow(sheet: unknown, rowId: unknown, definitionGuid?: string): Record<string, unknown> | null {
    if (!this.hasRow(sheet, rowId, definitionGuid)) return null;
    return structuredClone(this.sheets.get(sheet as string)!.rows.get(rowId as string)!);
  }

  hasSheet(sheet: unknown, definitionGuid?: string): boolean {
    const entry = typeof sheet === "string" ? this.sheets.get(sheet) : undefined;
    return !!entry && (!definitionGuid || entry.definitionGuid === definitionGuid);
  }

  getSheetRows(sheet: unknown, definitionGuid?: string): string[] {
    if (!this.hasSheet(sheet, definitionGuid)) return [];
    return [...this.sheets.get(sheet as string)!.rowIds];
  }
}
