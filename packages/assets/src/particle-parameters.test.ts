import { describe, expect, it } from "vitest";
import { createDefaultParticleGraphDocument, type ParticleGraphDocument } from "@haptic/particle-graph";
import { normalizeParticleEmitterPayload, resolveBasicEmitterPlan } from "./particle-basic-emitter";
import type { ParticleLibrary, ParticleLibraryEmitter } from "./particle-library";
import {
  applyBasicParameters,
  normalizeParticleBasicBindings,
  normalizeParticleParameterValues,
  particleSlotConflicts,
  particleSlotParameterValues,
  particleSystemParameters,
} from "./particle-parameters";
import { normalizeParticleSystemPayload } from "./particle-payload";

function graph(parameters: ParticleGraphDocument["parameters"]): ParticleLibraryEmitter {
  return { kind: "graph", document: { ...createDefaultParticleGraphDocument(), parameters } };
}

function basic(bindings: unknown[], extra: Record<string, unknown> = {}): ParticleLibraryEmitter & { kind: "basic" } {
  return { kind: "basic", payload: normalizeParticleEmitterPayload({ ...extra, bindings }) };
}

describe("Basic parameter bindings", () => {
  it("keep one binding per target with a valid name, a name of one type, and at most 16", () => {
    expect(normalizeParticleBasicBindings([
      { target: "spawn.rateScale", parameterName: " Intensity ", defaultValue: [2] },
      { target: "spawn.rateScale", parameterName: "Other" },
      { target: "init.colorTint", parameterName: "Intensity" },
      { target: "init.colorTint", parameterName: "Tint", defaultValue: [1, 0.5, 0] },
      { target: "init.sizeScale", parameterName: "Intensity", defaultValue: ["big"] },
      { target: "shape.radius", parameterName: "Radius" },
      { target: "init.speedScale", parameterName: "   " },
    ])).toEqual([
      { target: "spawn.rateScale", parameterName: "Intensity", defaultValue: [2] },
      { target: "init.colorTint", parameterName: "Tint", defaultValue: [1, 0.5, 0, 1] },
      { target: "init.sizeScale", parameterName: "Intensity", defaultValue: [1] },
    ]);
    const many = Array.from({ length: 20 }, (_, index) => ({ target: "spawn.rateScale", parameterName: `P${index}` }));
    expect(normalizeParticleBasicBindings(many)).toHaveLength(1);
    expect(normalizeParticleEmitterPayload({}).bindings).toEqual([]);
  });

  it("System defaults keep numeric arrays under valid names", () => {
    expect(normalizeParticleParameterValues({ " Heat ": [1, 2], Cold: "x", Empty: [], Bad: [1, "2"], [""]: [1] })).toEqual({ Heat: [1, 2] });
    expect(normalizeParticleSystemPayload({ parameterDefaults: { Heat: [3] } }).parameterDefaults).toEqual({ Heat: [3] });
    expect(normalizeParticleSystemPayload({}).parameterDefaults).toEqual({});
  });
});

describe("Particle System parameters", () => {
  const library = (systemDefaults: Record<string, number[]> = {}): ParticleLibrary => ({
    emitters: new Map<string, ParticleLibraryEmitter>([
      ["graph", graph([{ id: "a", name: "Intensity", type: "float", defaultValue: [3] }, { id: "b", name: "Tint", type: "color", defaultValue: [1, 0, 0, 1] }])],
      ["basic", basic([{ target: "spawn.rateScale", parameterName: "Intensity", defaultValue: [5] }, { target: "init.speedScale", parameterName: "Tint" }])],
      ["plain", basic([])],
    ]),
    systems: new Map([["system", { emitterGuids: ["graph", "plain", "basic", "graph"], space: "world" as const, previewSkybox: true, parameterDefaults: systemDefaults }]]),
  });

  it("are the union by name in first-use order; the first slot decides the type and later ones conflict", () => {
    expect(particleSystemParameters(library({ Intensity: [7] }), "system")).toEqual({
      parameters: [
        { name: "Intensity", type: "float", defaultValue: [7], overridden: true, slots: [0, 2, 3] },
        { name: "Tint", type: "color", defaultValue: [1, 0, 0, 1], overridden: false, slots: [0, 3] },
      ],
      conflicts: [{ name: "Tint", type: "color", slots: [2] }],
    });
    expect(particleSystemParameters(library(), "missing")).toEqual({ parameters: [], conflicts: [] });
  });

  it("resolve per slot: component value, then System default, then the emitter's, and conflicting slots keep their own", () => {
    const { conflicts } = particleSystemParameters(library(), "system");
    const emitter = library().emitters.get("basic")!;
    const values = (componentValues: Map<string, number[]>, systemDefaults: Record<string, number[]> = {}) =>
      particleSlotParameterValues(emitter, { systemDefaults, componentValues, conflicting: particleSlotConflicts(conflicts, 2) });
    expect(values(new Map())).toEqual(new Map([["Intensity", [5]], ["Tint", [1]]]));
    expect(values(new Map(), { Intensity: [8] }).get("Intensity")).toEqual([8]);
    expect(values(new Map([["Intensity", [9, 9]]]), { Intensity: [8] }).get("Intensity")).toEqual([9]);
    // Tint conflicts in slot 2 (a float there, a color in the System): runtime values never reach it.
    expect(values(new Map([["Tint", [0.25, 0.5, 0.75, 1]]])).get("Tint")).toEqual([1]);
  });
});

