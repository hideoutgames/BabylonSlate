import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import HomepageSculpture from "./homepage-sculpture";

const MODEL = readFileSync(
  path.join(process.cwd(), "apps/editor/public/launcher/slate-object.glb"),
);

/**
 * The browser WebGL context is the only replaced boundary: the launcher gets a
 * real Babylon NullEngine, so scene setup, glTF parsing and disposal all run.
 */
const gpu = vi.hoisted(() => ({
  available: true,
  engines: [] as AbstractEngine[],
}));

vi.mock("@babylonjs/core/Engines/engine", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@babylonjs/core/Engines/engine")>();
  const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine");
  class Engine extends NullEngine {
    constructor() {
      if (!gpu.available) throw new Error("WebGL not supported");
      super();
      gpu.engines.push(this);
    }
    /* NullEngine 9.20 drops the cube texture it creates; WebGL attaches it to the target. */
    override createRenderTargetCubeTexture(
      ...args: Parameters<InstanceType<typeof NullEngine>["createRenderTargetCubeTexture"]>
    ) {
      const target = super.createRenderTargetCubeTexture(...args);
      if (!target.texture) target.setTexture(this._internalTexturesCache.at(-1)!);
      return target;
    }
    /* Mip generation is a GPU command; the WebGL extension needs a real context. */
    override generateMipMapsForCubemap() {}
  }
  return { ...actual, Engine };
});

function serveModel(respond: (url: string) => Promise<Response>) {
  const fetch = vi.fn(respond);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const modelResponse = async (url: string) =>
  url === "/launcher/slate-object.glb"
    ? new Response(MODEL)
    : new Response(null, { status: 404 });

beforeEach(() => {
  gpu.available = true;
  gpu.engines = [];
  /* Reduced motion renders single frames, so no animation loop outlives a test. */
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: true,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HomepageSculpture", () => {
  it("shows the Slate model, then releases the engine and canvas on unmount", async () => {
    serveModel(modelResponse);
    const onReady = vi.fn();
    const { container, unmount } = render(<HomepageSculpture onReady={onReady} />);
    const host = container.querySelector(".homepage-sculpture")!;

    /* Shader readiness is polled, so allow a few polls beyond the default. */
    await waitFor(() => expect(host.getAttribute("data-ready")).toBe("true"), {
      timeout: 4000,
    });
    expect(onReady).toHaveBeenCalledTimes(1);
    const canvas = host.querySelector("canvas");
    expect(canvas).not.toBeNull();
    const [engine] = gpu.engines;
    expect(
      engine!.scenes[0]!.meshes.map((mesh) => mesh.name).filter((name) =>
        name.startsWith("Slate slab"),
      ),
    ).toEqual(["Slate slab 0", "Slate slab 1", "Slate slab 2"]);

    unmount();
    expect(engine!.isDisposed).toBe(true);
    expect(engine!.scenes).toHaveLength(0);
    expect(canvas!.isConnected).toBe(false);
  });

  it("releases the loading cover without revealing the canvas when the model is unavailable", async () => {
    serveModel(async () => new Response(null, { status: 404 }));
    const onReady = vi.fn();
    const { container } = render(<HomepageSculpture onReady={onReady} />);

    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(
      container.querySelector(".homepage-sculpture")!.getAttribute("data-ready"),
    ).toBe("false");
  });

  it("releases the loading cover and mounts no canvas when WebGL is unavailable", async () => {
    gpu.available = false;
    const fetch = serveModel(modelResponse);
    const onReady = vi.fn();
    const { container } = render(<HomepageSculpture onReady={onReady} />);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(container.querySelector("canvas")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a model that arrives after unmount", async () => {
    let deliver!: () => void;
    serveModel(
      (url) =>
        new Promise((resolve) => {
          deliver = () => void modelResponse(url).then(resolve);
        }),
    );
    const onReady = vi.fn();
    const { unmount } = render(<HomepageSculpture onReady={onReady} />);
    const [engine] = gpu.engines;

    unmount();
    await act(async () => {
      deliver();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(engine!.isDisposed).toBe(true);
  });
});
