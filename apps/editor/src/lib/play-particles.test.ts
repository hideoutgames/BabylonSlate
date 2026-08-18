import { describe, expect, it } from "vitest";
import {
  emptyPlayParticleLibrary,
  emitterPreviewLibrary,
  emittersFromRegistry,
  particleMaterialGuidsFromLibrary,
  particleTextureGuidsFromLibrary,
  playParticleLibraryFromAssets,
  systemPreviewLibrary,
} from "./play-particles";
import {
  createDefaultParticleEmitterPayload,
  createDefaultParticleSystemPayload,
} from "@babylonslate/assets";

describe("playParticleLibraryFromAssets", () => {
  it("normalizes Particle Emitter and Particle System payloads", () => {
    const library = playParticleLibraryFromAssets({
      assets: [
        {
          guid: "em-1",
          type: "ParticleEmitter",
          payload: { ...createDefaultParticleEmitterPayload(), capacity: 64 },
        },
        {
          guid: "sys-1",
          type: "ParticleSystem",
          payload: { emitterGuids: ["em-1"] },
        },
      ],
    });
    expect(library.emitters.get("em-1")?.capacity).toBe(64);
    expect(library.systems.get("sys-1")?.emitterGuids).toEqual(["em-1"]);
    expect(playParticleLibraryFromAssets({ assets: [] }).emitters.size).toBe(0);
  });

  it("collects unique Texture and particle-domain Material guids", () => {
    const library = playParticleLibraryFromAssets({
      assets: [
        {
          guid: "em-1",
          type: "ParticleEmitter",
          payload: {
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
            materialGuid: "mat-1",
          },
        },
        {
          guid: "em-2",
          type: "ParticleEmitter",
          payload: {
            ...createDefaultParticleEmitterPayload(),
            textureGuid: "tex-1",
            materialGuid: "mat-2",
          },
        },
        {
          guid: "em-3",
          type: "ParticleEmitter",
          payload: createDefaultParticleEmitterPayload(),
        },
      ],
    });
    expect(particleTextureGuidsFromLibrary(library)).toEqual(["tex-1"]);
    expect(particleMaterialGuidsFromLibrary(library)).toEqual(["mat-1", "mat-2"]);
    expect(particleTextureGuidsFromLibrary(emptyPlayParticleLibrary())).toEqual(
      [],
    );
  });

  it("wraps a single Emitter as a Preview Particle System", () => {
    const emitter = {
      ...createDefaultParticleEmitterPayload(),
      textureGuid: "tex-1",
    };
    const library = emitterPreviewLibrary(emitter);
    expect(library.emitters.get("preview-em")?.textureGuid).toBe("tex-1");
    expect(library.systems.get("preview-sys")?.emitterGuids).toEqual([
      "preview-em",
    ]);
  });

  it("collects only the Emitters referenced by a System", () => {
    const used = {
      ...createDefaultParticleEmitterPayload(),
      textureGuid: "tex-1",
    };
    const unused = createDefaultParticleEmitterPayload();
    const library = systemPreviewLibrary(
      { ...createDefaultParticleSystemPayload(), emitterGuids: ["em-1"] },
      new Map([
        ["em-1", used],
        ["em-2", unused],
      ]),
    );
    expect([...library.emitters.keys()]).toEqual(["em-1"]);
    expect(
      emittersFromRegistry(
        [
          {
            header: {
              guid: "em-1",
              type: "ParticleEmitter",
              payload: { capacity: 32 },
            },
          },
          { header: { guid: "tex-1", type: "Texture" } },
        ],
        new Map(),
      ).get("em-1")?.capacity,
    ).toBe(32);
  });
});
