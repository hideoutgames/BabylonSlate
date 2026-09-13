import { afterEach, expect, it, vi } from "vitest";
import {
  Constants,
  NullEngine,
  Scene,
  type Texture,
  type CubeTexture,
} from "@babylonjs/core";
import { ResourceCache } from "./resource-cache";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function ktx2(width = 8, height = 4, levels = 4) {
  const bytes = new Uint8Array(80);
  bytes.set([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const header = new DataView(bytes.buffer);
  header.setUint32(20, width, true);
  header.setUint32(24, height, true);
  header.setUint32(36, 1, true);
  header.setUint32(40, levels, true);
  return bytes;
}

function host() {
  const engine = new NullEngine();
  const cache = new ResourceCache();
  const create = engine.createTexture.bind(engine);
  // Keep real wrappers/cache/refcounts; control only NullEngine's pretend GPU
  // completion so source reservation and delayed real upload can be observed.
  vi.spyOn(engine, "createTexture").mockImplementation((...args) => {
    args[5] = null;
    const internal = create(...args);
    internal.isReady = false;
    return internal;
  });
  disposers.push(() => {
    cache.dispose();
    engine.dispose();
  });
  return { engine, cache };
}

function uploaded(
  texture: Texture | CubeTexture,
  format: number,
  width = 8,
  height = 4,
  mips = true,
) {
  const internal = texture.getInternalTexture()!;
  Object.assign(internal, {
    width,
    height,
    format,
    type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
    generateMipMaps: mips,
    isReady: true,
  });
  texture.onLoadObservable.notifyObservers(texture as never);
}

it("reserves RGBA then independently accounts compressed and fallback sampling variants", () => {
  const { cache, engine } = host();
  const bytes = ktx2();
  const compressed = cache.getTexture("atlas", engine, bytes);
  expect(cache.accountedBytes()).toBe(172);
  expect(cache.getTexture("atlas", engine, bytes)).toBe(compressed);
  expect(cache.accountedBytes()).toBe(172);
  uploaded(compressed, Constants.TEXTUREFORMAT_COMPRESSED_RGBA_ASTC_4x4);
  expect(cache.accountedBytes()).toBe(80);
  const fallback = cache.getTexture("atlas", engine, bytes, { noMipmap: true });
  expect(cache.accountedBytes()).toBe(252);
  // Babylon uploads every KTX2 mip even for this no-mip sampling request, and
  // its RGBA uploader leaves dimensions at the final 1x1 mip.
  uploaded(fallback, Constants.TEXTUREFORMAT_RGBA, 1, 1);
  expect(cache.accountedBytes()).toBe(252);
  compressed.dispose();
  expect(cache.accountedBytes()).toBe(172);
  fallback.dispose();
  expect(cache.accountedBytes()).toBe(0);
});

it("uses uploaded raster dimensions and partial KTX2 mip chains", () => {
  const { cache, engine } = host();
  const partial = cache.getTexture("partial", engine, ktx2(8, 4, 2));
  expect(cache.accountedBytes()).toBe(160);
  uploaded(partial, Constants.TEXTUREFORMAT_COMPRESSED_RGBA_BPTC_UNORM);
  expect(cache.accountedBytes()).toBe(48);
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  const header = new DataView(png.buffer);
  header.setUint32(16, 8);
  header.setUint32(20, 4);
  const raster = cache.getTexture("raster", engine, png);
  expect(cache.accountedBytes()).toBe(220);
  uploaded(raster, Constants.TEXTUREFORMAT_RGBA, 4, 2, false);
  expect(cache.accountedBytes()).toBe(80);
});

it("clears observer accounting on context release and ignores retired upload notifications", () => {
  const { cache, engine } = host();
  const bytes = ktx2();
  const old = cache.getTexture("atlas", engine, bytes);
  cache.releaseGpuTextures();
  expect(cache.accountedBytes()).toBe(0);
  expect(old.onLoadObservable.hasObservers()).toBe(false);
  const replacement = cache.getTexture("atlas", engine, bytes);
  uploaded(replacement, Constants.TEXTUREFORMAT_COMPRESSED_RGBA_ASTC_4x4);
  old.onLoadObservable.notifyObservers(old as never);
  expect(cache.accountedBytes()).toBe(80);
  cache.dispose();
  replacement.onLoadObservable.notifyObservers(replacement as never);
  expect(cache.accountedBytes()).toBe(0);
});

it("reads Blob KTX2 headers without a late header reviving a disposed generation", async () => {
  const { cache, engine } = host();
  const bytes = new Blob([ktx2()], { type: "image/ktx2" });
  let complete!: (buffer: ArrayBuffer) => void;
  const header = new Blob();
  vi.spyOn(header, "arrayBuffer").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const slice = vi.spyOn(bytes, "slice").mockReturnValue(header);
  const old = cache.getTexture("atlas", engine, bytes);
  cache.releaseGpuTextures();
  slice.mockRestore();
  const replacement = cache.getTexture("atlas", engine, bytes);
  uploaded(replacement, Constants.TEXTUREFORMAT_RGBA, 1, 1);
  await vi.waitFor(() => expect(cache.accountedBytes()).toBe(172));
  complete(ktx2(64, 64).buffer);
  await Promise.resolve();
  expect(old.onLoadObservable.hasObservers()).toBe(false);
  expect(cache.accountedBytes()).toBe(172);
});

it("counts real six-face cube allocation and releases it after the final lease", () => {
  const { cache, engine } = host();
  const scene = new Scene(engine);
  const cube = cache.getCubeTextureFromImages(
    "sky",
    scene,
    ["px", "py", "pz", "nx", "ny", "nz"],
    true,
  );
  uploaded(cube, Constants.TEXTUREFORMAT_RGB, 8, 8, false);
  expect(cache.accountedBytes()).toBe(1152);
  cache.release(cube);
  cache.flushUnreferenced();
  expect(cache.accountedBytes()).toBe(0);
  expect(cube.onLoadObservable.hasObservers()).toBe(false);
  scene.dispose();
});
