import type {
  EnumAsset,
  ScriptInterfaceAsset,
  StructureAsset,
} from "@babylonslate/scripting";

export const STRUCTURE_FIELD_TYPES = [
  "float",
  "int",
  "bool",
  "string",
  "enum",
] as const;

export type StructureFieldType = (typeof STRUCTURE_FIELD_TYPES)[number];

export const TEXTURE_USAGE_OPTIONS = [
  "albedo",
  "normal",
  "pixelArt",
  "ui",
] as const;

export type TextureUsage = (typeof TEXTURE_USAGE_OPTIONS)[number];

export function addEnumMember(asset: EnumAsset): EnumAsset {
  const nextValue = asset.members.reduce(
    (max, member) => Math.max(max, member.value),
    -1,
  ) + 1;
  return {
    ...asset,
    members: [...asset.members, { name: "NewMember", value: nextValue }],
  };
}

export function addStructureField(asset: StructureAsset): StructureAsset {
  return {
    ...asset,
    fields: [...asset.fields, { name: "NewField", typeId: "float" }],
  };
}

export function addScriptInterfaceMethod(
  asset: ScriptInterfaceAsset,
): ScriptInterfaceAsset {
  return {
    ...asset,
    methods: [...asset.methods, { name: "NewMethod", pins: [] }],
  };
}

export function patchTextureUsage(
  payload: Record<string, unknown>,
  usage: string,
): Record<string, unknown> {
  return { ...payload, usage };
}
