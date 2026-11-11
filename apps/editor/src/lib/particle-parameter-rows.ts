import type { PropertyRow } from "@haptic/editor-kit";
import { resizeGlobalParameterValue, type GlobalParameterType } from "@haptic/core";

/**
 * One parameter value as a PropertyGrid row of its type, for a Particle Graph parameter or a Global Parameter (the only
 * one with a Vector4). `onChange` receives the value sized to `type`.
 */
export function particleParameterValueRow(options: {
  id: string;
  label: string;
  type: GlobalParameterType;
  value: readonly number[];
  defaultValue?: readonly number[];
  description?: string;
  onChange: (value: number[]) => void;
}): PropertyRow {
  const { id, label, type, description } = options;
  const [x = 0, y = 0, z = 0, w = type === "color" ? 1 : 0] = resizeGlobalParameterValue(options.value, type);
  const fallback = options.defaultValue ? resizeGlobalParameterValue(options.defaultValue, type) : undefined;
  const base = { id, label, ...(description ? { description } : {}) };
  switch (type) {
    case "float":
      return { ...base, kind: "number", value: x, defaultValue: fallback?.[0], onChange: (next) => options.onChange([next]) };
    case "vec2":
      return { ...base, kind: "vector3", axes: ["X", "Y"], value: [x, y, 0],
        defaultValue: fallback ? [fallback[0]!, fallback[1]!, 0] : undefined, onChange: (next) => options.onChange([next[0], next[1]]) };
    case "vec3":
      return { ...base, kind: "vector3", value: [x, y, z],
        defaultValue: fallback ? [fallback[0]!, fallback[1]!, fallback[2]!] : undefined, onChange: (next) => options.onChange([...next]) };
    case "vec4":
      return { ...base, kind: "vector3", axes: ["X", "Y", "Z", "W"], value: [x, y, z, w],
        defaultValue: fallback ? [fallback[0]!, fallback[1]!, fallback[2]!, fallback[3]!] : undefined, onChange: (next) => options.onChange([...next]) };
    case "color":
      return { ...base, kind: "color4", value: [x, y, z, w],
        defaultValue: fallback ? [fallback[0]!, fallback[1]!, fallback[2]!, fallback[3]!] : undefined, onChange: (next) => options.onChange([...next]) };
  }
}

/** A new parameter id: stable across renames, so Parameter nodes and gameplay overrides keep it. */
export function newParticleParameterId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `param-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
