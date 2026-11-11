import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import { EffectRenderer } from "@babylonjs/core/Materials/effectRenderer";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { LayerImageAtlas } from "./layer-image-atlas";
import { limitManagedRenderBytes, managedRenderReservations } from "./managed-render-resources";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** The NullEngine's largest texture, so the page's edge here. */
const PAGE = 512;

/** A Scene with an atlas on a NullEngine that reads texels by index as WebGL2 does, and one frame's before-render work. */
function host(webGLVersion = 2) {
  // Adapted so a raw texture is ready once made, as on the real backends.
  const engine = adaptNullEngineFrameGraph(new NullEngine({ renderWidth: 256, renderHeight: 256, textureSize: 64, deterministicLockstep: false, lockstepMaxSteps: 1 }));
  engines.push(engine);
  Object.defineProperty(engine, "webGLVersion", { get: () => webGLVersion });
  const scene = new Scene(engine);
  const atlas = new LayerImageAtlas(scene);
  return { engine, scene, atlas, frame: () => { scene.onBeforeRenderObservable.notifyObservers(scene); } };
}

/** An image as the resource cache loads a layer's: nearest, without mips, with alpha. */
function image(scene: Scene, width: number, height: number): RawTexture {
  const texture = RawTexture.CreateRGBATexture(new Uint8Array(width * height * 4), width, height, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
  texture.hasAlpha = true;
  return texture;
}

/** The cell's rectangle on the page, in texels. */
function rectangle(cell: { x: number; y: number; width: number; height: number } | null): number[] | null {
  return cell && [cell.x, cell.y, cell.width, cell.height];
}

/** Each copy drawn while `run` runs: the texels its viewport covers, the cell origin it was told, and what it read and wrote. */
function copies(engine: NullEngine, run: () => void): Array<{ viewport: number[]; origin: number[]; source: unknown; target: unknown }> {
  const drawn: Array<{ viewport: number[]; origin: number[]; source: unknown; target: unknown }> = [];
  let origin: number[] = [], source: unknown;
  const setFloat4 = Effect.prototype.setFloat4;
  vi.spyOn(Effect.prototype, "setFloat4").mockImplementation(function (this: Effect, name, x, y, z, w) {
    if (name === "atlasCell") origin = [x, y];
    return setFloat4.call(this, name, x, y, z, w);
  });
  const setTexture = Effect.prototype.setTexture;
  vi.spyOn(Effect.prototype, "setTexture").mockImplementation(function (this: Effect, name, texture) {
    if (name === "atlasSource") source = texture;
    return setTexture.call(this, name, texture);
  });
  const draw = vi.spyOn(EffectRenderer.prototype, "draw").mockImplementation(() => {
    const viewport = engine.currentViewport!;
    drawn.push({
      viewport: [viewport.x * PAGE, viewport.y * PAGE, viewport.width * PAGE, viewport.height * PAGE], origin, source,
      target: engine._currentRenderTarget?.texture,
    });
  });
  try {
    run();
  } finally {
    draw.mockRestore();
    vi.mocked(Effect.prototype.setFloat4).mockRestore();
    vi.mocked(Effect.prototype.setTexture).mockRestore();
  }
  return drawn;
}

describe("the layer image atlas", () => {
  it("gives an image's cell once the frame after its request has copied it", () => {
    const { engine, scene, atlas, frame } = host();
    const first = image(scene, 64, 32), second = image(scene, 16, 16);
    // Asked for, not there yet: the draw that asked samples the image's own texture.
    expect(atlas.cell(first)).toBeNull();
    expect(atlas.cell(second)).toBeNull();
    expect(atlas.counts).toEqual({ images: 2, drawn: 0 });
    const viewport = new Viewport(0, 0, 0.5, 0.5);
    engine.setViewport(viewport);
    const target = engine._currentRenderTarget;
    const drawn = copies(engine, frame);
    // Each copy covers its cell and is told where the cell starts, so a fragment reads the image's texel of its own offset.
    expect(drawn.map(({ viewport, origin }) => ({ viewport, origin }))).toEqual([
      { viewport: [0, 0, 64, 32], origin: [0, 0] },
      { viewport: [64, 0, 16, 16], origin: [64, 0] },
    ]);
    expect(drawn.map(({ source }) => source)).toEqual([first, second]);
    const page = atlas.cell(first)!.page;
    expect(drawn.every((copy) => copy.target === page.getInternalTexture())).toBe(true);
    // The frame draws on from the state it had.
    expect(engine.currentViewport).toBe(viewport);
    expect(engine._currentRenderTarget).toBe(target);
    expect(rectangle(atlas.cell(first))).toEqual([0, 0, 64, 32]);
    expect(rectangle(atlas.cell(second))).toEqual([64, 0, 16, 16]);
    expect(atlas.counts).toEqual({ images: 2, drawn: 2 });
    // Nothing is copied twice.
    expect(copies(engine, frame)).toEqual([]);
  });

  it("gives its page as a texture sampled nearest, with the alpha of the image's texture", () => {
    const { scene, atlas, frame } = host();
    const cutout = image(scene, 8, 8), opaque = image(scene, 8, 8);
    opaque.hasAlpha = false;
    atlas.cell(cutout); atlas.cell(opaque);
    frame();
    const withAlpha = atlas.cell(cutout)!.page, without = atlas.cell(opaque)!.page;
    // One page under two textures: a draw binds whether its texture has alpha with the texture.
    expect(withAlpha).not.toBe(without);
    expect(withAlpha.getInternalTexture()).toBe(without.getInternalTexture());
    expect([withAlpha.hasAlpha, without.hasAlpha]).toEqual([true, false]);
    for (const page of [withAlpha, without]) {
      expect(page.samplingMode).toBe(Constants.TEXTURE_NEAREST_NEAREST);
      expect(page.getSize()).toEqual({ width: PAGE, height: PAGE });
      expect(page.isReady()).toBe(true);
      expect(scene.textures).not.toContain(page);
    }
    // The texture's alpha is read at each request.
    opaque.hasAlpha = true;
    expect(atlas.cell(opaque)!.page).toBe(withAlpha);
  });

  it("leaves an image on its own texture when the page cannot hold its texels as they are, or it is too large", () => {
    const { scene, atlas, frame } = host();
    const texture = (edit: (texture: RawTexture) => void, width = 16, height = 16) => {
      const made = image(scene, width, height);
      edit(made);
      return made;
    };
    const refused: Record<string, BaseTexture> = {
      // One image may not take the page.
      wide: texture(() => {}, 257, 16),
      tall: texture(() => {}, 16, 257),
      // Texels the page's 8-bit colour cannot hold as they are.
      float: texture((made) => { made.getInternalTexture()!.type = Constants.TEXTURETYPE_FLOAT; }),
      srgb: texture((made) => { made.getInternalTexture()!._useSRGBBuffer = true; }),
      compressed: texture((made) => { made.getInternalTexture()!._compression = "astc"; }),
      luminance: texture((made) => { made.getInternalTexture()!.format = Constants.TEXTUREFORMAT_LUMINANCE; }),
      cube: texture((made) => { made.getInternalTexture()!.isCube = true; }),
    };
    const taken = { largest: image(scene, 256, 256), rgb: texture((made) => { made.getInternalTexture()!.format = Constants.TEXTUREFORMAT_RGB; }) };
    for (const made of [...Object.values(refused), ...Object.values(taken)]) atlas.cell(made);
    frame();
    expect(Object.fromEntries(Object.entries(refused).map(([name, made]) => [name, atlas.cell(made)]))).toEqual(
      Object.fromEntries(Object.keys(refused).map((name) => [name, null])));
    expect(rectangle(atlas.cell(taken.largest))).toEqual([0, 0, 256, 256]);
    expect(rectangle(atlas.cell(taken.rgb))).toEqual([256, 0, 16, 16]);
    expect(atlas.counts).toEqual({ images: 2, drawn: 2 });
  });

  it("waits for a texture that is not loaded, and copies it when it is", () => {
    const { engine, scene, atlas, frame } = host();
    const texture = image(scene, 16, 16);
    const internal = texture.getInternalTexture()!;
    internal.isReady = false;
    expect(atlas.cell(texture)).toBeNull();
    expect(copies(engine, frame)).toEqual([]);
    // Nothing was judged or placed while its size and format were unknown.
    expect(atlas.counts).toEqual({ images: 0, drawn: 0 });
    internal.isReady = true;
    expect(atlas.cell(texture)).toBeNull();
    expect(copies(engine, frame)).toHaveLength(1);
    expect(rectangle(atlas.cell(texture))).toEqual([0, 0, 16, 16]);
  });

  it("copies a placed image only once its texture is ready, and the others meanwhile", () => {
    const { engine, scene, atlas, frame } = host();
    const slow = image(scene, 16, 16), quick = image(scene, 16, 16);
    atlas.cell(slow); atlas.cell(quick);
    // As a restored context leaves a texture until it has loaded again.
    slow.getInternalTexture()!.isReady = false;
    expect(copies(engine, frame).map(({ source }) => source)).toEqual([quick]);
    expect(atlas.cell(quick)).not.toBeNull();
    expect(atlas.cell(slow)).toBeNull();
    slow.getInternalTexture()!.isReady = true;
    expect(copies(engine, frame).map(({ source }) => source)).toEqual([slow]);
    expect(rectangle(atlas.cell(slow))).toEqual([0, 0, 16, 16]);
  });

  it("gives a disposed texture's cell to the next image that fits it", () => {
    const { engine, scene, atlas, frame } = host();
    const first = image(scene, 32, 32), second = image(scene, 32, 32);
    atlas.cell(first); atlas.cell(second);
    frame();
    first.dispose();
    expect(atlas.counts).toEqual({ images: 1, drawn: 1 });
    // Smaller than the freed slot: it sits in the slot's corner, and its copy covers its own texels alone.
    const next = image(scene, 16, 8);
    atlas.cell(next);
    expect(copies(engine, frame).map(({ viewport, origin }) => ({ viewport, origin }))).toEqual([{ viewport: [0, 0, 16, 8], origin: [0, 0] }]);
    expect(rectangle(atlas.cell(next))).toEqual([0, 0, 16, 8]);
    expect(rectangle(atlas.cell(second))).toEqual([32, 0, 32, 32]);
  });

  it("copies a reloaded texture again", () => {
    const { engine, scene, atlas, frame } = host();
    const texture = image(scene, 16, 16);
    atlas.cell(texture);
    frame();
    expect(atlas.cell(texture)).not.toBeNull();
    // A reload gives the texture other storage, whose texels the page does not hold.
    const reloaded = image(scene, 24, 24);
    texture._texture = reloaded.getInternalTexture();
    expect(atlas.cell(texture)).toBeNull();
    // Larger than the cell it had, so it goes beside it.
    expect(copies(engine, frame).map(({ origin, source }) => ({ origin, source }))).toEqual([{ origin: [16, 0], source: texture }]);
    expect(rectangle(atlas.cell(texture))).toEqual([16, 0, 24, 24]);
    expect(atlas.counts).toEqual({ images: 1, drawn: 1 });
  });

  it("keeps an image the page has no room for on its own texture until a cell that holds it goes", () => {
    const { engine, scene, atlas, frame } = host();
    // Two shelves of two 256 px images fill the page's 512 texels.
    const large = [0, 1, 2, 3].map(() => image(scene, 256, 256));
    for (const texture of large) atlas.cell(texture);
    frame();
    expect(large.map((texture) => rectangle(atlas.cell(texture)))).toEqual([[0, 0, 256, 256], [256, 0, 256, 256], [0, 256, 256, 256], [256, 256, 256, 256]]);
    const extra = image(scene, 100, 100);
    expect(atlas.cell(extra)).toBeNull();
    expect(copies(engine, frame)).toEqual([]);
    expect(atlas.counts).toEqual({ images: 4, drawn: 4 });
    // A cell goes: the freed slot holds the smaller image.
    large[1]!.dispose();
    atlas.cell(extra);
    frame();
    expect(rectangle(atlas.cell(extra))).toEqual([256, 0, 100, 100]);
    // That slot is taken and no other is free: another large image has no room, and nothing moves for it.
    const late = image(scene, 256, 256);
    expect(atlas.cell(late)).toBeNull();
    expect(copies(engine, frame)).toEqual([]);
    expect(rectangle(atlas.cell(large[0]!))).toEqual([0, 0, 256, 256]);
    // The small image goes too: its freed slot is a whole 256, so the large one takes it as it is.
    extra.dispose();
    atlas.cell(late);
    expect(copies(engine, frame).map(({ origin }) => origin)).toEqual([[256, 0]]);
    expect(rectangle(atlas.cell(late))).toEqual([256, 0, 256, 256]);
  });

  it("packs the page again, tallest first, when a freed slot cannot hold an image the page has room for", () => {
    const { engine, scene, atlas, frame } = host();
    // Three full shelves: four 128 px cells, two 256 px ones, four more 128 wide.
    const small = [0, 1, 2, 3].map(() => image(scene, 128, 128));
    const tall = [0, 1].map(() => image(scene, 256, 256));
    const low = [0, 1, 2, 3].map(() => image(scene, 128, 120));
    for (const texture of [...small, ...tall, ...low]) atlas.cell(texture);
    frame();
    expect(rectangle(atlas.cell(tall[1]!))).toEqual([256, 128, 256, 256]);
    expect(rectangle(atlas.cell(low[3]!))).toEqual([384, 384, 128, 120]);
    // Two small cells go. A 200 px image fits neither freed slot (128 wide), but the page has the room in all.
    small[0]!.dispose(); small[1]!.dispose();
    const wide = image(scene, 200, 100);
    expect(atlas.cell(wide)).toBeNull();
    // Every cell moved, so none is given out until the frame has drawn it where it is now.
    expect(atlas.counts).toEqual({ images: 9, drawn: 0 });
    expect(atlas.cell(tall[0]!)).toBeNull();
    const drawn = copies(engine, frame);
    expect(drawn.map(({ origin }) => origin)).toEqual([
      [0, 0], [256, 0],
      [0, 256], [128, 256], [256, 256], [384, 256],
      [0, 384], [128, 384], [256, 384],
    ]);
    expect(drawn.map(({ source }) => source)).toEqual([...tall, small[2], small[3], ...low, wide]);
    expect(rectangle(atlas.cell(wide))).toEqual([256, 384, 200, 100]);
    expect(rectangle(atlas.cell(small[2]!))).toEqual([0, 256, 128, 128]);
    expect(atlas.counts).toEqual({ images: 9, drawn: 9 });
  });

  it("draws every cell again after the context is restored, as the page comes back empty", () => {
    const { engine, scene, atlas, frame } = host();
    const first = image(scene, 16, 16), second = image(scene, 16, 16);
    atlas.cell(first); atlas.cell(second);
    frame();
    engine.onContextRestoredObservable.notifyObservers(engine);
    expect(atlas.cell(first)).toBeNull();
    expect(atlas.counts).toEqual({ images: 2, drawn: 0 });
    expect(copies(engine, frame).map(({ origin }) => origin)).toEqual([[0, 0], [16, 0]]);
    expect(rectangle(atlas.cell(second))).toEqual([16, 0, 16, 16]);
  });

  it("holds its page on the managed rendering ledger and gives it back", async () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine({ renderWidth: 256, renderHeight: 256, textureSize: 64, deterministicLockstep: false, lockstepMaxSteps: 1 }));
    engines.push(engine);
    Object.defineProperty(engine, "webGLVersion", { get: () => 2 });
    const scene = new Scene(engine);
    const atlas = new LayerImageAtlas(scene);
    // The observers it added: the Scene's first before-render work, and the Engine's last context-restored one.
    const added = [scene.onBeforeRenderObservable.observers[0]!, engine.onContextRestoredObservable.observers.at(-1)!];
    expect(added.map((observer) => observer._willBeUnregistered)).toEqual([false, false]);
    const frame = () => { scene.onBeforeRenderObservable.notifyObservers(scene); };
    const before = managedRenderReservations(engine).reservedBytes;
    const texture = image(scene, 16, 16);
    atlas.cell(texture);
    frame();
    // 512 × 512 texels of four bytes.
    expect(managedRenderReservations(engine).reservedBytes - before).toBe(PAGE * PAGE * 4);
    const page = atlas.cell(texture)!.page.getInternalTexture()!;
    // The target and each of the two wrappers hold the page.
    expect(page._references).toBe(3);
    atlas.dispose();
    await Promise.resolve();
    expect(managedRenderReservations(engine).reservedBytes).toBe(before);
    expect(page._references).toBe(0);
    // Its observers are gone: a frame and a disposed texture reach nothing.
    expect(added.map((observer) => observer._willBeUnregistered)).toEqual([true, true]);
    expect(copies(engine, frame)).toEqual([]);
    texture.dispose();
    expect(atlas.cell(image(scene, 16, 16))).toBeNull();
  });

  it("makes no page where the ledger has no room for it, or texels cannot be read by index", () => {
    const limited = host();
    // One byte short of the page.
    limitManagedRenderBytes(limited.engine, PAGE * PAGE * 4 - 1);
    const refused = image(limited.scene, 16, 16);
    limited.atlas.cell(refused);
    limited.frame();
    expect(limited.atlas.cell(refused)).toBeNull();
    expect(limited.atlas.counts).toEqual({ images: 0, drawn: 0 });
    expect(managedRenderReservations(limited.engine).reservedBytes).toBe(0);
    const webgl1 = host(1);
    const texture = image(webgl1.scene, 16, 16);
    webgl1.atlas.cell(texture);
    webgl1.frame();
    expect(webgl1.atlas.cell(texture)).toBeNull();
    expect(managedRenderReservations(webgl1.engine).reservedBytes).toBe(0);
  });
});
