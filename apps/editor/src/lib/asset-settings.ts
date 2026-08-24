import { PIN_PICKER_TYPES } from "@babylonslate/editor-kit";
import { shouldCompressTexture, TEXTURE_DOWNSAMPLE_OPTIONS } from "@babylonslate/assets";
import type {
  EnumAsset,
  EnumMember,
  InterfaceMethod,
  InterfaceMethodPin,
  ScriptInterfaceAsset,
  StructField,
  StructureAsset,
} from "@babylonslate/scripting";

export const STRUCTURE_FIELD_TYPES = PIN_PICKER_TYPES;

export type StructureFieldType = (typeof STRUCTURE_FIELD_TYPES)[number];

export const TEXTURE_USAGE_OPTIONS = [
  "albedo",
  "normal",
  "pixelArt",
  "ui",
  "skybox",
] as const;

export type TextureUsage = (typeof TEXTURE_USAGE_OPTIONS)[number];

export const TEXTURE_DOWNSAMPLE_LABELS: Record<string, string> = {
  "1": "Full",
  "2": "1/2",
  "4": "1/4",
  "8": "1/8",
  "16": "1/16",
};

function moveIndex<T>(items: T[], index: number, delta: number): T[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  const current = next[index]!;
  next[index] = next[nextIndex]!;
  next[nextIndex] = current;
  return next;
}

export function addEnumMember(asset: EnumAsset): EnumAsset {
  const nextValue =
    asset.members.reduce((max, member) => Math.max(max, member.value), -1) + 1;
  return {
    ...asset,
    members: [...asset.members, { name: "NewMember", value: nextValue }],
  };
}

export function removeEnumMember(asset: EnumAsset, index: number): EnumAsset {
  return {
    ...asset,
    members: asset.members.filter((_, i) => i !== index),
  };
}

export function moveEnumMember(
  asset: EnumAsset,
  index: number,
  delta: number,
): EnumAsset {
  return { ...asset, members: moveIndex(asset.members, index, delta) };
}

export function patchEnumMember(
  asset: EnumAsset,
  index: number,
  patch: Partial<EnumMember>,
): EnumAsset {
  return {
    ...asset,
    members: asset.members.map((member, i) =>
      i === index ? { ...member, ...patch } : member,
    ),
  };
}

export function addStructureField(asset: StructureAsset): StructureAsset {
  return {
    ...asset,
    fields: [...asset.fields, { name: "NewField", typeId: "float" }],
  };
}

export function removeStructureField(
  asset: StructureAsset,
  index: number,
): StructureAsset {
  return {
    ...asset,
    fields: asset.fields.filter((_, i) => i !== index),
  };
}

export function moveStructureField(
  asset: StructureAsset,
  index: number,
  delta: number,
): StructureAsset {
  return { ...asset, fields: moveIndex(asset.fields, index, delta) };
}

export function patchStructureField(
  asset: StructureAsset,
  index: number,
  patch: Partial<StructField>,
): StructureAsset {
  return {
    ...asset,
    fields: asset.fields.map((field, i) =>
      i === index ? { ...field, ...patch } : field,
    ),
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

export function removeScriptInterfaceMethod(
  asset: ScriptInterfaceAsset,
  index: number,
): ScriptInterfaceAsset {
  return {
    ...asset,
    methods: asset.methods.filter((_, i) => i !== index),
  };
}

export function moveScriptInterfaceMethod(
  asset: ScriptInterfaceAsset,
  index: number,
  delta: number,
): ScriptInterfaceAsset {
  return { ...asset, methods: moveIndex(asset.methods, index, delta) };
}

export function patchScriptInterfaceMethod(
  asset: ScriptInterfaceAsset,
  index: number,
  patch: Partial<InterfaceMethod>,
): ScriptInterfaceAsset {
  return {
    ...asset,
    methods: asset.methods.map((method, i) =>
      i === index ? { ...method, ...patch } : method,
    ),
  };
}

export function addScriptInterfacePin(
  asset: ScriptInterfaceAsset,
  methodIndex: number,
  direction: "in" | "out",
): ScriptInterfaceAsset {
  const method = asset.methods[methodIndex];
  if (!method) return asset;
  const pin: InterfaceMethodPin = {
    name: direction === "out" ? "NewOutput" : "NewInput",
    typeId: "float",
    direction,
  };
  return patchScriptInterfaceMethod(asset, methodIndex, {
    pins: [...method.pins, pin],
  });
}

export function removeScriptInterfacePin(
  asset: ScriptInterfaceAsset,
  methodIndex: number,
  pinIndex: number,
): ScriptInterfaceAsset {
  const method = asset.methods[methodIndex];
  if (!method) return asset;
  return patchScriptInterfaceMethod(asset, methodIndex, {
    pins: method.pins.filter((_, i) => i !== pinIndex),
  });
}

export function moveScriptInterfacePin(
  asset: ScriptInterfaceAsset,
  methodIndex: number,
  pinIndex: number,
  delta: number,
): ScriptInterfaceAsset {
  const method = asset.methods[methodIndex];
  if (!method) return asset;
  return patchScriptInterfaceMethod(asset, methodIndex, {
    pins: moveIndex(method.pins, pinIndex, delta),
  });
}

export function patchScriptInterfacePin(
  asset: ScriptInterfaceAsset,
  methodIndex: number,
  pinIndex: number,
  patch: Partial<InterfaceMethodPin>,
): ScriptInterfaceAsset {
  const method = asset.methods[methodIndex];
  if (!method) return asset;
  return patchScriptInterfaceMethod(asset, methodIndex, {
    pins: method.pins.map((pin, i) =>
      i === pinIndex ? { ...pin, ...patch } : pin,
    ),
  });
}

export function patchTextureUsage(
  payload: Record<string, unknown>,
  usage: string,
): Record<string, unknown> {
  return { ...payload, usage };
}

export function patchTextureDownsample(
  payload: Record<string, unknown>,
  value: string | number | undefined,
): Record<string, unknown> {
  const parsed = typeof value === "number" ? value : Number(value);
  const next = { ...payload };
  delete next.maxDimension;
  if (!TEXTURE_DOWNSAMPLE_OPTIONS.includes(parsed as (typeof TEXTURE_DOWNSAMPLE_OPTIONS)[number])) {
    delete next.downsample;
    return next;
  }
  if (parsed === 1) {
    delete next.downsample;
    return next;
  }
  return { ...next, downsample: parsed };
}

export function textureDownsampleSelectValue(
  payload: Record<string, unknown>,
): string {
  const value = payload.downsample;
  if (typeof value === "number" && value > 1) return String(value);
  return "1";
}

export function applyTextureDownsampleChange(
  payload: Record<string, unknown>,
  value: string,
): {
  payload: Record<string, unknown>;
  shouldRequeue: boolean;
} {
  const next = patchTextureDownsample(payload, value);
  const usage = String(payload.usage ?? "albedo");
  return {
    payload: next,
    shouldRequeue: shouldCompressTexture(usage),
  };
}

export function applyTextureCompressionQualityChange(
  payload: Record<string, unknown>,
  value: number,
): {
  payload: Record<string, unknown>;
  shouldRequeue: boolean;
} {
  const quality = Number.isFinite(value) ? value : 2;
  const usage = String(payload.usage ?? "albedo");
  return {
    payload: { ...payload, compressionQuality: quality },
    shouldRequeue: shouldCompressTexture(usage),
  };
}
