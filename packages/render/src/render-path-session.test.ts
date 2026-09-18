import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";
import {
  renderPathSession,
  requestRenderPath,
  subscribeRenderPathSession,
} from "./render-path-session";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function fixture(engine = new NullEngine()) {
  if (!engines.includes(engine)) engines.push(engine);
  return { engine, scene: new Scene(engine) };
}

describe("render path session", () => {
  it("defaults to an empty request so scenes inherit the project path", () => {
    const { engine } = fixture();
    expect(renderPathSession(engine)).toEqual({});
  });

  it("stores a normalized request, reports unchanged, and resets to the project path", () => {
    const { engine } = fixture();
    expect(requestRenderPath(engine, { renderPath: "clusteredForward" })).toBe(
      true,
    );
    expect(renderPathSession(engine)).toEqual({
      renderPath: "clusteredForward",
    });
    expect(requestRenderPath(engine, { renderPath: "clusteredForward" })).toBe(
      false,
    );
    // Invalid values normalize to the empty request instead of sticking.
    expect(requestRenderPath(engine, { renderPath: "deferred" as never })).toBe(
      true,
    );
    expect(renderPathSession(engine)).toEqual({});
    expect(requestRenderPath(engine, {})).toBe(false);
  });

  it("applies the request to every live Scene on the Engine and skips disposed ones", () => {
    const { engine, scene } = fixture();
    const sibling = new Scene(engine);
    const disposed = new Scene(engine);
    disposed.dispose();
    const listener = vi.fn();
    const unsubscribe = subscribeRenderPathSession(engine, listener);
    expect(requestRenderPath(engine, { renderPath: "forward" })).toBe(true);
    expect(scene.isDisposed).toBe(false);
    expect(sibling.isDisposed).toBe(false);
    expect(listener).toHaveBeenCalledWith({ renderPath: "forward" });
    unsubscribe();
    requestRenderPath(engine, {});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is scoped per Engine and clears when the Engine disposes", () => {
    const first = fixture();
    const second = fixture();
    requestRenderPath(first.engine, { renderPath: "forward" });
    expect(renderPathSession(second.engine)).toEqual({});
    first.engine.dispose();
    expect(renderPathSession(first.engine)).toEqual({});
  });
});
