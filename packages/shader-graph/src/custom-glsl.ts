import type { MaterialNodeDefinition } from "./catalog";
import type { MaterialGraphNode } from "./document";
import { componentCount, type MaterialValueType } from "./types";

export interface CustomGlslPin {
  id: string;
  name: string;
  type: Exclude<MaterialValueType, "texture">;
}

export interface CustomGlslInterface {
  inputs: CustomGlslPin[];
  outputs: CustomGlslPin[];
}

/** Pin IDs belong to graph links; names belong to the authored GLSL scope. */
export function customGlslInterface(properties: Record<string, unknown>): CustomGlslInterface | null {
  if (properties.customVersion !== 2) return null;
  const read = (value: unknown): CustomGlslPin[] => Array.isArray(value)
    ? value.filter((pin): pin is CustomGlslPin => !!pin && typeof pin === "object"
      && typeof pin.id === "string" && typeof pin.name === "string"
      && ["float", "vec2", "vec3", "vec4"].includes(pin.type))
    : [];
  return { inputs: read(properties.inputs), outputs: read(properties.outputs) };
}

export function newCustomGlslProperties(): Record<string, unknown> {
  return {
    customVersion: 2,
    inputs: [{ id: "a", name: "A", type: "float" }, { id: "b", name: "B", type: "float" }],
    outputs: [{ id: "out", name: "Result", type: "float" }],
    body: "return A + B;",
  };
}

export function customGlslDefinition(node: MaterialGraphNode, base: MaterialNodeDefinition): MaterialNodeDefinition {
  const pins = customGlslInterface(node.properties);
  if (!pins) return base;
  return {
    ...base,
    ...(/\b(dFdx|dFdy|fwidth)\b/.test(glslWithoutComments(String(node.properties.body ?? ""))) ? { requires: ["customGlsl", "derivatives"] as const } : {}),
    inputs: pins.inputs.map((pin) => ({ ...pin, type: { kind: pin.type }, defaultValue: Array(componentCount(pin.type)).fill(0) as number[] })),
    outputs: pins.outputs.map((pin) => ({ ...pin, type: { kind: pin.type } })),
    // Derivatives and discard cannot be evaluated by the vertex shader.
    ...(/\b(dFdx|dFdy|fwidth|discard)\b/.test(glslWithoutComments(String(node.properties.body ?? ""))) ? { stages: ["fragment"] as const } : {}),
  };
}

export function glslWithoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
}

const RESERVED = new Set("attribute const uniform varying layout centroid flat smooth noperspective break continue do for while switch case default if else in out inout float double int void bool true false invariant discard return mat2 mat3 mat4 vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uint uvec2 uvec3 uvec4 lowp mediump highp precision sampler2D samplerCube struct".split(" "));

export function customGlslInterfaceError(properties: Record<string, unknown>): string | null {
  const pins = customGlslInterface(properties);
  if (!pins) return null;
  if (!Array.isArray(properties.inputs) || !Array.isArray(properties.outputs)
    || pins.inputs.length !== properties.inputs.length || pins.outputs.length !== properties.outputs.length) {
    return "Custom GLSL pins must have an ID, variable name and Float or Vector type";
  }
  if (!pins.outputs.length) return "Custom GLSL needs a primary return output";
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const pin of [...pins.inputs, ...pins.outputs]) {
    if (!pin.id || ids.has(pin.id)) return "Custom GLSL pin IDs must be unique";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pin.name) || pin.name.startsWith("gl_") || pin.name.includes("__") || RESERVED.has(pin.name)) {
      return `“${pin.name}” is not an available GLSL variable name`;
    }
    if (names.has(pin.name)) return `Custom GLSL variable “${pin.name}” is declared more than once`;
    ids.add(pin.id);
    names.add(pin.name);
  }
  return null;
}

export function customGlslFunctionBodyError(body: string): string | null {
  if (!body.trim()) return "Custom GLSL needs a function body returning the primary output";
  if (body.length > 16384) return "Custom GLSL function bodies are limited to 16384 characters";
  const code = glslWithoutComments(body);
  if (/#|\b(uniform|attribute|varying|precision|layout|sampler\w*|gl_\w*)\b/.test(code)) {
    return "Use named input/output pins instead of shader globals, samplers or preprocessor directives";
  }
  if (!/\breturn\s+[^;\s]/.test(code)) return "Return a value for the primary output";
  let depth = 0;
  for (const char of code) {
    if (char === "{") depth++;
    if (char === "}" && --depth < 0) return "Custom GLSL has an unmatched closing brace";
  }
  return depth === 0 ? null : "Custom GLSL has an unmatched opening brace";
}
