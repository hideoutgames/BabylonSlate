import { describe, expect, it } from "vitest";
import {
  basicEmitterSlotNeed,
  createDefaultParticleEmitterPayload,
  normalizeParticleEmitterPayload,
  particleEmitterChangeTier,
  resolveBasicEmitterPlan,
  type ParticleEmitterPayload,
} from "./particle-basic-emitter";

type Edit = (payload: ParticleEmitterPayload) => void;

function emitter(edit?: Edit): ParticleEmitterPayload {
  const payload = createDefaultParticleEmitterPayload();
  edit?.(payload);
  return normalizeParticleEmitterPayload(payload);
}

const gpu = { backend: "compute", space: "world" } as const;

describe("Basic emitter normalization", () => {
  it("loads a flat P17 emitter as the new defaults without its Texture", () => {
    const payload = normalizeParticleEmitterPayload({
      textureGuid: "tex-1",
      materialGuid: "mat-1",
      capacity: 1024,
      emitRate: 90,
      blendMode: "standard",
      minSize: 1,
      maxSize: 2,
      sizeGradient: [
        { t: 0, value: 1 },
        { t: 1, value: 0 },
      ],
    });
    expect(payload).toEqual(createDefaultParticleEmitterPayload());
    expect(payload).not.toHaveProperty("textureGuid");
  });

  it("clamps burst counts to capacity and keeps at most eight bursts", () => {
    const payload = normalizeParticleEmitterPayload({
      emitter: { capacity: 64 },
      spawn: {
        bursts: {
          enabled: true,
          entries: [
            "junk",
            { time: 0, count: 5000 },
            ...Array.from({ length: 10 }, () => ({ time: 1, count: 3 })),
          ],
        },
      },
    });
    expect(payload.spawn.bursts.entries).toHaveLength(8);
    expect(payload.spawn.bursts.entries[0]!.count).toBe(64);
  });

  it("keeps a disabled module's values but leaves it out of the plan", () => {
    const payload = emitter((p) => {
      p.initialize.scale = {
        enabled: false,
        x: { mode: "constant", value: 3 },
        y: { mode: "constant", value: 4 },
      };
      p.forces.gravity.enabled = false;
      p.overLife.drag = { enabled: false, amount: { mode: "constant", value: 0.5 } };
    });
    expect(payload.initialize.scale.x).toEqual({ mode: "constant", value: 3 });
    const plan = resolveBasicEmitterPlan(payload, gpu);
    expect(plan.scaleX).toEqual({ min: 1, max: 1 });
    expect(plan.gravity).toEqual([0, 0, 0]);
    expect(plan.gradients.drag).toBeNull();
  });

  it("falls back to the default cone for unknown shapes and keeps radii above zero", () => {
    expect(normalizeParticleEmitterPayload({ shape: { kind: "mesh" } }).shape).toEqual(
      createDefaultParticleEmitterPayload().shape,
    );
    const sphere = normalizeParticleEmitterPayload({
      shape: { kind: "sphere", radius: 0 },
    }).shape;
    expect(sphere.kind === "sphere" && sphere.radius).toBeGreaterThan(0);
  });
});

