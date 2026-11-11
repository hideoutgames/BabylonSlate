import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, expect, it, vi } from "vitest";
// Registers `createInstance`.
import { type InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import "@babylonjs/core/Meshes/instancedMesh";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** The lists of visible instances Babylon keeps for a source, one for each render id that registered an instance. */
type VisibleInstances = Record<number, InstancedMesh[]> | null;

/**
 * The frame graph draws every pass through an object renderer and never evaluates the Scene's active meshes, the
 * step that starts a source's record of visible instances anew. On WebGL2 the source then kept the list of every
 * pass of every frame.
 */
it("keeps a source's visible instances for the current frame's passes only when object renderers draw it", async () => {
  const engine = new NullEngine();
  engines.push(engine);
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
  const source = MeshBuilder.CreateBox("source", {}, scene);
  source.material = new StandardMaterial("surface", scene);
  source.isVisible = false;
  const instances = [source.createInstance("first"), source.createInstance("second")];
  const renderer = new ObjectRenderer("pass", scene);
  renderer.activeCamera = camera;
  renderer.renderList = instances;
  const drawn = vi.spyOn(engine, "drawElementsType");
  const PASSES = 3;
  const frame = () => {
    engine.beginFrame();
    for (let pass = 0; pass < PASSES; pass += 1) {
      scene.incrementRenderId();
      renderer.initRender(64, 64);
      renderer.render();
      renderer.finishRender();
    }
    engine.endFrame();
  };
  // The NullEngine's Effects are ready a task after their first request.
  await vi.waitFor(() => { frame(); expect(drawn).toHaveBeenCalled(); });
  const lists = () => {
    const record = (source._instanceDataStorage as unknown as { dataStorageRenderPass: { visibleInstances: VisibleInstances } })
      .dataStorageRenderPass.visibleInstances;
    return Object.keys(record ?? {}).filter((key) => /^\d+$/.test(key)).length;
  };
  for (let index = 0; index < 5; index += 1) {
    drawn.mockClear();
    frame();
    expect(lists()).toBe(PASSES);
    // Every pass still draws both instances in one call.
    expect(drawn.mock.calls.map(([, , , count]) => count)).toEqual([2, 2, 2]);
  }
  renderer.dispose();
  scene.dispose();
});
