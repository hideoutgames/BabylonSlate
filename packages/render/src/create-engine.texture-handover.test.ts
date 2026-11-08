import { mockCubeTextureIO } from "./texture-test-fixtures";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { createEngine } from "./create-engine";
import type { EngineHandle } from "./create-engine-types";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { encodeRgbaPng } from "./png-encode";
import { acquireMaterialTexture } from "./resource-cache";

class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  readonly style = { cursor: "", touchAction: "" };
  focus(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  setPointerCapture(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  getContext(kind: string): unknown {
    if (kind === "2d") return { clearRect() {}, drawImage() {} };
    return null;
  }
}

/** Textures of distinct content. */
const TEXTURES = {
  shared: encodeRgbaPng(2, 2, new Uint8Array(16).fill(10)),
  editorOnly: encodeRgbaPng(2, 2, new Uint8Array(16).fill(20)),
  playOnly: encodeRgbaPng(2, 2, new Uint8Array(16).fill(30)),
  spare: encodeRgbaPng(2, 2, new Uint8Array(16).fill(40)),
};
type TextureName = keyof typeof TEXTURES;
const sources = (names: TextureName[]) => new Map(names.map((name) => [name, TEXTURES[name]]));

/**
 * Editor Play on the editor's Engine: Play starts by releasing the editor's Scene view and loading its own, and stops by
 * releasing its view and reloading the editor's. Each view's Materials sample textures through the view's cache owner,
 * from the texture sources the view was given.
 */
describe("textures handed over between the editor's view and Play", () => {
  const handles: Array<{ dispose: () => void }> = [];
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (handles.length > 0) handles.pop()?.dispose();
    while (engines.length > 0) engines.pop()?.dispose();
    vi.restoreAllMocks();
  });

  function sharedEngine(): NullEngine {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engine.customAnimationFrameRequester = { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
    mockCubeTextureIO(engine);
    Object.assign(engine.getCaps(), {
      maxTextureSize: 4096, maxDrawBuffers: 4, drawBuffersExtension: true,
      depthTextureExtension: true, textureFloatRender: true, textureHalfFloatRender: true,
    });
    vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(new FakeCanvas() as unknown as HTMLCanvasElement);
    engines.push(engine);
    return engine;
  }

  /**
   * The textures uploaded to the Engine, in order, by name. An upload carries its bytes as a buffer or, for an image,
   * loads them from the object URL of the cache's Blob, so `names` reads the Blob behind each URL.
   */
  function recordUploads(engine: NullEngine): { names: () => Promise<TextureName[]> } {
    const uploads: Array<Uint8Array | Blob | undefined> = [];
    const blobs = new Map<string, Blob>();
    const createObjectURL = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
      const url = createObjectURL(object);
      if (object instanceof Blob) blobs.set(url, object);
      return url;
    });
    const createTexture = engine.createTexture.bind(engine);
    vi.spyOn(engine, "createTexture").mockImplementation((...args) => {
      const [url, , , , , , , buffer] = args;
      uploads.push(buffer instanceof Uint8Array ? buffer : typeof url === "string" ? blobs.get(url) : undefined);
      return createTexture(...args);
    });
    return {
      names: async () => {
        const names: TextureName[] = [];
        for (const upload of uploads) {
          const bytes = upload instanceof Blob ? new Uint8Array(await upload.arrayBuffer()) : upload;
          const name = (Object.keys(TEXTURES) as TextureName[]).find((key) =>
            bytes !== undefined && Buffer.from(bytes).equals(Buffer.from(TEXTURES[key])));
          if (name) names.push(name);
        }
        return names;
      },
    };
  }

  function sample(handle: EngineHandle, engine: NullEngine, names: TextureName[]): Partial<Record<TextureName, Texture>> {
    return Object.fromEntries(names.map((name) =>
      [name, acquireMaterialTexture(handle.resourceCache, name, engine, TEXTURES[name])!.resource]));
  }

  /** The editor's Scene view, given its texture sources as its scene load installs them. */
  function editorView(engine: NullEngine, named: TextureName[]) {
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
    handles.push(handle);
    handle.setMeshAssets({ resourceCache: handle.resourceCache, textureBytes: sources(named) });
    return handle;
  }

  /** Play's view, given the startup sources Play prepared. */
  function playView(engine: NullEngine, named: TextureName[]) {
    const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, {
      sharedEngine: engine, playMode: true, textureBytes: sources(named),
    });
    handles.push(handle);
    return handle;
  }

  /** A view released for the next world view on its Engine, as Play's start and stop release them. */
  async function release(handle: EngineHandle): Promise<void> {
    handle.handOverTextures();
    handle.dispose();
    await handle.whenReleased();
  }

  async function presentFirstFrame(handle: EngineHandle, engine: NullEngine): Promise<void> {
    await handle.prewarmSceneMaterials();
    const presented = handle.presentFirstFrame();
    handle.scheduler.invalidate("manual");
    engine.onBeginFrameObservable.notifyObservers(engine);
    engine._renderViews();
    engine.onEndFrameObservable.notifyObservers(engine);
    await presented;
  }

  it("uploads a texture both views sample once across Play starting and stopping", async () => {
    const engine = sharedEngine();
    const uploads = recordUploads(engine);
    const editor = editorView(engine, ["shared", "editorOnly"]);
    const edited = sample(editor, engine, ["shared", "editorOnly"]);
    await release(editor);
    const play = playView(engine, ["shared", "playOnly"]);
    const played = sample(play, engine, ["shared", "playOnly"]);
    await presentFirstFrame(play, engine);
    await release(play);
    const reloaded = editorView(engine, ["shared", "editorOnly"]);
    const shown = sample(reloaded, engine, ["shared", "editorOnly"]);
    expect(played.shared).toBe(edited.shared);
    expect(shown.shared).toBe(edited.shared);
    expect(isDisposedGpuTexture(shown.shared!)).toBe(false);
    // What only the editor samples was released for Play, so its reload uploads it again.
    expect(await uploads.names()).toEqual(["shared", "editorOnly", "playOnly", "editorOnly"]);
  });

  it("releases the editor's textures Play does not name before Play's view loads anything", async () => {
    const engine = sharedEngine();
    const editor = editorView(engine, ["shared", "editorOnly"]);
    const edited = sample(editor, engine, ["shared", "editorOnly"]);
    await release(editor);
    playView(engine, ["shared", "playOnly"]);
    expect(isDisposedGpuTexture(edited.editorOnly!)).toBe(true);
    expect(isDisposedGpuTexture(edited.shared!)).toBe(false);
  });

  it("releases a texture Play names but does not sample by the time Play presents its first frame", async () => {
    const engine = sharedEngine();
    const editor = editorView(engine, ["shared", "spare"]);
    const edited = sample(editor, engine, ["shared", "spare"]);
    await release(editor);
    const play = playView(engine, ["shared", "spare"]);
    sample(play, engine, ["shared"]);
    // Play's load may still sample it.
    expect(isDisposedGpuTexture(edited.spare!)).toBe(false);
    await presentFirstFrame(play, engine);
    expect(isDisposedGpuTexture(edited.spare!)).toBe(true);
    expect(isDisposedGpuTexture(edited.shared!)).toBe(false);
  });

  it("releases a texture Play names but does not sample when Play's load fails", async () => {
    const engine = sharedEngine();
    const editor = editorView(engine, ["spare"]);
    const edited = sample(editor, engine, ["spare"]);
    await release(editor);
    const play = playView(engine, ["spare"]);
    await play.prewarmSceneMaterials();
    const presented = play.presentFirstFrame();
    presented.catch(() => {});
    expect(isDisposedGpuTexture(edited.spare!)).toBe(false);
    engine.onContextLostObservable.notifyObservers(engine);
    await expect(presented).rejects.toThrow("Rendering context was lost");
    expect(isDisposedGpuTexture(edited.spare!)).toBe(true);
  });

  it("releases Play's own textures the editor does not name before the editor's view loads anything", async () => {
    const engine = sharedEngine();
    const editor = editorView(engine, ["shared"]);
    sample(editor, engine, ["shared"]);
    await release(editor);
    const play = playView(engine, ["shared", "playOnly"]);
    const played = sample(play, engine, ["shared", "playOnly"]);
    await presentFirstFrame(play, engine);
    await release(play);
    // Kept for the editor's view until it names its sources.
    expect(isDisposedGpuTexture(played.playOnly!)).toBe(false);
    editorView(engine, ["shared"]);
    expect(isDisposedGpuTexture(played.playOnly!)).toBe(true);
    expect(isDisposedGpuTexture(played.shared!)).toBe(false);
  });

  it("hands the editor's textures back when Play stops before it samples them", async () => {
    const engine = sharedEngine();
    const uploads = recordUploads(engine);
    const editor = editorView(engine, ["shared", "spare"]);
    const edited = sample(editor, engine, ["shared", "spare"]);
    await release(editor);
    const play = playView(engine, ["shared", "spare", "playOnly"]);
    await release(play);
    const reloaded = editorView(engine, ["shared", "spare"]);
    const shown = sample(reloaded, engine, ["shared", "spare"]);
    expect(shown.shared).toBe(edited.shared);
    expect(shown.spare).toBe(edited.spare);
    expect(await uploads.names()).toEqual(["shared", "spare"]);
  });

  it("flushes a released view's textures at once when it does not hand them over", async () => {
    const engine = sharedEngine();
    const editor = editorView(engine, ["shared"]);
    const edited = sample(editor, engine, ["shared"]);
    editor.dispose();
    await editor.whenReleased();
    expect(isDisposedGpuTexture(edited.shared!)).toBe(true);
  });
});
