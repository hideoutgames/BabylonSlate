import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import { createEngine, syncEditorPlayState } from "./create-engine";
import { editorMeshName } from "./scene-loader";

/**
 * The babylon Vitest project runs under Node. createEngine only needs a
 * listener surface plus width/height for registerView.
 */
class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 256, height: 256 };
  }
}

describe("Play createEngine view", () => {
  const handles: Array<{ dispose: () => void }> = [];
  const engines: NullEngine[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.dispose();
    }
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
  });

  function sharedEngine(): NullEngine {
    const engine = new NullEngine();
    engines.push(engine);
    return engine;
  }

  function playHandle(engine: NullEngine) {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: engine,
      playMode: true,
    });
    handles.push(handle);
    return { handle, canvas };
  }

  function editorHandle(engine: NullEngine) {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, { sharedEngine: engine });
    handles.push(handle);
    return { handle, canvas };
  }

  it("does not seed the default Cube into a Play scene", () => {
    const { handle } = playHandle(sharedEngine());
    const actorMeshes = handle.scene.meshes.filter((mesh) =>
      mesh.name.startsWith("editorActor:"),
    );
    expect(actorMeshes).toHaveLength(0);
    expect(handle.scene.getMeshByName(editorMeshName("actor-1"))).toBeNull();
  });

  it("still seeds the default Cube into a non-Play view", () => {
    const { handle } = editorHandle(sharedEngine());
    expect(handle.scene.getMeshByName(editorMeshName("actor-1"))).not.toBeNull();
  });

  it("registerView clears the overlay canvas before copying", () => {
    const engine = sharedEngine();
    const registerView = vi.spyOn(engine, "registerView");
    const { canvas } = playHandle(engine);
    expect(registerView).toHaveBeenCalledWith(canvas, undefined, true);
  });

  it("dispose stops the same render loop callback it registered", () => {
    const engine = sharedEngine();
    const runRenderLoop = vi.spyOn(engine, "runRenderLoop");
    const stopRenderLoop = vi.spyOn(engine, "stopRenderLoop");
    const { handle } = playHandle(engine);
    expect(runRenderLoop).toHaveBeenCalled();
    const callback = runRenderLoop.mock.calls[0]?.[0];
    handle.dispose();
    handles.pop();
    expect(stopRenderLoop).toHaveBeenCalledWith(callback);
  });

  it("Play holds a continuous render lease so every blit is preceded by scene.render", () => {
    const { handle } = playHandle(sharedEngine());
    handle.scheduler.noteRendered();
    expect(handle.scheduler.shouldRender()).toBe(true);
  });

  it("honors an explicit Play frame cap", () => {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
      frameCap: 30,
    });
    handles.push(handle);
    handle.scheduler.noteRendered(0);
    expect(handle.scheduler.shouldRender(20)).toBe(false);
    expect(handle.scheduler.shouldRender(34)).toBe(true);
  });

  it("syncEditorPlayState unpauses, resizes, and invalidates when Play ends", () => {
    const engine = sharedEngine();
    const resize = vi.spyOn(engine, "resize");
    const { handle } = editorHandle(engine);
    handle.setPaused(true);
    handle.scheduler.noteRendered();
    expect(handle.scheduler.shouldRender()).toBe(false);

    syncEditorPlayState(handle, false);

    expect(handle.scheduler.shouldRender()).toBe(true);
    expect(resize).toHaveBeenCalled();
  });

  it("syncEditorPlayState only pauses while Play is open", () => {
    const { handle } = editorHandle(sharedEngine());
    handle.scheduler.invalidate("manual");
    syncEditorPlayState(handle, true);
    expect(handle.scheduler.shouldRender()).toBe(false);
  });
});
