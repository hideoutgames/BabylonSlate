import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, RawTexture, Scene, Constants } from "@babylonjs/core";
import {
  beginManagedLightingAllocation,
  limitManagedLightingBytes,
  managedLightingReservations,
  reserveManagedShadowBytes,
} from "./managed-lighting-resources";
import { managedTextureResource } from "./clustered-resource-cost";
const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function fixture(bytes: number) {
  const engine = new NullEngine();
  engines.push(engine);
  limitManagedLightingBytes(engine, bytes);
  return engine;
}

describe("managed lighting allocation transactions", () => {
  it("holds old and new generations before allocation, rolls back, and deduplicates borrowed handles", () => {
    const engine = fixture(100);
    const shadowOwner = {};
    reserveManagedShadowBytes(engine, shadowOwner, 20);
    const first = beginManagedLightingAllocation(engine, 30)!;
    const texture = {};
    first.commit([
      { handle: texture, bytes: 30 },
      { handle: texture, bytes: 30 },
    ]);
    const next = beginManagedLightingAllocation(engine, 50)!;
    expect(managedLightingReservations(engine).reservedBytes).toBe(100);
    expect(beginManagedLightingAllocation(engine, 1)).toBeUndefined();
    next.release();
    expect(managedLightingReservations(engine).reservedBytes).toBe(50);
    const borrower = beginManagedLightingAllocation(engine, 30)!;
    borrower.commit([{ handle: texture, bytes: 30 }]);
    expect(managedLightingReservations(engine).clusterBytes).toBe(30);
    first.release();
    first.release();
    expect(managedLightingReservations(engine).reservedBytes).toBe(50);
    borrower.release();
    expect(managedLightingReservations(engine).reservedBytes).toBe(20);
    reserveManagedShadowBytes(engine, shadowOwner, 0);
    expect(managedLightingReservations(engine).reservedBytes).toBe(0);
  });
  it("keeps an underestimated candidate reserved until caller confirms cleanup", () => {
    const engine = fixture(50);
    const candidate = beginManagedLightingAllocation(engine, 40)!;
    expect(() => candidate.commit([{ handle: {}, bytes: 41 }])).toThrow(
      /reserved peak/,
    );
    expect(beginManagedLightingAllocation(engine, 11)).toBeUndefined();
    expect(managedLightingReservations(engine).pendingBytes).toBe(40);
    candidate.release();
    expect(managedLightingReservations(engine).reservedBytes).toBe(0);
  });
  it("derives float formats, rectangular mip chains and multisample resolve storage from actual textures", () => {
    const engine = fixture(10000);
    const scene = new Scene(engine);
    const texture = new RawTexture(
      new Float32Array(32),
      4,
      2,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      true,
      false,
      1,
      Constants.TEXTURETYPE_FLOAT,
    );
    const internal = texture.getInternalTexture()!;
    // 4x2 +2x1 +1x1 =11 RGBA32F texels, plus a 4-sample 4x2 attachment.
    internal.samples = 4;
    expect(managedTextureResource(texture)).toEqual({
      handle: internal,
      bytes: 688,
    });
    internal.format = Constants.TEXTUREFORMAT_R;
    internal.generateMipMaps = false;
    internal.samples = 1;
    expect(managedTextureResource(texture).bytes).toBe(32);
  });
});
