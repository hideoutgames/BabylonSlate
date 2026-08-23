import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import { createEngine } from "./create-engine";

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

  getBoundingClientRect(): DOMRect {
    return {
      width: this.clientWidth,
      height: this.clientHeight,
      left: 0,
      top: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

describe("createEngine context events", () => {
  const handles: Array<{ dispose(): void }> = [];
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.dispose();
  });

  it("reports lost/restored with elapsed time", () => {
    const engine = new NullEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const onContextEvent = vi.fn();
    const handle = createEngine(canvas, { sharedEngine: engine, onContextEvent });
    handles.push(handle);

    expect(onContextEvent).not.toHaveBeenCalled();

    handle.engine.onContextLostObservable.notifyObservers({});
    expect(onContextEvent).toHaveBeenCalledWith("lost");

    handle.engine.onContextRestoredObservable.notifyObservers({});
    expect(onContextEvent).toHaveBeenCalledTimes(2);
    const [, elapsedMs] = onContextEvent.mock.calls[1]!;
    expect(typeof elapsedMs).toBe("number");
    expect(elapsedMs as number).toBeGreaterThanOrEqual(0);
  });

  it("does not drop the resolution tier on restore", () => {
    const engine = new NullEngine();
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, { sharedEngine: engine });
    handles.push(handle);

    const levelBefore = handle.scaling.getLevel();
    handle.engine.onContextRestoredObservable.notifyObservers({});
    // Repeated losses must not progressively blur the viewport: the frame-time
    // valve owns quality now, not the restore path.
    handle.engine.onContextLostObservable.notifyObservers({});
    handle.engine.onContextRestoredObservable.notifyObservers({});
    expect(handle.scaling.getLevel()).toBe(levelBefore);
  });
});
