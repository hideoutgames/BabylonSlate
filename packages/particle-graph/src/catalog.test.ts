import { describe, expect, it } from "vitest";
import {
  PARTICLE_CATALOG,
  PARTICLE_CONDITION_TESTS,
  PARTICLE_RANDOM_LOCKS,
  PARTICLE_UNSUPPORTED_V1_TYPES,
  PARTICLE_VALUE_TYPE_OPTIONS,
  isParticleSpineRole,
  particleNodeDefinition,
} from "./catalog";
import { newParticleNodeProperties } from "./document";
import { particleComponentCount } from "./types";

const TITLE_CASE = /^[A-Z0-9][A-Za-z0-9]*( [A-Z0-9][A-Za-z0-9]*)*$/;
const RADIAL_SHAPES = new Set(["shape.sphere", "shape.cone", "shape.cylinder"]);

describe("particle node catalog", () => {
  it("uses Title Case for titles, categories, pin names and option labels", () => {
    for (const definition of PARTICLE_CATALOG) {
      expect(definition.title).toMatch(TITLE_CASE);
      expect(definition.category).toMatch(TITLE_CASE);
      for (const pin of [...definition.inputs, ...definition.outputs]) {
        expect(pin.name).toMatch(TITLE_CASE);
      }
    }
    for (const option of [...PARTICLE_CONDITION_TESTS, ...PARTICLE_RANDOM_LOCKS, ...PARTICLE_VALUE_TYPE_OPTIONS]) {
      expect(option.label).toMatch(TITLE_CASE);
    }
  });

  it("gives every node a unique type and unique pin ids across inputs and outputs", () => {
    expect(new Set(PARTICLE_CATALOG.map((definition) => definition.type)).size).toBe(
      PARTICLE_CATALOG.length,
    );
    for (const definition of PARTICLE_CATALOG) {
      const ids = [...definition.inputs, ...definition.outputs].map((pin) => pin.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("sizes every default to its pin type", () => {
    for (const definition of PARTICLE_CATALOG) {
      for (const pin of definition.inputs) {
        if (!pin.defaultValue) continue;
        const width = pin.type.kind === "generic" ? 1 : particleComponentCount(pin.type.kind);
        expect(pin.defaultValue, `${definition.type}.${pin.id}`).toHaveLength(width);
      }
    }
  });

  it("never names a node property like an input pin, which graph-ui reads as a pin default", () => {
    for (const definition of PARTICLE_CATALOG) {
      const keys = Object.keys(newParticleNodeProperties(definition.type));
      for (const pin of definition.inputs) {
        expect(keys, definition.type).not.toContain(pin.id);
        expect(keys, definition.type).not.toContain(pin.name);
      }
    }
  });

  it("gives every input a default or makes it required, so Babylon never sees an empty non-optional port", () => {
    for (const definition of PARTICLE_CATALOG) {
      for (const pin of definition.inputs) {
        const directedPair =
          RADIAL_SHAPES.has(definition.type) && (pin.id === "direction1" || pin.id === "direction2");
        if (directedPair) {
          // Unset directions keep Babylon's radial emission.
          expect(pin.defaultValue).toBeUndefined();
          continue;
        }
        expect(pin.required === true || pin.defaultValue !== undefined, `${definition.type}.${pin.id}`).toBe(true);
      }
    }
  });

  it("puts the Particle pins first on every spine node so the spine runs straight", () => {
    for (const definition of PARTICLE_CATALOG) {
      if (!isParticleSpineRole(definition.role)) {
        expect([...definition.inputs, ...definition.outputs].some((pin) => pin.type.kind === "particle")).toBe(false);
        continue;
      }
      if (definition.role !== "create") expect(definition.inputs[0]?.type.kind).toBe("particle");
      if (definition.role !== "output") expect(definition.outputs.map((pin) => pin.type.kind)).toEqual(["particle"]);
    }
  });

  it("exposes only Particle and Emit Rate on the Emitter Output", () => {
    const output = PARTICLE_CATALOG.filter((definition) => definition.terminal);
    expect(output.map((definition) => definition.title)).toEqual(["Emitter Output"]);
    expect(output[0]!.inputs.map((pin) => pin.id)).toEqual(["particle", "emitRate"]);
    expect(output[0]!.outputs).toEqual([]);
  });

  it("keeps reserved v1 exclusions out of the catalog", () => {
    for (const type of Object.keys(PARTICLE_UNSUPPORTED_V1_TYPES)) {
      expect(particleNodeDefinition(type)).toBeUndefined();
    }
  });

  it("keeps Color out of the math nodes Babylon breaks on Color4", () => {
    for (const type of ["math.divide", "math.max", "math.clamp", "math.step", "math.smoothstep"]) {
      const pin = particleNodeDefinition(type)!.inputs[0]!;
      expect(pin.type.kind === "generic" && pin.type.accepts, type).toEqual(["float", "vec2", "vec3"]);
    }
  });
});