describe("applyBasicParameters", () => {
  const emitter = basic([
    { target: "spawn.rateScale", parameterName: "Rate" },
    { target: "spawn.burstScale", parameterName: "Burst" },
    { target: "init.lifetimeScale", parameterName: "Life" },
    { target: "init.speedScale", parameterName: "Speed" },
    { target: "init.sizeScale", parameterName: "Size" },
    { target: "init.colorTint", parameterName: "Tint" },
    { target: "forces.gravity", parameterName: "Gravity" },
  ], {
    emitter: { capacity: 100 },
    spawn: { rate: { mode: "curve", keys: [{ t: 0, value: 10 }, { t: 1, value: 20 }] },
      bursts: { enabled: true, entries: [{ time: 0, count: 30, cycles: 1, interval: 1 }] } },
    initialize: {
      lifetime: { mode: "range", min: 1, max: 2 },
      speed: { mode: "constant", value: 4 },
      size: { mode: "curve", keys: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] },
      color: { mode: "range", min: [1, 1, 1, 1], max: [0.5, 0.5, 0.5, 0.5] },
    },
    forces: { gravity: { enabled: true, acceleration: [0, -9.81, 0] } },
  });
  const base = resolveBasicEmitterPlan(emitter.payload, { backend: "compute", space: "world" });
  const values = new Map([["Rate", [2]], ["Burst", [3.4]], ["Life", [0.5]], ["Speed", [1.5]], ["Size", [2]],
    ["Tint", [1, 0.5, 0, 0.5]], ["Gravity", [0, 0, -1]]]);

  it("multiplies the scaled targets, tints every colour key, replaces gravity and leaves the base plan alone", () => {
    const plan = applyBasicParameters(base, emitter.payload.bindings, values, { gravityEnabled: true });
    expect(plan.emitRate).toBe(base.emitRate * 2);
    expect(plan.schedule.rateCurve).toEqual([{ t: 0, value: 20 }, { t: 1, value: 40 }]);
    // 30 × 3.4 = 102 rounds to 102 and is capped at the capacity of 100.
    expect(plan.schedule.bursts.map((burst) => burst.count)).toEqual([100]);
    expect(plan.lifeTime).toEqual({ min: 0.5, max: 1 });
    expect(plan.lifetimeBound).toBe(base.lifetimeBound * 0.5);
    expect(plan.emitPower).toEqual({ min: 6, max: 6 });
    expect(plan.size).toEqual({ min: base.size.min * 2, max: base.size.max * 2 });
    expect(plan.gradients.size).toEqual([{ t: 0, factor: 1 }, { t: 1, factor: 2 }]);
    expect(plan.gradients.color).toEqual([{ t: 0, color1: [1, 0.5, 0, 0.5], color2: [0.5, 0.25, 0, 0.25] }]);
    expect(plan.gravity).toEqual([0, 0, -1]);
    expect(base.emitPower).toEqual({ min: 4, max: 4 });
    expect(base.schedule.bursts.map((burst) => burst.count)).toEqual([30]);
  });

  it("leaves gravity off while the Gravity module is off, and uses binding defaults for unset values", () => {
    const plan = applyBasicParameters(base, emitter.payload.bindings, new Map([["Gravity", [5, 5, 5]]]), { gravityEnabled: false });
    expect(plan.gravity).toEqual(base.gravity);
    // Every other binding defaults to its neutral value.
    expect(plan.emitPower).toEqual(base.emitPower);
    expect(plan.gradients.color).toEqual(base.gradients.color);
    expect(applyBasicParameters(base, [], values, { gravityEnabled: true })).toBe(base);
  });
});
