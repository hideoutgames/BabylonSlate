import type { DataAssetCatalogEntry } from "@babylonslate/core";
import { mergeEngineTypeSchemas, type EnumSchema, type StructSchema, type TypeSchemas } from "./type-defaults";

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

