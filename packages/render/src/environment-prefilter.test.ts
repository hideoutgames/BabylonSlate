import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import {
  discardParkedFilteredEnvironments,
  PARKED_FILTERED_ENVIRONMENT_MS,
  parkedFilteredEnvironmentTextures,
  retainFilteredEnvironment,
} from "./environment-prefilter";
import { keptEffectCount } from "./effect-bridge";

describe("environment-prefilter handover parking and shader retention", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const engine of engines.splice(0)) engine.dispose();
  });

  function setupEngine(): { engine: NullEngine; source: CubeTexture; createTargetSpy: ReturnType<typeof vi.spyOn> } {
    const engine = new NullEngine();
    engines.push(engine);
    engine._features.allowTexturePrefiltering = true;
    Object.assign(engine.getCaps(), {
      textureLOD: true,
      textureHalfFloatRender: true,
      textureFloatRender: true,
    });
    // The installed NullEngine builds a cube target's texture but never attaches it, and has no GL for wrap updates.
    const createCube = engine.createRenderTargetCubeTexture.bind(engine);
    engine.createRenderTargetCubeTexture = (...args) => {
      const target = createCube(...args);
      target.setTexture(engine.getLoadedTexturesCache().at(-1)!);
      return target;
    };
    vi.spyOn(engine, "updateTextureWrappingMode").mockImplementation(() => {});
    const internal = engine.createTexture("source-sky", false, false, null);
    internal.isCube = true;
    internal.isReady = true;
    internal.width = 256;
    internal.height = 256;
    const source = new CubeTexture("", engine);
    source._texture = internal;
    const createTargetSpy = vi.spyOn(engine, "createRenderTargetCubeTexture");
    return { engine, source, createTargetSpy };
  }

  it("parks a released filtered cube across Scene transitions, reuses it on re-acquire, and drops it after the park timeout", async () => {
    const { engine, source, createTargetSpy } = setupEngine();

    const first = retainFilteredEnvironment(engine, source);
    expect(first).not.toBeNull();
    await first!.ready;
    expect(createTargetSpy).toHaveBeenCalledTimes(1);
    // hdrFiltering utility effect stays retained in the engine keep for subsequent filters.
    expect(keptEffectCount(engine)).toBeGreaterThanOrEqual(1);

    vi.useFakeTimers();
    const filteredInternal = first!.cube.getInternalTexture();
    expect(filteredInternal).not.toBeNull();
    expect(parkedFilteredEnvironmentTextures(engine)).toEqual([]);

    // Releasing the last holder parks the cube rather than immediately disposing it.
    first!.release();
    expect(parkedFilteredEnvironmentTextures(engine)).toEqual([filteredInternal]);

    // A Play or Scene reopen within the handover window reuses the exact filtered cube with zero GPU work.
    const second = retainFilteredEnvironment(engine, source);
    expect(second).not.toBeNull();
    expect(second!.cube.getInternalTexture()).toBe(filteredInternal);
    expect(createTargetSpy).toHaveBeenCalledTimes(1);
    expect(parkedFilteredEnvironmentTextures(engine)).toEqual([]);

    // Releasing again and letting the park timeout expire disposes it cleanly.
    second!.release();
    expect(parkedFilteredEnvironmentTextures(engine)).toEqual([filteredInternal]);
    vi.advanceTimersByTime(PARKED_FILTERED_ENVIRONMENT_MS);
    expect(parkedFilteredEnvironmentTextures(engine)).toEqual([]);
  });

  it("discards parked filtered cubes immediately on discardParkedFilteredEnvironments and context loss", async () => {
    const { engine, source } = setupEngine();

    const handle = retainFilteredEnvironment(engine, source);
    expect(handle).not.toBeNull();
    await handle!.ready;
    vi.useFakeTimers();
    handle!.release();
    expect(parkedFilteredEnvironmentTextures(engine)).toHaveLength(1);
    expect(discardParkedFilteredEnvironments(engine)).toBe(1);
    expect(parkedFilteredEnvironmentTextures(engine)).toEqual([]);
    expect(discardParkedFilteredEnvironments(engine)).toBe(0);

    vi.useRealTimers();
    const next = retainFilteredEnvironment(engine, source);
    expect(next).not.toBeNull();
    await next!.ready;
    vi.useFakeTimers();
    next!.release();
    expect(parkedFilteredEnvironmentTextures(engine)).toHaveLength(1);
    engine.onContextLostObservable.notifyObservers(engine);
    expect(parkedFilteredEnvironmentTextures(engine)).toEqual([]);
  });
});
