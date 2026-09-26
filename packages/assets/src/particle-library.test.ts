import { describe, expect, it } from "vitest";
import {
  particleLibraryCompileKey,
  particleLibraryFromAssets,
  particleLibraryMaterialGuids,
} from "./particle-library";

describe("particle library", () => {
  it("normalizes emitter and system assets and ignores other asset types", () => {
    const library = particleLibraryFromAssets([
      { guid: "em-1", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-1" } } },
      { guid: "sys-1", type: "ParticleSystem", payload: { emitterGuids: ["em-1"], looping: false } },
      { guid: "tex-1", type: "Texture", payload: {} },
    ]);
    expect(library.emitters.get("em-1")).toMatchObject({
      kind: "basic",
      payload: { schemaVersion: 2, render: { materialGuid: "mat-1", blendMode: "additive" } },
    });
    expect(library.systems.get("sys-1")).toEqual({
      emitterGuids: ["em-1"],
      space: "world",
      previewSkybox: true,
    });
    expect(library.emitters.has("tex-1")).toBe(false);
  });

  it("lists each emitter Material once, in emitter order", () => {
    const library = particleLibraryFromAssets([
      { guid: "a", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-2" } } },
      { guid: "b", type: "ParticleEmitter", payload: {} },
      { guid: "c", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-1" } } },
      { guid: "d", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-2" } } },
    ]);
    expect(particleLibraryMaterialGuids(library)).toEqual(["mat-2", "mat-1"]);
  });

  it("keys the library by content, not by asset order", () => {
    const a = { guid: "a", type: "ParticleEmitter", payload: {} };
    const b = { guid: "b", type: "ParticleEmitter", payload: { emitter: { capacity: 64 } } };
    const system = { guid: "s", type: "ParticleSystem", payload: { emitterGuids: ["a", "b"] } };
    const key = particleLibraryCompileKey(particleLibraryFromAssets([a, b, system]));
    expect(particleLibraryCompileKey(particleLibraryFromAssets([system, b, a]))).toBe(key);
    expect(
      particleLibraryCompileKey(
        particleLibraryFromAssets([
          { ...a, payload: { render: { blendMode: "multiply" } } },
          b,
          system,
        ]),
      ),
    ).not.toBe(key);
  });
});
