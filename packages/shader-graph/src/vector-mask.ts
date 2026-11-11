import type { MaterialNodeDefinition } from "./catalog";
import type { MaterialGraphNode } from "./document";
import type { MaterialValueType } from "./types";

export const VECTOR_MASK_CHANNELS = ["r", "g", "b", "a"] as const;
/** A channel's display name. The Vector nodes (Combine, Split, Component Mask, Swizzle) all say X, Y, Z and W. */
export function vectorMaskChannelName(channel: (typeof VECTOR_MASK_CHANNELS)[number]): string {
  return "XYZW"[VECTOR_MASK_CHANNELS.indexOf(channel)]!;
}
export function vectorMaskChannels(properties: Record<string, unknown>) {
  return VECTOR_MASK_CHANNELS.filter((channel) => properties[channel] === true || channel === "r" && properties.r === undefined);
}
export function vectorMaskDefinition(node: MaterialGraphNode, base: MaterialNodeDefinition): MaterialNodeDefinition {
  const channels = vectorMaskChannels(node.properties);
  const kind: MaterialValueType = (["float", "float", "vec2", "vec3", "vec4"] as const)[channels.length]!;
  return { ...base, title: `Component Mask (${channels.map(vectorMaskChannelName).join("")})`, outputs: [{ id: "out", name: "Out", type: { kind }, ...(kind === "vec4" ? { colorHint: true } : {}) }] };
}
/** The Value pin is always Vector4, so only an empty channel selection can be wrong. */
export function vectorMaskError(properties: Record<string, unknown>): string | null {
  return vectorMaskChannels(properties).length ? null : "Component Mask requires at least one channel";
}

export const SWIZZLE_AXES = ["x", "y", "z", "w"] as const;
export type SwizzleAxis = (typeof SWIZZLE_AXES)[number];
const DEFAULT_SWIZZLE: readonly SwizzleAxis[] = ["x", "y", "z"];

function parseSwizzle(value: unknown): SwizzleAxis[] | null {
  if (value === undefined) return [...DEFAULT_SWIZZLE];
  if (typeof value !== "string" || value.length < 1 || value.length > 4) return null;
  const axes = [...value.toLowerCase()];
  return axes.every((axis): axis is SwizzleAxis => (SWIZZLE_AXES as readonly string[]).includes(axis)) ? axes : null;
}
/** A Swizzle node's Components property as axes in output order: XYZ when unset or not valid. */
export function swizzleComponents(properties: Record<string, unknown>): SwizzleAxis[] {
  return parseSwizzle(properties.components) ?? [...DEFAULT_SWIZZLE];
}
export function swizzleDefinition(node: MaterialGraphNode, base: MaterialNodeDefinition): MaterialNodeDefinition {
  const axes = swizzleComponents(node.properties);
  const kind: MaterialValueType = (["float", "float", "vec2", "vec3", "vec4"] as const)[axes.length]!;
  return { ...base, title: `Swizzle (${axes.join("").toUpperCase()})`, outputs: [{ id: "out", name: "Out", type: { kind } }] };
}
export function swizzleError(properties: Record<string, unknown>): string | null {
  return parseSwizzle(properties.components) ? null : "Swizzle needs one to four components, each X, Y, Z or W";
}
