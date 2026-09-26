import { describe, expect, it } from "vitest";
import {
  createDefaultParticleEmitterPayload,
  type ParticleEmitterPayload,
} from "@babylonslate/assets";
import { particleModuleSummary } from "./particle-value-modes";

function emitter(patch: (payload: ParticleEmitterPayload) => void): ParticleEmitterPayload {
  const payload = createDefaultParticleEmitterPayload();
  patch(payload);
  return payload;
}

describe("particleModuleSummary", () => {
  it("summarizes values in the units Details shows, without float noise", () => {
    const payload = emitter((next) => {
      next.spawn.rate = { mode: "constant", value: 0.1 + 0.2 };
      next.initialize.lifetime = { mode: "range", min: 0.8, max: 1.2 };
      next.initialize.rotation.start = { mode: "range", min: 0, max: Math.PI * 2 };
    });
    expect(particleModuleSummary("spawnRate", payload, null).text).toBe("0.3 /s");
    expect(particleModuleSummary("initialize", payload, null).text).toBe("Lifetime 0.8–1.2 s");
    // Radians are stored; the summary matches the degree fields.
    expect(particleModuleSummary("rotation", payload, null).text).toBe("Start 0–360 deg");
  });

  it("marks an emitter without a usable Material as destructive", () => {
    const unset = createDefaultParticleEmitterPayload();
    const dangling = emitter((next) => {
      next.render.materialGuid = "mat-gone";
    });
    expect(particleModuleSummary("emitter", unset, null)).toEqual({
      text: "No Material",
      tone: "destructive",
    });
    expect(particleModuleSummary("emitter", dangling, null)).toEqual({
      text: "Missing Material",
      tone: "destructive",
    });
    expect(particleModuleSummary("emitter", dangling, "Sparks")).toEqual({
      text: "Sparks",
      tone: "muted",
    });
  });
});
