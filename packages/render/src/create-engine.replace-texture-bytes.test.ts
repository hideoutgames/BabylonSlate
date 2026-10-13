import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, type NodeMaterial } from "@babylonjs/core";
import { createActor, createDefaultScene, createMeshComponent } from "@babylonslate/core";
import { createEngine } from "./create-engine";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { sampledTextureDocument } from "./sampled-texture-material-fixture";
import { ktx2HeaderBytes } from "./texture-test-fixtures";

class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}

const PNG = new Uint8Array([1, 2, 3, 4]);
const KTX2 = ktx2HeaderBytes(4, 4);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

function editorHandle() {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  const handle = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
  cleanups.push(() => { handle.dispose(); engine.dispose(); });
  return handle;
}

describe("EngineHandle.replaceTextureBytes", () => {
  it("replaces nothing before any Texture is installed", () => {
    const handle = editorHandle();
    expect(handle.replaceTextureBytes(new Map([["tex", KTX2]]))).toEqual([]);
  });

  it("installs the bytes before syncing the scene, and skips Textures never installed or already identical", async () => {
    const handle = editorHandle();
    const sync = handle.editor!.sync;
    const swap = vi.spyOn(sync, "replaceTextureEncodings");
    handle.setMaterialDocuments(new Map([["mat", sampledTextureDocument("tex")]]));
    handle.setMeshAssets({ resourceCache: handle.resourceCache, textureBytes: new Map([["tex", PNG]]) });
    const component = createMeshComponent("c1", "box");
    component.properties.materialGuid = "mat";
    handle.loadScene({ ...createDefaultScene(), actors: [createActor("a", "A", { components: [component] })] });
    const root = sync.meshForActor("a")!;
    const first = root.material as NodeMaterial;
    await handle.whenMaterialTexturesReady();
    await handle.prewarmSceneMaterials();

    // A guid the scene never installed is a structural change, and a fresh array with the same bytes is no change.
    expect(handle.replaceTextureBytes(new Map([["never-installed", KTX2]]))).toEqual([]);
    expect(handle.replaceTextureBytes(new Map([["tex", new Uint8Array(PNG)]]))).toEqual([]);
    expect(swap).not.toHaveBeenCalled();
    expect(root.material).toBe(first);

    expect(handle.replaceTextureBytes(new Map([["tex", KTX2], ["never-installed", KTX2]]))).toEqual(["tex"]);
    expect(swap).toHaveBeenCalledOnce();
    const [installed, guids] = swap.mock.calls[0]!;
    expect(guids).toEqual(["tex"]);
    expect([...installed.keys()]).toEqual(["tex"]);
    expect((installed.get("tex") as Blob).type).toBe("image/ktx2");
    // The Material library reads the engine's installed bytes for its texture identity. The scene refresh inside
    // the sync call can only promote a new generation if they were replaced before it.
    await vi.waitFor(() => expect(root.material).not.toBe(first), { timeout: 5000 });
    expect(sync.meshForActor("a")).toBe(root);
    expect(root.isDisposed()).toBe(false);

    // The swap is the baseline: installing the same bytes through setMeshAssets rebuilds nothing.
    handle.setMeshAssets({ resourceCache: handle.resourceCache, textureBytes: new Map([["tex", KTX2]]) });
    expect(sync.meshForActor("a")).toBe(root);
  });
});
