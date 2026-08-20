import { RenderTargetTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { encodeTriangleGlb } from "./model-mesh";
import { captureModelThumbnailPng } from "./model-thumbnail";
import { PNG_SIGNATURE } from "./png-encode";

describe("captureModelThumbnailPng", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("encodes a transparent PNG of the loaded mesh", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const pixels = new Uint8Array(128 * 128 * 4);
    pixels[3] = 0;
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockResolvedValue(
      pixels,
    );
    const png = await captureModelThumbnailPng(
      handle.engine,
      encodeTriangleGlb(),
      [],
      () => null,
    );
    expect(png).not.toBeNull();
    expect([...png!.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  });

  it("captures construction materials when slot resolve returns null", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const pixels = new Uint8Array(128 * 128 * 4);
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockResolvedValue(
      pixels,
    );
    const png = await captureModelThumbnailPng(
      handle.engine,
      encodeTriangleGlb(),
      [{ index: 0, name: "Hero Mat", materialGuid: "mat-1" }],
      () => null,
    );
    expect(png).not.toBeNull();
    expect([...png!.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  });

  it("captures a Model.source view nested in a larger ArrayBuffer", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const glb = encodeTriangleGlb();
    const padded = new Uint8Array(glb.byteLength + 32);
    padded.fill(0xab);
    padded.set(glb, 16);
    const view = padded.subarray(16, 16 + glb.byteLength);
    const pixels = new Uint8Array(128 * 128 * 4);
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockResolvedValue(
      pixels,
    );
    const png = await captureModelThumbnailPng(
      handle.engine,
      view,
      [],
      () => null,
    );
    expect(png).not.toBeNull();
    expect([...png!.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  });

  it("returns null for OBJ stubs with no loadable mesh", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    await expect(
      captureModelThumbnailPng(
        handle.engine,
        new TextEncoder().encode("o cube\nv 0 0 0\n"),
        [],
        () => null,
      ),
    ).resolves.toBeNull();
  });
});
