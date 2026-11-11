/** Serializable override of one named Material Graph parameter. */
export type MaterialParameterValue =
  | { kind: "float"; value: number }
  | { kind: "vec2"; value: [number, number] }
  | { kind: "vec3"; value: [number, number, number] }
  | { kind: "vec4"; value: [number, number, number, number] }
  | { kind: "color"; value: [number, number, number, number] }
  | { kind: "texture"; textureAssetGuid: string | null };

/** Scene-owned values for one component's selected surface Material instance. */
export interface MaterialInstanceOverrides {
  materialGuid: string;
  parameters: Record<string, MaterialParameterValue>;
}

export function normalizeMaterialInstanceOverrides(value: unknown): MaterialInstanceOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.materialGuid !== "string" || !source.materialGuid.trim()) return undefined;
  const parameters = normalizeMaterialParameterOverrides(source.parameters);
  return Object.keys(parameters).length ? { materialGuid: source.materialGuid.trim(), parameters } : undefined;
}

/** A copy that shares no array with `value`. */
export function copyMaterialParameterValue(value: MaterialParameterValue): MaterialParameterValue {
  return value.kind === "texture" || value.kind === "float"
    ? { ...value }
    : ({ ...value, value: [...value.value] } as MaterialParameterValue);
}

/** Whether `value` is a valid value of its kind; a texture guid is not checked against assets. */
export function isFiniteMaterialParameterValue(value: MaterialParameterValue): boolean {
  switch (value.kind) {
    case "float":
      return typeof value.value === "number" && Number.isFinite(value.value);
    case "vec2":
      return finiteNumbers(value.value, 2);
    case "vec3":
      return finiteNumbers(value.value, 3);
    case "vec4":
    case "color":
      return finiteNumbers(value.value, 4);
    case "texture":
      return value.textureAssetGuid === null || typeof value.textureAssetGuid === "string";
  }
}

function finiteNumbers(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** Copies valid persisted values; invalid overrides leave the material default intact. */
export function normalizeMaterialParameterOverrides(value: unknown): Record<string, MaterialParameterValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, MaterialParameterValue]> = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!name.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const parameter = raw as Record<string, unknown>;
    if (parameter.kind === "float" && typeof parameter.value === "number" && Number.isFinite(parameter.value)) {
      entries.push([name, { kind: "float", value: parameter.value }]);
    } else if (parameter.kind === "vec2" && finiteNumbers(parameter.value, 2)) {
      entries.push([name, { kind: "vec2", value: [...parameter.value] as [number, number] }]);
    } else if (parameter.kind === "vec3" && finiteNumbers(parameter.value, 3)) {
      entries.push([name, { kind: "vec3", value: [...parameter.value] as [number, number, number] }]);
    } else if ((parameter.kind === "vec4" || parameter.kind === "color") && finiteNumbers(parameter.value, 4)) {
      entries.push([name, { kind: parameter.kind, value: [...parameter.value] as [number, number, number, number] }]);
    } else if (parameter.kind === "texture" && (parameter.textureAssetGuid === null ||
      (typeof parameter.textureAssetGuid === "string" && parameter.textureAssetGuid.trim()))) {
      entries.push([name, { kind: "texture", textureAssetGuid: parameter.textureAssetGuid as string | null }]);
    }
  }
  return Object.fromEntries(entries);
}
