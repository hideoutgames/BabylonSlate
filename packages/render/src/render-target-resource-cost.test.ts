import { afterEach, describe, expect, it } from "vitest";
import {
  Constants,
  NullEngine,
} from "@babylonjs/core";
import {
  managedRenderTextureResource,
  renderTargetAllocationBytes,
} from "./render-target-resource-cost";
import {
  beginManagedRenderAllocation,
  limitManagedRenderBytes,
  managedRenderReservations,
  reserveManagedShadowBytes,
} from "./managed-render-resources";
import { managedLightingReservations } from "./managed-lighting-resources";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function engineWithLimit(limit: number) {
  const engine = new NullEngine();
  engines.push(engine);
  limitManagedRenderBytes(engine, limit);
  return engine;
}
function targetFor(
  engine: NullEngine,
  size: { width: number; height: number },
) {
  const target = engine.createRenderTargetTexture(size, {
    generateDepthBuffer: false,
  });
  // NullEngine omits the allocated format; the WebGL/WebGPU allocators set RGBA.
  target.texture!.format = Constants.TEXTUREFORMAT_RGBA;
  return target;
}
const rgba = { width: 4, height: 2, format: Constants.TEXTUREFORMAT_RGBA };

describe("managed render-target storage", () => {
  it.each([
    [
      {
        ...rgba,
        type: Constants.TEXTURETYPE_FLOAT,
        mipLevels: "full" as const,
        layers: 3,
      },
      528,
    ],
    [
      {
        ...rgba,
        type: Constants.TEXTURETYPE_FLOAT,
        samples: 4,
        mipLevels: "full" as const,
      },
      688,
    ],
    [
      {
        width: 4,
        height: 4,
        depth: 4,
        format: Constants.TEXTUREFORMAT_R,
        type: Constants.TEXTURETYPE_HALF_FLOAT,
        mipLevels: "full" as const,
      },
      146,
    ],
    [
      {
        width: 4,
        height: 4,
        cube: true,
        layers: 2,
        format: Constants.TEXTUREFORMAT_RGBA,
        mipLevels: "full" as const,
      },
      1008,
    ],
    [{ ...rgba, format: Constants.TEXTUREFORMAT_DEPTH16 }, 16],
    [{ ...rgba, format: Constants.TEXTUREFORMAT_DEPTH24 }, 32],
    [
      { ...rgba, format: Constants.TEXTUREFORMAT_DEPTH32_FLOAT, samples: 4 },
      160,
    ],
    [
      { ...rgba, format: Constants.TEXTUREFORMAT_DEPTH24_STENCIL8, samples: 4 },
      320,
    ],
  ])(
    "accounts representation storage including mip/layer/sample capacity %#",
    (layout, bytes) => {
      expect(renderTargetAllocationBytes(layout)).toBe(bytes);
    },
  );

  it("rejects unknown formats and malformed allocation recipes before admission", () => {
    for (const layout of [
      { ...rgba, width: 0 },
      { ...rgba, samples: 1.5 },
      { ...rgba, layers: Number.MAX_SAFE_INTEGER },
      { ...rgba, format: Constants.TEXTUREFORMAT_COMPRESSED_RGBA_S3TC_DXT5 },
      { ...rgba, depth: 2, layers: 2 },
      { ...rgba, mipLevels: 9 },
    ])
      expect(() => renderTargetAllocationBytes(layout)).toThrow();
  });

  it("holds replacement peaks against shadow/cluster siblings and releases only disposed generations", () => {
    const engine = engineWithLimit(128);
    const shadow = {};
    reserveManagedShadowBytes(engine, shadow, 24);
    const cluster = beginManagedRenderAllocation(engine, 8)!;
    cluster.commit([{ handle: {}, bytes: 8, category: "cluster" }]);
    const initial = beginManagedRenderAllocation(
      engine,
      renderTargetAllocationBytes(rgba),
    )!;
    const first = targetFor(engine, { width: 4, height: 2 });
    initial.commit([managedRenderTextureResource(first.texture!, "sceneColor")]);
    const replacementSize = renderTargetAllocationBytes({ ...rgba, width: 8 });
    const replacement = beginManagedRenderAllocation(engine, replacementSize)!;
    expect(managedRenderReservations(engine).reservedBytes).toBe(128);
    expect(beginManagedRenderAllocation(engine, 1)).toBeUndefined();
    const next = targetFor(engine, { width: 8, height: 2 });
    replacement.commit([
      managedRenderTextureResource(next.texture!, "postprocess"),
    ]);
    expect(managedLightingReservations(engine).clusterBytes).toBe(8);
    expect(managedRenderReservations(engine).categoryBytes).toMatchObject({
      sceneColor: 32,
      postprocess: 64,
    });
    first.dispose();
    initial.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(96);
    next.dispose();
    replacement.release();
    cluster.release();
    reserveManagedShadowBytes(engine, shadow, 0);
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });

  it("deduplicates an actual imported texture across categories and keeps it charged through owner release", () => {
    const engine = engineWithLimit(96);
    const target = targetFor(engine, { width: 4, height: 2 });
    const owner = beginManagedRenderAllocation(engine, 64)!;
    owner.commit([
      managedRenderTextureResource(target.texture!, "sceneColor"),
      managedRenderTextureResource(target.texture!, "postprocess"),
    ]);
    const borrowed = beginManagedRenderAllocation(engine, 32)!;
    borrowed.commit([managedRenderTextureResource(target.texture!, "geometry")]);
    expect(managedRenderReservations(engine)).toMatchObject({
      resourceBytes: 32,
      sharedBytes: 32,
      pendingBytes: 0,
    });
    owner.release();
    expect(managedRenderReservations(engine)).toMatchObject({
      resourceBytes: 32,
      sharedBytes: 0,
      categoryBytes: { geometry: 32 },
    });
    target.dispose();
    borrowed.release();
    borrowed.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });

  it("reconciles shared graph texture handles before any render-target wrapper is created", () => {
    const engine = engineWithLimit(128);
    const texture = engine.createRawTexture(
      new Uint8Array(32),
      4,
      2,
      Constants.TEXTUREFORMAT_RGBA,
      false,
      false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    );
    const depth = engine.createRawTexture(
      new Float32Array(8),
      4,
      2,
      Constants.TEXTUREFORMAT_R,
      false,
      false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      null,
      Constants.TEXTURETYPE_FLOAT,
    );
    depth.format = Constants.TEXTUREFORMAT_DEPTH32_FLOAT;
    expect(() => managedRenderTextureResource(texture, "sceneColor")).toThrow(
      /no ready/,
    );
    // NullEngine's raw allocator omits the readiness bit set by native upload.
    texture.isReady = true;
    depth.isReady = true;
    const first = beginManagedRenderAllocation(engine, 64)!;
    first.commit([
      managedRenderTextureResource(texture, "sceneColor", { samples: 1 }),
      managedRenderTextureResource(depth, "depth", { samples: 1 }),
    ]);
    const alias = beginManagedRenderAllocation(engine, 32)!;
    alias.commit([
      managedRenderTextureResource(texture, "postprocess", { samples: 1 }),
    ]);
    expect(managedRenderReservations(engine)).toMatchObject({
      resourceBytes: 64,
      sharedBytes: 32,
      categoryBytes: { depth: 32 },
    });
    texture.dispose();
    depth.dispose();
    first.release();
    alias.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });

  it("retains an underestimated live candidate until rollback cleanup, without publishing category bytes", () => {
    const engine = engineWithLimit(96);
    const lease = beginManagedRenderAllocation(engine, 32)!;
    const target = targetFor(engine, { width: 8, height: 2 });
    expect(() =>
      lease.commit([managedRenderTextureResource(target.texture!, "sceneColor")]),
    ).toThrow(/reserved peak/);
    expect(managedRenderReservations(engine)).toMatchObject({
      resourceBytes: 0,
      pendingBytes: 32,
    });
    expect(beginManagedRenderAllocation(engine, 65)).toBeUndefined();
    target.dispose();
    lease.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });

  it("reserves MSAA capacity and observes natively allocated mips", () => {
    const engine = engineWithLimit(1000);
    const target = targetFor(engine, { width: 4, height: 2 });
    Object.defineProperty(
      target.texture!._hardwareTexture!,
      "underlyingResource",
      { value: { mipLevelCount: 3 } },
    );
    expect(
      managedRenderTextureResource(target.texture!, "sceneColor", {
        samples: 4,
      }),
    ).toEqual({ handle: target.texture, bytes: 172, category: "sceneColor" });
    target.dispose();
  });

  it("charges explicitly allocated mips even with generation disabled and keeps restoration siblings reserved", () => {
    const engine = engineWithLimit(100);
    const target = targetFor(engine, { width: 4, height: 2 });
    const lease = beginManagedRenderAllocation(engine, 44)!;
    lease.commit([
      managedRenderTextureResource(target.texture!, "postprocess", {
        allocatedMipLevels: "full",
      }),
    ]);
    engine.onContextRestoredObservable.notifyObservers(engine);
    expect(managedRenderReservations(engine).reservedBytes).toBe(44);
    expect(beginManagedRenderAllocation(engine, 57)).toBeUndefined();
    target.dispose();
    lease.release();
  });
});