describe("Basic emitter plan", () => {
  it("sets fixed size for constant and range modes and a gradient only for curves", () => {
    const range = resolveBasicEmitterPlan(
      emitter((p) => {
        p.initialize.size = { mode: "range", min: 0.5, max: 0.9 };
      }),
      gpu,
    );
    expect(range.size).toEqual({ min: 0.5, max: 0.9 });
    expect(range.gradients.size).toBeNull();
    const curve = resolveBasicEmitterPlan(
      emitter((p) => {
        p.initialize.size = {
          mode: "curve",
          keys: [
            { t: 0, value: 0.4 },
            { t: 1, value: 0 },
          ],
        };
      }),
      gpu,
    );
    expect(curve.gradients.size).toEqual([
      { t: 0, factor: 0.4 },
      { t: 1, factor: 0 },
    ]);
    expect(curve.size).toEqual({ min: 0.4, max: 0.4 });
  });

  it("lowers every colour mode to a colour gradient, with color2 only for a range", () => {
    const plan = (color: ParticleEmitterPayload["initialize"]["color"]) =>
      resolveBasicEmitterPlan(emitter((p) => (p.initialize.color = color)), gpu)
        .gradients.color;
    expect(plan({ mode: "constant", color: [1, 0, 0, 1] })).toEqual([
      { t: 0, color1: [1, 0, 0, 1], color2: null },
    ]);
    expect(
      plan({ mode: "range", min: [1, 0, 0, 1], max: [0, 0, 1, 1] }),
    ).toEqual([{ t: 0, color1: [1, 0, 0, 1], color2: [0, 0, 1, 1] }]);
    expect(plan(createDefaultParticleEmitterPayload().initialize.color)).toHaveLength(2);
  });

  it("stops a once emitter natively and drives a looping lifetime curve from its start value", () => {
    const once = resolveBasicEmitterPlan(
      emitter((p) => {
        p.emitter.loop = "once";
        p.emitter.duration = 1.5;
      }),
      gpu,
    );
    expect(once.targetStopDuration).toBe(1.5);
    const looping = resolveBasicEmitterPlan(
      emitter((p) => {
        p.initialize.lifetime = {
          mode: "curve",
          keys: [
            { t: 0, value: 0.5 },
            { t: 0.5, value: 3 },
            { t: 1, value: 1 },
          ],
        };
      }),
      gpu,
    );
    expect(looping.targetStopDuration).toBe(0);
    expect(looping.lifeTime).toEqual({ min: 0.5, max: 0.5 });
    expect(looping.lifetimeBound).toBe(3);
    expect(looping.schedule.lifetimeCurve).toHaveLength(3);
  });

  it("measures prewarm in seconds and skips it for once emitters", () => {
    const plan = resolveBasicEmitterPlan(
      emitter((p) => {
        p.emitter.prewarm = 2.5;
      }),
      gpu,
    );
    expect(plan.preWarmCycles).toBeLessThanOrEqual(60);
    expect(plan.preWarmCycles * plan.preWarmStepOffset * plan.updateSpeed).toBeCloseTo(2.5);
    const once = resolveBasicEmitterPlan(
      emitter((p) => {
        p.emitter.prewarm = 2.5;
        p.emitter.loop = "once";
      }),
      gpu,
    );
    expect(once.preWarmCycles).toBe(0);
    expect(once.preWarmStepOffset).toBe(1);
  });

  it("divides hemisphere speed by the radius only on WebGL2 transform feedback", () => {
    const payload = emitter((p) => {
      p.shape = { kind: "hemisphere", radius: 2, radiusRange: 0, randomizer: 0 };
      p.initialize.speed = { mode: "range", min: 2, max: 4 };
    });
    const power = (backend: "cpu" | "transformFeedback" | "compute") =>
      resolveBasicEmitterPlan(payload, { backend, space: "world" }).emitPower;
    expect(power("transformFeedback")).toEqual({ min: 1, max: 2 });
    expect(power("compute")).toEqual({ min: 2, max: 4 });
    expect(power("cpu")).toEqual({ min: 2, max: 4 });
  });

  it("caps capacity on the CPU fallback only", () => {
    const payload = emitter((p) => {
      p.emitter.capacity = 2048;
    });
    expect(resolveBasicEmitterPlan(payload, gpu).capacity).toBe(2048);
    expect(
      resolveBasicEmitterPlan(payload, { backend: "cpu", space: "local" }).capacity,
    ).toBe(512);
  });

  it("schedules bursts only while the Bursts module is enabled", () => {
    const entries = [{ time: 0, count: 5, cycles: 1, interval: 0.5 }];
    const on = emitter((p) => (p.spawn.bursts = { enabled: true, entries }));
    const off = emitter((p) => (p.spawn.bursts = { enabled: false, entries }));
    expect(resolveBasicEmitterPlan(on, gpu).schedule.bursts).toEqual(entries);
    expect(resolveBasicEmitterPlan(off, gpu).schedule.bursts).toEqual([]);
  });
});

