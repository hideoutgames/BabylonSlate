import { afterEach, describe, expect, it, vi } from "vitest";

const { createAppEngineMock, releaseResourceCacheForEngineMock } = vi.hoisted(
  () => {
    const createAppEngineMock = vi.fn((canvas: HTMLCanvasElement) => {
      return {
        canvas,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
    });
    const releaseResourceCacheForEngineMock = vi.fn();
    return { createAppEngineMock, releaseResourceCacheForEngineMock };
  },
);

vi.mock("@babylonslate/render", () => ({
  createAppEngine: createAppEngineMock,
  releaseResourceCacheForEngine: releaseResourceCacheForEngineMock,
}));

import {
  createProjectEngineController,
  createProjectEngineSession,
} from "./project-engine";

describe("createProjectEngineSession", () => {
  afterEach(() => {
    createAppEngineMock.mockClear();
    releaseResourceCacheForEngineMock.mockClear();
    document.body.replaceChildren();
  });

  it("creates an Engine on a detached hidden canvas", () => {
    const session = createProjectEngineSession();
    expect(session).not.toBeNull();
    expect(createAppEngineMock).toHaveBeenCalledTimes(1);
    const canvas = createAppEngineMock.mock.calls[0][0];
    expect(canvas.isConnected).toBe(false);
    expect(canvas.style.display).toBe("none");
    session?.dispose();
  });

  it("releases the resource cache, disposes the Engine, and removes the canvas", () => {
    const session = createProjectEngineSession();
    const engine = session!.engine;
    const canvas = createAppEngineMock.mock.calls[0][0];
    session!.dispose();
    expect(releaseResourceCacheForEngineMock).toHaveBeenCalledWith(engine);
    expect(engine.isDisposed).toBe(true);
    expect(canvas.isConnected).toBe(false);
  });
});

describe("createProjectEngineController", () => {
  afterEach(() => {
    createAppEngineMock.mockClear();
    releaseResourceCacheForEngineMock.mockClear();
    document.body.replaceChildren();
  });

  it("creates once while a project is open and disposes when it closes", () => {
    const host = createProjectEngineController();
    const first = host.sync(true);
    const second = host.sync(true);
    expect(first).toBe(second);
    expect(createAppEngineMock).toHaveBeenCalledTimes(1);
    expect(host.sync(false)).toBeNull();
    expect(first?.isDisposed).toBe(true);
    expect(releaseResourceCacheForEngineMock).toHaveBeenCalledTimes(1);
    const third = host.sync(true);
    expect(third).not.toBe(first);
    expect(createAppEngineMock).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("does not create an Engine when no project is open", () => {
    const host = createProjectEngineController();
    expect(host.sync(false)).toBeNull();
    expect(createAppEngineMock).not.toHaveBeenCalled();
  });
});
