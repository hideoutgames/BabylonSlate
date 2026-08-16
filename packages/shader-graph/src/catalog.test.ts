import { describe, expect, it } from "vitest";
import {
  MATERIAL_CATALOG,
  materialNodeDefinition,
  materialPaletteEntries,
  nodeIsLegalInDomain,
} from "./catalog";

/** GLSL ES 1.00/3.00 builtins the plan requires as first-class nodes. */
const REQUIRED_GLSL_NODES = [
  "math.add",
  "math.subtract",
  "math.multiply",
  "math.divide",
  "math.negate",
  "math.reciprocal",
  "math.radians",
  "math.degrees",
  "math.sin",
  "math.cos",
  "math.tan",
  "math.asin",
  "math.acos",
  "math.atan",
  "math.atan2",
  "math.pow",
  "math.exp",
  "math.exp2",
  "math.log",
  "math.log2",
  "math.sqrt",
  "math.inverseSqrt",
  "math.abs",
  "math.sign",
  "math.floor",
  "math.ceil",
  "math.round",
  "math.fract",
  "math.mod",
  "math.min",
  "math.max",
  "math.clamp",
  "math.saturate",
  "math.mix",
  "math.step",
  "math.smoothstep",
  "vector.dot",
  "vector.cross",
  "vector.length",
  "vector.distance",
  "vector.normalize",
  "vector.reflect",
  "vector.refract",
  "vector.combine",
  "vector.split",
  "logic.equal",
  "logic.notEqual",
  "logic.lessThan",
  "logic.greaterThan",
  "logic.select",
  "derivative.ddx",
  "derivative.ddy",
  "derivative.fwidth",
  "texture.sample",
  "texture.sampleLod",
];

describe("material node catalog", () => {
  it("defines every required GLSL builtin node", () => {
    const missing = REQUIRED_GLSL_NODES.filter(
      (type) => materialNodeDefinition(type) === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("gives every node a unique type and Title Case title", () => {
    const seen = new Set<string>();
    for (const definition of MATERIAL_CATALOG) {
      expect(seen.has(definition.type)).toBe(false);
      seen.add(definition.type);
      expect(definition.title).toMatch(/^[A-Z0-9]/);
      expect(definition.category.length).toBeGreaterThan(0);
    }
  });

  it("gives every pin a unique id inside its node", () => {
    for (const definition of MATERIAL_CATALOG) {
      const ids = [
        ...definition.inputs.map((pin) => pin.id),
        ...definition.outputs.map((pin) => pin.id),
      ];
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("types arithmetic generically so a float splats into a vector", () => {
    const add = materialNodeDefinition("math.add");
    expect(add?.inputs.map((pin) => pin.type.kind)).toEqual([
      "generic",
      "generic",
    ]);
    expect(add?.outputs[0]?.type.kind).toBe("generic");
  });

  it("reduces dot and length to a float regardless of input width", () => {
    expect(materialNodeDefinition("vector.dot")?.outputs[0]?.type).toEqual({
      kind: "float",
    });
    expect(materialNodeDefinition("vector.length")?.outputs[0]?.type).toEqual({
      kind: "float",
    });
  });

  it("marks derivatives as needing the derivatives capability", () => {
    expect(materialNodeDefinition("derivative.fwidth")?.requires).toContain(
      "derivatives",
    );
  });

  it("restricts derivatives to the fragment stage", () => {
    expect(materialNodeDefinition("derivative.ddx")?.stages).toEqual([
      "fragment",
    ]);
  });

  it("scopes screen and scene inputs to post-process graphs", () => {
    expect(nodeIsLegalInDomain("input.sceneColor", "postProcess")).toBe(true);
    expect(nodeIsLegalInDomain("input.sceneColor", "surface")).toBe(false);
    expect(nodeIsLegalInDomain("output.surface", "postProcess")).toBe(false);
    expect(nodeIsLegalInDomain("output.postProcess", "surface")).toBe(false);
  });

  it("allows shared math in both domains", () => {
    expect(nodeIsLegalInDomain("math.sin", "surface")).toBe(true);
    expect(nodeIsLegalInDomain("math.sin", "postProcess")).toBe(true);
  });

  it("exposes the Unreal-style surface output channels", () => {
    const surface = materialNodeDefinition("output.surface");
    expect(surface?.inputs.map((pin) => pin.id)).toEqual([
      "baseColor",
      "metallic",
      "roughness",
      "normal",
      "emissive",
      "opacity",
      "alphaClip",
    ]);
  });

  it("takes a single Color input on the post-process output", () => {
    const post = materialNodeDefinition("output.postProcess");
    expect(post?.inputs.map((pin) => pin.id)).toEqual(["color"]);
    expect(post?.inputs[0]?.type).toEqual({ kind: "vec4" });
  });

  it("filters palette entries by domain", () => {
    const surface = materialPaletteEntries("surface").map((row) => row.type);
    expect(surface).toContain("output.surface");
    expect(surface).not.toContain("output.postProcess");
    expect(surface).not.toContain("input.sceneColor");
  });

  it("costs a texture sample above a scalar multiply", () => {
    const sample = materialNodeDefinition("texture.sample")!;
    const multiply = materialNodeDefinition("math.multiply")!;
    expect(sample.cost).toBeGreaterThan(multiply.cost);
    expect(sample.samples).toBe(1);
  });
});
