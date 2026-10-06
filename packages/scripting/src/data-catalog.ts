import type { DataAssetCatalogEntry } from "@babylonslate/core";
import { mergeEngineTypeSchemas, type EnumSchema, type StructSchema, type TypeSchemas } from "./type-defaults";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Collect schema snapshots once, before any graph reads. */
export function dataTypeSchemas(entries: readonly DataAssetCatalogEntry[]): TypeSchemas {
  const structs: Record<string, StructSchema> = Object.create(null);
  const dataDefinitions: Record<string, StructSchema> = Object.create(null);
  const enums: Record<string, EnumSchema> = Object.create(null);
  for (const entry of entries) {
    const payload = record(entry.payload);
    if (!payload) continue;
    if ((entry.type === "Structure" || entry.type === "DataDefinition") && Array.isArray(payload.fields)) {
      const fields = payload.fields.flatMap((raw) => {
        const field = record(raw);
        if (!field || typeof field.name !== "string" || !field.name || typeof field.typeId !== "string") return [];
        if (field.container !== undefined && field.container !== "single" && field.container !== "array" && field.container !== "map") return [];
        if (entry.type === "DataDefinition" && (typeof field.id !== "string" || !field.id)) return [];
        if ((field.required !== undefined && typeof field.required !== "boolean") ||
          (field.min !== undefined && typeof field.min !== "number") || (field.max !== undefined && typeof field.max !== "number")) return [];
        return [{
          name: field.name, typeId: field.typeId,
          ...(typeof field.id === "string" ? { id: field.id } : {}),
          ...(typeof field.typeClassId === "string" ? { typeClassId: field.typeClassId } : {}),
          ...(field.container ? { container: field.container as "single" | "array" | "map" } : {}),
          ...(typeof field.keyTypeId === "string" ? { keyTypeId: field.keyTypeId } : {}),
          ...(typeof field.keyTypeClassId === "string" ? { keyTypeClassId: field.keyTypeClassId } : {}),
          ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
          ...(typeof field.category === "string" ? { category: field.category } : {}),
          ...(typeof field.description === "string" ? { description: field.description } : {}),
          ...(typeof field.required === "boolean" ? { required: field.required } : {}),
          ...(typeof field.min === "number" ? { min: field.min } : {}),
          ...(typeof field.max === "number" ? { max: field.max } : {}),
        }];
      });
      // A malformed field must not silently disappear from the runtime type.
      if (fields.length === payload.fields.length) {
        const schema = { name: entry.name, fields };
        structs[entry.guid] = schema;
        if (entry.type === "DataDefinition") dataDefinitions[entry.guid] = schema;
      }
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
  return mergeEngineTypeSchemas({ structs, enums, dataDefinitions });
}
