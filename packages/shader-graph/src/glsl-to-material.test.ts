import { describe, expect, it } from "vitest";
import { convertGlslToMaterial } from "./glsl-to-material";
import { normalizeMaterialDocument, type MaterialDocument } from "./document";
import { lowerMaterialDocument, type MaterialOperand } from "./lower";
import { convertMaterialValue } from "./types";
import { validateMaterialDocument } from "./validate";
import { materialGraphToSerialized, serializedToMaterialGraph } from "./serialize-material";

function converted(source: string, bindings?: Record<string, "uv" | "time">): MaterialDocument {
  const result = convertGlslToMaterial(source, { name: "Imported Shader", bindings });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) throw new Error("Conversion failed");
  return result.document;
}

/** Evaluate the small arithmetic fixture through the real lowered operand contract. */
function rgba(document: MaterialDocument): number[] {
  const lowered = lowerMaterialDocument(document);
  expect(lowered.ok).toBe(true);
  if (!lowered.ok) throw new Error("Lowering failed");
  const values = new Map<string, Record<string, number[]>>();
  const read = (operand: MaterialOperand | null | undefined): number[] => {
    if (!operand) throw new Error("Missing fixture operand");
    if (operand.kind === "constant") return operand.value;
    const value = values.get(operand.operationId)?.[operand.pinId];
    if (!value) throw new Error(`Unresolved fixture operand ${operand.operationId}.${operand.pinId}`);
    return (operand.conversions ?? []).reduce<number[]>(convertMaterialValue, value);
  };
  for (const operation of lowered.plan.operations) {
    const input = (name: string) => read(operation.inputs[name]);
    let outputs: Record<string, number[]>;
    if (operation.nodeType === "const.float" || operation.nodeType === "param.float") {
      outputs = { out: operation.properties.value as number[] };
    } else if (operation.nodeType === "vector.combine") {
      const value = ["x", "y", "z", "w"].map((name) => input(name)[0]!);
      outputs = { xy: value.slice(0, 2), xyz: value.slice(0, 3), xyzw: value };
    } else if (operation.nodeType === "vector.split") {
      outputs = Object.fromEntries(["x", "y", "z", "w"].map((name, index) => [name, [input("value")[index]!]]));
    } else if (operation.nodeType === "math.negate") {
      outputs = { out: input("value").map((value) => -value) };
    } else if (["math.add", "math.subtract", "math.multiply", "math.divide"].includes(operation.nodeType)) {
      outputs = { out: input("a").map((left, index) => {
        const right = input("b")[index]!;
        if (operation.nodeType === "math.add") return left + right;
        if (operation.nodeType === "math.subtract") return left - right;
        if (operation.nodeType === "math.multiply") return left * right;
        return left / right;
      }) };
    } else throw new Error(`Unexpected arithmetic fixture node ${operation.nodeType}`);
    values.set(operation.id, outputs);
  }
  return [...read(lowered.plan.outputs.baseColor), ...read(lowered.plan.outputs.opacity)];
}

