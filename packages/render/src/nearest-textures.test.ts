import { afterEach, describe, expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Scene } from "@babylonjs/core/scene";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { nearestTexturesEnabled, observeNearestTextures, setNearestTextures, trackMaterialTexture } from "./nearest-textures";

const NEAREST = Constants.TEXTURE_NEAREST_SAMPLINGMODE;
const TRILINEAR = Constants.TEXTURE_TRILINEAR_SAMPLINGMODE;
const handles: Array<{ dispose: () => void }> = [];
afterEach(() => { while (handles.length) handles.pop()!.dispose(); });

function engine(): NullEngine {
  const value = new NullEngine();
  handles.push(value);
  return value;
}

function texture(target: Scene, mode = TRILINEAR): Texture {
  return RawTexture.CreateRGBATexture(new Uint8Array(16), 2, 2, target, false, false, mode);
}

describe("Nearest Texture Filtering", () => {
  it("samples tracked textures nearest while on and returns each to the mode it loaded with", () => {
    const value = engine();
    const scene = new Scene(value);
    const linear = texture(scene), nearest = texture(scene, NEAREST);
    trackMaterialTexture(value, linear, undefined);
    trackMaterialTexture(value, nearest, undefined);
    // A cached texture comes with every lease of it: tracking again changes nothing.
    trackMaterialTexture(value, linear, undefined);
    expect(nearestTexturesEnabled(value)).toBe(false);
    expect([linear.samplingMode, nearest.samplingMode]).toEqual([TRILINEAR, NEAREST]);
    setNearestTextures(value, true);
    expect(nearestTexturesEnabled(value)).toBe(true);
    expect([linear.samplingMode, nearest.samplingMode]).toEqual([NEAREST, NEAREST]);
    setNearestTextures(value, false);
    expect([linear.samplingMode, nearest.samplingMode]).toEqual([TRILINEAR, NEAREST]);
  });

  it("samples a texture that loads while on nearest, leaves untracked textures alone and forgets disposed ones", async () => {
    const value = engine();
    const scene = new Scene(value);
    setNearestTextures(value, true);
    const untracked = texture(scene);
    const loading = texture(scene);
    let loaded!: () => void;
    trackMaterialTexture(value, loading, new Promise<void>((resolve) => { loaded = resolve; }));
    loaded();
    await Promise.resolve();
    expect([loading.samplingMode, untracked.samplingMode]).toEqual([NEAREST, TRILINEAR]);
    loading.dispose();
    expect(() => setNearestTextures(value, false)).not.toThrow();
  });

  it("keeps each Engine's switch apart and tells its listeners when it changes", () => {
    const first = engine(), second = engine();
    const heard: string[] = [];
    const stop = observeNearestTextures(first, () => heard.push("first"));
    observeNearestTextures(second, () => heard.push("second"));
    setNearestTextures(first, true);
    setNearestTextures(first, true);
    expect(nearestTexturesEnabled(second)).toBe(false);
    stop();
    setNearestTextures(first, false);
    expect(heard).toEqual(["first"]);
  });

  it("rebinds every draw of the Engine's Scenes once at the next frame", () => {
    const value = engine();
    const scene = new Scene(value);
    const mesh = MeshBuilder.CreatePlane("plane", {}, scene);
    const wrapper = mesh.subMeshes[0]!._getDrawWrapper(undefined, true)!;
    wrapper._forceRebindOnNextCall = false;
    setNearestTextures(value, true);
    expect(wrapper._forceRebindOnNextCall).toBe(false);
    value.onBeginFrameObservable.notifyObservers(value);
    expect(wrapper._forceRebindOnNextCall).toBe(true);
  });
});
