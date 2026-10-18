import { mockCubeTextureIO } from "./texture-test-fixtures";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { enableHeadlessCascades } from "./shadow-test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_VISIBLE,
  snapshotFloatCount,
  writeActorSlot,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import { createDefaultScene } from "@babylonslate/core";
import { createEngine } from "./create-engine";
import { describeEngineTexture } from "./resource-cache";

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

/** The textures a Basic 3D Play session creates: default sky cube, the engine default material's checker and the sun's shadow map. */
describe("textures across a Play cycle", () => {
  const handles: Array<{ dispose: () => void }> = [];
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (handles.length > 0) handles.pop()?.dispose();
    while (engines.length > 0) engines.pop()?.dispose();
  });

  function sharedEngine(): NullEngine {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engine.customAnimationFrameRequester = { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
    mockCubeTextureIO(engine);
    // ThinEngine lists raw textures in its cache; NullEngine does not.
    const createRawTexture = engine.createRawTexture.bind(engine);
    engine.createRawTexture = (...args: Parameters<typeof createRawTexture>) => {
      const texture = createRawTexture(...args);
      engine.getLoadedTexturesCache().push(texture);
      return texture;
    };
    Object.assign(engine.getCaps(), {
      maxTextureSize: 4096, maxDrawBuffers: 4, drawBuffersExtension: true,
      depthTextureExtension: true, textureFloatRender: true, textureHalfFloatRender: true,
    });
    enableHeadlessCascades(engine);
    engines.push(engine);
    return engine;
  }

  async function frames(engine: NullEngine, count: number): Promise<void> {
    for (let frame = 0; frame < count; frame++) {
      if (!engine.getRenderingCanvas())
        vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(new FakeCanvas() as unknown as HTMLCanvasElement);
      engine.beginFrame(); engine._renderViews(); engine.endFrame();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** What the session left live that `before` lacked, named as a leak report would. NullEngine keeps released cache slots, so only referenced textures count. */
  function retained(engine: NullEngine, before: ReadonlySet<unknown>): string[] {
    return engine.getLoadedTexturesCache().filter((texture) => !before.has(texture) && texture._references > 0)
      .map((texture) => describeEngineTexture(engine, texture).name);
  }

  function startPlay(engine: NullEngine) {
    const play = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, playMode: true });
    const scene = createDefaultScene();
    play.loadScene(scene, { sceneAssetGuid: "scene" });
    play.applySceneEnvironment(scene);
    const part = (componentId: string, meshKind: string) => ({ componentId, meshKind,
      position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
    play.applyCommand({ type: "spawn", slotId: 1, actorGuid: "crate", classId: "Actor" });
    play.applyCommand({ type: "assignMesh", slotId: 1, actorGuid: "crate", meshAssetGuid: null, meshKind: "box" });
    play.applyCommand({ type: "spawn", slotId: 2, actorGuid: "sky", classId: "Actor" });
    play.applyCommand({ type: "assignMesh", slotId: 2, meshAssetGuid: null, meshKind: "skybox", actorGuid: "sky",
      skybox: { size: 1000, faces: { px: null, py: null, pz: null, nx: null, ny: null, nz: null } } });
    play.applyCommand({ type: "spawn", slotId: 3, actorGuid: "sun", classId: "Actor" });
    play.applyCommand({ type: "assignMesh", slotId: 3, meshAssetGuid: null, meshKind: null, actorGuid: "sun", parts: [
      { ...part("sun-light", "light:directional"), light: { color: [1, 1, 1], intensity: 1.5, enabled: true, castShadows: true } }] });
    play.applyCommand({ type: "spawn", slotId: 4, actorGuid: "camera", classId: "Actor" });
    play.applyCommand({ type: "assignMesh", slotId: 4, meshAssetGuid: null, meshKind: null, actorGuid: "camera", parts: [
      { ...part("lens", "camera"), camera: { fieldOfView: 60, isDefault: true } }] });
    const snapshot = new Float32Array(snapshotFloatCount(8));
    writeSnapshotHeader(snapshot, { frameId: 1, tickIndex: 1, actorCount: 4, scriptMs: 0, physicsMs: 0 });
    const pose = (index: number, slotId: number, position: { x: number; y: number; z: number }, rotation = { x: 0, y: 0, z: 0, w: 1 }) =>
      writeActorSlot(snapshot, index, { slotId, position, rotation, scale: { x: 1, y: 1, z: 1 }, flags: SNAPSHOT_FLAG_VISIBLE });
    pose(0, 1, { x: 0, y: 1, z: 0 });
    pose(1, 2, { x: 0, y: 0, z: 0 });
    pose(2, 3, { x: 5, y: 8, z: -5 }, { x: 0.3827, y: 0, z: 0, w: 0.9239 });
    pose(3, 4, { x: 0, y: 3, z: -10 });
    play.pushSnapshot(snapshot);
    return play;
  }

  it.each([true, false])("returns every texture a Play session created once it is released, cycle after cycle (editor viewport open: %s)", async (withEditor) => {
    const engine = sharedEngine();
    if (withEditor) {
      const editor = createEngine(new FakeCanvas() as unknown as HTMLCanvasElement, { sharedEngine: engine, editor: true });
      handles.push(editor);
      editor.loadScene(createDefaultScene(), { sceneAssetGuid: "scene" });
      await frames(engine, 2);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = new Set(engine.getLoadedTexturesCache());
      const play = startPlay(engine);
      await frames(engine, 6);
      // The sun's shadow map and its depth are among what the session created.
      expect(retained(engine, before).length).toBeGreaterThanOrEqual(2);
      play.dispose();
      await play.whenReleased();
      expect(retained(engine, before), `cycle ${cycle}`).toEqual([]);
    }
  });

  it("returns every texture when Play stops before any frame or upload has finished", async () => {
    const engine = sharedEngine();
    const before = new Set(engine.getLoadedTexturesCache());
    const play = startPlay(engine);
    play.dispose();
    await play.whenReleased();
    await frames(engine, 4);
    expect(retained(engine, before)).toEqual([]);
  });
});
