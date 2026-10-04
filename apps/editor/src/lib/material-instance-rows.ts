import type { MaterialParameterValue } from "@babylonslate/core";
import type { PropertyRow, assetRowIdentity } from "@babylonslate/editor-kit";
import type { MaterialInstanceDocument } from "@babylonslate/shader-graph";

function sameValue(a: MaterialParameterValue, b: MaterialParameterValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "float") return a.value === (b as typeof a).value;
  if (a.kind === "texture") return a.textureAssetGuid === (b as typeof a).textureAssetGuid;
  return a.value.every((channel, index) => channel === (b as typeof a).value[index]);
}

/**
 * Set or clear one override. A value equal to the inherited one clears it, so
 * Reset (and editing back to the parent's value) resumes following the parent.
 */
export function setMaterialInstanceOverride(
  document: MaterialInstanceDocument,
  name: string,
  value: MaterialParameterValue | null,
  inherited: MaterialParameterValue,
): MaterialInstanceDocument {
  const overrides = { ...document.overrides };
  if (!value || sameValue(value, inherited)) delete overrides[name];
  else overrides[name] = value;
  return { ...document, overrides };
}

/** Overrides whose parameter the root Material no longer exposes with that kind. */
export function unusedMaterialInstanceOverrides(
  document: MaterialInstanceDocument,
  parameters: ReadonlyArray<{ name: string; inherited: MaterialParameterValue }>,
): string[] {
  return Object.entries(document.overrides)
    .filter(([name, value]) => !parameters.some((parameter) => parameter.name === name && parameter.inherited.kind === value.kind))
    .map(([name]) => name)
    .sort();
}

export function materialInstanceParameterRows(
  document: MaterialInstanceDocument,
  parameters: ReadonlyArray<{ name: string; inherited: MaterialParameterValue }>,
  options: {
    commit: (next: MaterialInstanceDocument, mergeKey?: string) => void;
    textureIdentity: (guid: string) => ReturnType<typeof assetRowIdentity>;
    onPickTexture: (name: string) => void;
  },
): PropertyRow[] {
  return parameters.map(({ name, inherited }): PropertyRow => {
    const own = document.overrides[name];
    const current = own?.kind === inherited.kind ? own : inherited;
    const set = (value: MaterialParameterValue | null, mergeKey?: string) =>
      options.commit(setMaterialInstanceOverride(document, name, value, inherited), mergeKey);
    const base = {
      id: `parameter-${name}`,
      label: name,
      testId: `material-instance-parameter-${name}`,
      description: own?.kind === inherited.kind ? "Overridden" : undefined,
    };
    if (inherited.kind === "float") {
      return {
        ...base,
        kind: "number",
        value: (current as typeof inherited).value,
        defaultValue: inherited.value,
        onChange: (value) => set({ kind: "float", value }, `material-instance:${name}`),
      };
    }
    if (inherited.kind === "color") {
      return {
        ...base,
        kind: "color4",
        value: [...(current as typeof inherited).value],
        defaultValue: [...inherited.value],
        onChange: (value) => set({ kind: "color", value: [...value] }, `material-instance:${name}`),
      };
    }
    const guid = (current as typeof inherited).textureAssetGuid;
    return {
      ...base,
      kind: "asset",
      value: guid,
      defaultValue: inherited.textureAssetGuid,
      placeholder: "None",
      ...(guid ? options.textureIdentity(guid) : {}),
      onPick: () => options.onPickTexture(name),
      onChange: (textureAssetGuid) => set({ kind: "texture", textureAssetGuid }),
    };
  });
}
