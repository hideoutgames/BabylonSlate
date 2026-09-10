import { PBRMaterial, RenderTargetTexture, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEngine } from "./create-null-engine";
import {
  encodeParentedAnimatedTriangleGlb,
  encodeTriangleGlb,
} from "./model-mesh";
import { captureModelThumbnailPng } from "./model-thumbnail";
import { PNG_SIGNATURE } from "./png-encode";

describe("captureModelThumbnailPng", () => {
  const handles: Array<{
    engine: { dispose: () => void };
    scene: { dispose: () => void };
  }> = [];

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

  it("waits for imported materials before reading the one-shot render", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    let materialReady = false;
    const isReady = PBRMaterial.prototype.isReadyForSubMesh;
    const readiness = vi
      .spyOn(PBRMaterial.prototype, "isReadyForSubMesh")
      .mockImplementation(function (this: PBRMaterial, ...args) {
        return materialReady && isReady.apply(this, args);
      });
    const readback = vi
      .spyOn(RenderTargetTexture.prototype, "readPixels")
      .mockResolvedValue(new Uint8Array(128 * 128 * 4));
    const capture = captureModelThumbnailPng(
      handle.engine,
      encodeTriangleGlb(),
      [],
      () => null,
    );
    await vi.waitFor(() => expect(readiness).toHaveBeenCalled());
    expect(readback).not.toHaveBeenCalled();
    materialReady = true;
    expect(await capture).not.toBeNull();
    expect(readback).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "captures the selected clip's first pose, including retargeted clips: %s",
    async (retargeted) => {
      const handle = createTestEngine();
      handles.push(handle);
      const posed = encodeParentedAnimatedTriangleGlb("Idle");
      const view = new DataView(
        posed.buffer,
        posed.byteOffset,
        posed.byteLength,
      );
      const binOffset = 28 + view.getUint32(12, true);
      // First key is visibly different from the rest pose and the later key.
      view.setFloat32(binOffset + 48, 2, true);
      view.setFloat32(binOffset + 60, 6, true);
      let capturedY: number | undefined;
      vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(
        function (this: RenderTargetTexture) {
          capturedY = (this.getScene()!.getMeshByName("part") as Mesh).position
            .y;
          return Promise.resolve(new Uint8Array(128 * 128 * 4));
        },
      );
      const png = await captureModelThumbnailPng(
        handle.engine,
        retargeted ? encodeParentedAnimatedTriangleGlb("Idle") : posed,
        [],
        () => null,
        undefined,
        { clipName: "Idle", ...(retargeted ? { sourceClipBytes: posed } : {}) },
      );
      expect(png).not.toBeNull();
      expect(capturedY).toBeCloseTo(2);
      expect(handle.engine.scenes).toEqual([handle.scene]);
    },
  );

  it("does not cache a rest pose when the requested animation is absent", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const readback = vi.spyOn(RenderTargetTexture.prototype, "readPixels");
    expect(
      await captureModelThumbnailPng(
        handle.engine,
        encodeParentedAnimatedTriangleGlb("Idle"),
        [],
        () => null,
        undefined,
        { clipName: "Missing" },
      ),
    ).toBeNull();
    expect(readback).not.toHaveBeenCalled();
    expect(handle.engine.scenes).toEqual([handle.scene]);
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
