import { describe, expect, it } from "vitest";
import {
  PARTICLE_SYSTEM_MAX_EMITTERS,
  normalizeParticleSystemPayload,
  particleAssetDependencies,
} from "./particle-payload";
import {
  createDefaultParticleEmitterPayload,
  normalizeParticleEmitterPayload,
} from "./particle-basic-emitter";
import { encodeAssetDocument, decodeAssetDocument } from "./asset-document";

describe("particle payloads", () => {
  it("treats a missing Preview Skybox field as on and keeps an explicit off", () => {
    expect(normalizeParticleSystemPayload({}).previewSkybox).toBe(true);
    expect(
      normalizeParticleSystemPayload({ previewSkybox: false }).previewSkybox,
    ).toBe(false);
  });

  it("clamps a System to eight emitter slots, keeps duplicates and drops old lifecycle keys", () => {
    const payload = normalizeParticleSystemPayload({
      emitterGuids: [
        "a",
        "",
        "b",
        "a",
        ...Array.from({ length: 10 }, (_, i) => `e${i}`),
      ],
      space: "local",
      looping: false,
      duration: 3,
    });
    expect(payload.emitterGuids).toHaveLength(PARTICLE_SYSTEM_MAX_EMITTERS);
    expect(payload.emitterGuids.slice(0, 3)).toEqual(["a", "b", "a"]);
    expect(payload.space).toBe("local");
    expect(payload).not.toHaveProperty("looping");
    expect(payload).not.toHaveProperty("duration");
  });

  it("indexes only the nested Material of an Emitter and the System's emitters", () => {
    expect(
      particleAssetDependencies("ParticleEmitter", {
        textureGuid: "tex-1",
        materialGuid: "old-flat-mat",
        render: { materialGuid: "mat-1" },
      }),
    ).toEqual(["mat-1"]);
    expect(
      particleAssetDependencies("ParticleSystem", {
        emitterGuids: ["em-2", "em-1", "em-2"],
      }),
    ).toEqual(["em-1", "em-2"]);
    expect(particleAssetDependencies("Audio", {})).toEqual([]);
  });

  it("round-trips Emitter and System documents", async () => {
    const emitter = createDefaultParticleEmitterPayload();
    emitter.render.materialGuid = "mat-1";
    emitter.spawn.bursts = {
      enabled: true,
      entries: [{ time: 0.25, count: 12, cycles: 0, interval: 0.5 }],
    };
    const encoded = await encodeAssetDocument({
      type: "ParticleEmitter",
      name: "Sparks",
      guid: "00000000-0000-4000-8000-00000000e001",
      version: 1,
      payload: emitter as unknown as Record<string, unknown>,
    });
    const decoded = await decodeAssetDocument(encoded);
    expect(decoded.type).toBe("ParticleEmitter");
    expect(normalizeParticleEmitterPayload(decoded.payload)).toEqual(emitter);

    const system = normalizeParticleSystemPayload({
      emitterGuids: ["em-1", "em-1"],
      space: "local",
      previewSkybox: false,
    });
    const encodedSystem = await encodeAssetDocument({
      type: "ParticleSystem",
      name: "Fire",
      guid: "00000000-0000-4000-8000-00000000s001",
      version: 1,
      payload: system as unknown as Record<string, unknown>,
    });
    const decodedSystem = await decodeAssetDocument(encodedSystem);
    expect(decodedSystem.type).toBe("ParticleSystem");
    expect(normalizeParticleSystemPayload(decodedSystem.payload)).toEqual(
      system,
    );
  });
});
