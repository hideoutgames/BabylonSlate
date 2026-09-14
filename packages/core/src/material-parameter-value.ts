/** Serializable override of one named Material Graph parameter. */
export type MaterialParameterValue =
  | { kind: "float"; value: number }
  | { kind: "color"; value: [number, number, number, number] }
  | { kind: "texture"; textureAssetGuid: string | null };

/** Copies valid persisted values; invalid overrides leave the material default intact. */
export function normalizeMaterialParameterOverrides(value: unknown): Record<string, MaterialParameterValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, MaterialParameterValue]> = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!name.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const parameter = raw as Record<string, unknown>;
    if (parameter.kind === "float" && typeof parameter.value === "number" && Number.isFinite(parameter.value)) {
      entries.push([name, { kind: "float", value: parameter.value }]);
    } else if (parameter.kind === "color" && Array.isArray(parameter.value) && parameter.value.length === 4 &&
      [...parameter.value].every((channel) => typeof channel === "number" && Number.isFinite(channel))) {
      entries.push([name, { kind: "color", value: [...parameter.value] as [number, number, number, number] }]);
    } else if (parameter.kind === "texture" && (parameter.textureAssetGuid === null ||
      (typeof parameter.textureAssetGuid === "string" && parameter.textureAssetGuid.trim()))) {
      entries.push([name, { kind: "texture", textureAssetGuid: parameter.textureAssetGuid as string | null }]);
    }
  }
  return Object.fromEntries(entries);
}
