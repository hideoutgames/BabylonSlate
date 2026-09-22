import type { MaterialNodeDefinition } from "./catalog";
import type { MaterialGraphNode } from "./document";
import { isNumericType, type MaterialValueType } from "./types";

export const VECTOR_MASK_CHANNELS = ["r", "g", "b", "a"] as const;
export function vectorMaskChannels(properties: Record<string, unknown>) {
  return VECTOR_MASK_CHANNELS.filter((channel) => properties[channel] === true || channel === "r" && properties.r === undefined);
}
export function vectorMaskDefinition(node: MaterialGraphNode, base: MaterialNodeDefinition): MaterialNodeDefinition {
  const channels = vectorMaskChannels(node.properties);
  const kind: MaterialValueType = (["float", "float", "vec2", "vec3", "vec4"] as const)[channels.length]!;
  return { ...base, title: `VectorMask(${channels.join("").toUpperCase()})`, outputs: [{ id: "out", name: "Out", type: { kind }, ...(kind === "vec4" ? { colorHint: true } : {}) }] };
}
export function vectorMaskError(properties: Record<string, unknown>, input: MaterialValueType | null): string | null {
  const channels = vectorMaskChannels(properties);
  if (!channels.length) return "VectorMask requires at least one channel";
  return input && isNumericType(input) ? null : "VectorMask requires a numeric input";
}