describe("experimental GLSL to ordinary Material nodes", () => {
  it("preserves arithmetic precedence, scalar splats, reassignment and repeated/reordered swizzles through save and graph editing", () => {
    const document = converted(`
      precision mediump float;
      void main() {
        vec3 color = vec3(0.1, 0.2, 0.3);
        vec3 previous = color;
        color *= 2.0;
        color = color + 0.1 * 2.0;
        gl_FragColor = vec4(color.bgr + previous.xxx, 0.25);
      }
    `);
    const reopened = normalizeMaterialDocument(JSON.parse(JSON.stringify(document)));
    const edited = serializedToMaterialGraph(materialGraphToSerialized(reopened), reopened);
    const result = rgba(edited);
    expect(result[0]).toBeCloseTo(0.9);
    expect(result[1]).toBeCloseTo(0.7);
    expect(result[2]).toBeCloseTo(0.5);
    expect(result[3]).toBe(0.25);
    expect(edited.shadingModel).toBe("unlit");
    expect(edited.blendMode).toBe("translucent");
    expect(validateMaterialDocument(edited, { capabilities: { customGlsl: false } })).toEqual([]);
  });

  it("creates editable numeric uniform components without color-space conversion", () => {
    const document = converted(`#version 300 es
      precision highp float;
      uniform float gain;
      uniform vec3 tint;
      out vec4 fragColor;
      void main(void) { fragColor = vec4(tint * gain, 1.0); }
    `);
    expect(rgba(document)).toEqual([0, 0, 0, 1]);
    const authored: Record<string, number> = { gain: 0.5, "tint.x": 0.2, "tint.y": 0.4, "tint.z": 0.8 };
    for (const node of document.nodes) {
      if (node.type === "param.float") node.properties.value = [authored[String(node.properties.name)]!];
    }
    expect(rgba(document)).toEqual([0.1, 0.2, 0.4, 1]);
    const lowered = lowerMaterialDocument(document);
    expect(lowered.ok && lowered.plan.cost.customBlocks).toBe(0);
  });

  it("lowers explicitly bound UV/time and supported native builtins without a GLSL runtime dependency", () => {
    const document = converted(`
      varying vec2 vUV;
      uniform float uTime;
      void main() {
        vec2 wave = sin(vUV * 2.0 + uTime);
        float intensity = clamp(dot(wave, wave), 0.0, 1.0);
        vec3 color = mix(vec3(0.1), vec3(0.9), intensity);
        gl_FragColor = vec4(color, smoothstep(0.0, 1.0, intensity));
      }
    `, { vUV: "uv", uTime: "time" });
    expect(validateMaterialDocument(document, { capabilities: { customGlsl: false } })).toEqual([]);
    const lowered = lowerMaterialDocument(document);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.plan.cost.customBlocks).toBe(0);
    expect(lowered.plan.operations.some((operation) => operation.nodeType === "input.uv")).toBe(true);
    expect(lowered.plan.operations.some((operation) => operation.nodeType === "input.time")).toBe(true);
    expect(lowered.plan.operations.some((operation) => operation.nodeType.startsWith("param."))).toBe(false);
  });

  it("accepts constant constructors, separated unary signs and names overlapping JavaScript object properties", () => {
    const document = converted(`
      const vec3 color = vec3(1, 0, 1);
      void main() {
        float constructor = float(+ +1);
        gl_FragColor = vec4(- -color.zyx, constructor);
      }
    `);
    expect(rgba(document)).toEqual([1, 0, 1, 1]);
  });

  it.each([
    ["control flow", "void main() { if (true) { gl_FragColor = vec4(1.0); } }"],
    ["integer division", "void main() { gl_FragColor = vec4(1 / 2); }"],
    ["prefix increment", "void main() { float value = 0.0; gl_FragColor = vec4(++value); }"],
    ["prefix decrement", "void main() { float value = 1.0; gl_FragColor = vec4(--value); }"],
    ["postfix increment", "void main() { float value = 0.0; float next = value+++1.0; gl_FragColor = vec4(value + next); }"],
    ["postfix decrement", "void main() { float value = 1.0; float next = value---1.0; gl_FragColor = vec4(value + next); }"],
    ["octal constructor literal", "void main() { gl_FragColor = vec4(010); }"],
    ["float overflow", "void main() { gl_FragColor = vec4(1e100); }"],
    ["width mismatch", "void main() { gl_FragColor = vec4(vec2(1.0) + vec3(1.0), 1.0); }"],
    ["uninitialized local", "void main() { float value; gl_FragColor = vec4(value); }"],
    ["out-of-range swizzle", "void main() { gl_FragColor = vec4(vec2(1.0).z); }"],
    ["mixed swizzle alphabets", "void main() { gl_FragColor = vec4(vec2(1.0).xr, 0.0, 1.0); }"],
    ["sampler", "uniform sampler2D image; void main() { gl_FragColor = vec4(1.0); }"],
    ["unbound varying", "varying vec2 uv; void main() { gl_FragColor = vec4(uv, 0.0, 1.0); }"],
    ["write to uniform", "uniform float gain; void main() { gain = 1.0; gl_FragColor = vec4(gain); }"],
    ["nonconstant const", "uniform float gain; void main() { const float value = gain; gl_FragColor = vec4(value); }"],
    ["wrong builtin arity", "void main() { gl_FragColor = vec4(sin()); }"],
    ["undefined helper", "void main() { gl_FragColor = vec4(noise(1.0)); }"],
    ["shader global", "void main() { gl_FragColor = gl_FragCoord; }"],
    ["component assignment", "void main() { vec4 color = vec4(1.0); color.x = 0.0; gl_FragColor = color; }"],
    ["missing output", "void main() { float value = 1.0; }"],
  ])("rejects %s without returning a partial Material", (_name, source) => {
    const result = convertGlslToMaterial(`// first line\n${source}`);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("document");
    expect(result.diagnostics[0]).toMatchObject({ severity: "error", line: 2 });
  });

  it("reports macro/comment locations and bounded nesting instead of evaluating or hanging", () => {
    const macro = convertGlslToMaterial("/* line one\nline two */\n#define COLOR vec4(1.0)\nvoid main() { gl_FragColor = COLOR; }");
    expect(macro).toMatchObject({ ok: false, diagnostics: [{ line: 3, severity: "error" }] });
    expect(convertGlslToMaterial("/* unfinished")).toMatchObject({ ok: false, diagnostics: [{ line: 1 }] });
    expect(convertGlslToMaterial(`void main() { gl_FragColor = vec4(${"(".repeat(100)}1.0${")".repeat(100)}); }`).ok).toBe(false);
    expect(convertGlslToMaterial(" ".repeat(32769)).ok).toBe(false);
  });

  it("rejects absent or incorrectly typed bindings instead of guessing source semantics", () => {
    expect(convertGlslToMaterial("void main() { gl_FragColor = vec4(1.0); }", { bindings: { vUV: "uv" } }).ok).toBe(false);
    expect(convertGlslToMaterial("uniform vec3 uTime; void main() { gl_FragColor = vec4(uTime, 1.0); }", { bindings: { uTime: "time" } }).ok).toBe(false);
  });
});
