import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, RawTexture, Scene, Constants } from "@babylonjs/core";
import {
  limitManagedLightingBytes,
  reserveManagedShadowBytes,
} from "./managed-lighting-resources";
import { beginManagedRenderAllocation, managedRenderReservations } from "./managed-render-resources";
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
    const first = beginManagedRenderAllocation(engine, 30)!;
    const texture = {};
    first.commit([
      { handle: texture, bytes: 30, category: "sceneColor" },
      { handle: texture, bytes: 30, category: "sceneColor" },
    ]);
    const next = beginManagedRenderAllocation(engine, 50)!;
    expect(managedRenderReservations(engine).reservedBytes).toBe(100);
    expect(beginManagedRenderAllocation(engine, 1)).toBeUndefined();
    next.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(50);
    const borrower = beginManagedRenderAllocation(engine, 30)!;
    borrower.commit([{ handle: texture, bytes: 30, category: "sceneColor" }]);
    expect(managedRenderReservations(engine).categoryBytes.sceneColor).toBe(30);
    first.release();
    first.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(50);
    borrower.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(20);
    reserveManagedShadowBytes(engine, shadowOwner, 0);
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });
  it("keeps an underestimated candidate reserved until caller confirms cleanup", () => {
    const engine = fixture(50);
    const candidate = beginManagedRenderAllocation(engine, 40)!;
    expect(() =>
      candidate.commit([{ handle: {}, bytes: 41, category: "sceneColor" }]),
    ).toThrow(/reserved peak/);
    expect(beginManagedRenderAllocation(engine, 11)).toBeUndefined();
    expect(managedRenderReservations(engine).pendingBytes).toBe(40);
    candidate.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });
});
