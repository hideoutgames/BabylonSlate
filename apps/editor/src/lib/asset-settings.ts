import { shouldCompressTexture, TEXTURE_DOWNSAMPLE_OPTIONS } from "@babylonslate/assets";
import { newGuid } from "@babylonslate/core";
import { dataFieldIdentity } from "@babylonslate/scripting";
import type {
  EnumAsset,
  EnumMember,
  InterfaceMethod,
  ScriptInterfaceAsset,
  StructField,
  StructureAsset,
} from "@babylonslate/scripting";

export const TEXTURE_USAGE_OPTIONS = [
  "albedo",
  "normal",
  "pixelArt",
  "ui",
  "skybox",
  "particle",
  "colorGrading",
] as const;

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
  const names = new Set(asset.fields.map((field) => field.name));
  let name = "NewField";
  for (let suffix = 2; names.has(name); suffix++) name = `NewField${suffix}`;
  return {
    ...asset,
    fields: [...asset.fields, { id: newGuid(), name, typeId: "float" }],
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
    fields: asset.fields.map((field, i) => {
      if (i !== index) return field;
      const next = { ...field, ...patch, id: dataFieldIdentity(field) };
      // Soft is the absence of the property.
      if ("loading" in patch && patch.loading !== "hard") delete next.loading;
      return next;
    }),
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

export function patchTextureUsage(
  payload: Record<string, unknown>,
  usage: string,
): Record<string, unknown> {
  return { ...payload, usage };
}

/**
 * Usage edit. Entering or leaving Particle changes the chunk id (only
 * Particle keys its block alignment), so a compressible result re-encodes
 * with the new Usage. The size changes only for an atlas, which Particle
 * still aligns.
 */
export function applyTextureUsageChange(
  payload: Record<string, unknown>,
  usage: string,
): {
  payload: Record<string, unknown>;
  shouldRequeue: boolean;
} {
  const previous = String(payload.usage ?? "albedo");
  return {
    payload: patchTextureUsage(payload, usage),
    shouldRequeue:
      shouldCompressTexture(usage) &&
      (previous === "particle") !== (usage === "particle"),
  };
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
