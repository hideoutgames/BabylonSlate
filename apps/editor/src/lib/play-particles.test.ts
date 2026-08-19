import { describe, expect, it, vi } from "vitest";
import {
  emptyPlayParticleLibrary,
  emitterPreviewLibrary,
  emittersFromRegistry,
  loadEmittersForPreview,
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

  it("does not treat an empty registry header as an authored Emitter look", () => {
    expect(
      emittersFromRegistry(
        [
          {
            header: {
              guid: "em-1",
              type: "ParticleEmitter",
              payload: {},
            },
          },
        ],
        new Map(),
      ).get("em-1")?.textureGuid,
    ).toBeNull();
  });

  it("loads closed Emitter document chunks instead of empty registry headers", async () => {
    const loadDocument = vi.fn(async () => ({
      textureGuid: "tex-1",
      capacity: 64,
    }));
    const emitters = await loadEmittersForPreview({
      system: {
        ...createDefaultParticleSystemPayload(),
        emitterGuids: ["em-1"],
      },
      assets: [
        {
          header: {
            guid: "em-1",
            type: "ParticleEmitter",
            payload: {},
          },
          path: "assets/Sparks.emitter.babasset",
        },
      ],
      openPayloads: new Map(),
      loadDocument,
    });
    expect(loadDocument).toHaveBeenCalledWith(
      "particle-emitter",
      "assets/Sparks.emitter.babasset",
    );
    expect(emitters.get("em-1")?.textureGuid).toBe("tex-1");
    expect(emitters.get("em-1")?.capacity).toBe(64);
  });

  it("prefers an open Emitter tab over a disk load", async () => {
    const loadDocument = vi.fn(async () => ({ textureGuid: "from-disk" }));
    const emitters = await loadEmittersForPreview({
      system: {
        ...createDefaultParticleSystemPayload(),
        emitterGuids: ["em-1"],
      },
      assets: [
        {
          header: { guid: "em-1", type: "ParticleEmitter" },
          path: "assets/Sparks.emitter.babasset",
        },
      ],
      openPayloads: new Map([["em-1", { textureGuid: "from-tab" }]]),
      loadDocument,
    });
    expect(loadDocument).not.toHaveBeenCalled();
    expect(emitters.get("em-1")?.textureGuid).toBe("from-tab");
  });
});