describe("Basic emitter slot need", () => {
  it("counts rate × lifetime", () => {
    const payload = emitter((p) => {
      p.spawn.rate = { mode: "constant", value: 30 };
      p.initialize.lifetime = { mode: "constant", value: 1.2 };
    });
    expect(basicEmitterSlotNeed(payload)).toBe(36);
  });

  it("counts bursts that overlap across loop wraps", () => {
    const payload = emitter((p) => {
      p.emitter.duration = 1;
      p.spawn.rate = { mode: "constant", value: 0 };
      p.initialize.lifetime = { mode: "constant", value: 2 };
      p.spawn.bursts = {
        enabled: true,
        entries: [{ time: 0, count: 50, cycles: 1, interval: 0.5 }],
      };
    });
    expect(basicEmitterSlotNeed(payload)).toBeGreaterThanOrEqual(100);
  });

  it("reports an unbounded need when bursts fire too often to count", () => {
    const payload = emitter((p) => {
      p.emitter.duration = 600;
      p.spawn.bursts = {
        enabled: true,
        entries: [{ time: 0, count: 1, cycles: 0, interval: 0.01 }],
      };
    });
    expect(basicEmitterSlotNeed(payload)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Basic emitter change tiers", () => {
  const tier = (edit: Edit, base: Edit = () => {}) =>
    particleEmitterChangeTier(emitter(base), emitter((p) => {
      base(p);
      edit(p);
    }));

  it("reports no change for equal payloads", () => {
    expect(tier(() => {})).toBe("none");
  });

  it("keeps uniform and same-count gradient edits live", () => {
    expect(tier((p) => (p.spawn.rate = { mode: "constant", value: 55 }))).toBe("live");
    expect(
      tier((p) => {
        if (p.shape.kind === "cone") p.shape.radius = 0.4;
      }),
    ).toBe("live");
    expect(
      tier((p) => {
        if (p.initialize.color.mode === "curve") {
          p.initialize.color.keys[1]!.color = [1, 0, 0, 0];
        }
      }),
    ).toBe("live");
    expect(tier((p) => (p.render.blendMode = "subtract"))).toBe("live");
    expect(
      tier((p) => {
        p.spawn.rate = {
          mode: "curve",
          keys: [
            { t: 0, value: 5 },
            { t: 1, value: 50 },
          ],
        };
      }),
    ).toBe("live");
  });

  it("respawns on define and key-count changes", () => {
    expect(
      tier((p) => {
        if (p.initialize.color.mode === "curve") {
          p.initialize.color.keys.splice(1, 0, { t: 0.5, color: [1, 1, 0, 1] });
        }
      }),
    ).toBe("respawn");
    expect(
      tier((p) => {
        p.shape = { kind: "sphere", radius: 0.5, radiusRange: 1, direction: { mode: "radial", randomizer: 0 } };
      }),
    ).toBe("respawn");
    expect(
      tier((p) => {
        if (p.shape.kind === "cone") {
          p.shape.direction = { mode: "directed", direction1: [0, 1, 0], direction2: [0, 1, 0] };
        }
      }),
    ).toBe("respawn");
    expect(tier((p) => (p.render.blendMode = "multiply"))).toBe("respawn");
  });

  it("rebuilds when the gradient signature or native construction changes", () => {
    expect(
      tier((p) => {
        p.initialize.size = {
          mode: "curve",
          keys: [
            { t: 0, value: 1 },
            { t: 1, value: 0 },
          ],
        };
      }),
    ).toBe("rebuild");
    expect(
      tier((p) => {
        p.initialize.color = { mode: "range", min: [1, 1, 1, 1], max: [1, 0, 0, 1] };
      }),
    ).toBe("rebuild");
    expect(tier((p) => (p.overLife.drag.enabled = true))).toBe("rebuild");
    expect(tier((p) => (p.render.materialGuid = "mat-2"))).toBe("rebuild");
    expect(tier((p) => (p.render.billboard = "stretched"))).toBe("rebuild");
    expect(tier((p) => (p.emitter.capacity = 512))).toBe("rebuild");
    expect(tier((p) => (p.emitter.prewarm = 1))).toBe("rebuild");
  });

  it("rebuilds a once emitter's duration but keeps a loop's duration live", () => {
    expect(tier((p) => (p.emitter.duration = 3))).toBe("live");
    expect(
      tier(
        (p) => (p.emitter.duration = 3),
        (p) => (p.emitter.loop = "once"),
      ),
    ).toBe("rebuild");
  });
});
