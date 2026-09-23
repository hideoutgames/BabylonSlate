import { describe, expect, it, vi } from "vitest";
import type { NodeMaterial } from "@babylonjs/core";
import { rebindEmptiedDrawContexts } from "./webgpu-node-material-rebind";

function fakeMaterial(isFrozen: boolean) {
  const original = vi.fn();
  const material = {
    isFrozen,
    maxSimultaneousLights: 4,
    bindForSubMesh: original,
  };
  rebindEmptiedDrawContexts(material as unknown as NodeMaterial);
  return { material, original };
}

function subMesh(buffers: Record<string, unknown> | undefined) {
  return {
    _drawWrapper: {
      effect: { _uniformBuffersNames: { Light0: 0, Light1: 1 } },
      drawContext: buffers === undefined ? undefined : { buffers },
      _forceRebindOnNextCall: false,
    },
  };
}

const world = {};
const mesh = { lightSources: [] };

describe("rebindEmptiedDrawContexts", () => {
  it("forces a rebind when a frozen draw context misses a declared buffer", () => {
    const { material, original } = fakeMaterial(true);
    const sm = subMesh({ Light0: {} });
    material.bindForSubMesh(world, mesh, sm);
    expect(sm._drawWrapper._forceRebindOnNextCall).toBe(true);
    expect(original).toHaveBeenCalledWith(world, mesh, sm);
  });

  it("leaves the flag alone when every declared buffer is bound", () => {
    const { material } = fakeMaterial(true);
    const sm = subMesh({ Light0: {}, Light1: {} });
    material.bindForSubMesh(world, mesh, sm);
    expect(sm._drawWrapper._forceRebindOnNextCall).toBe(false);
  });

  it("refreshes a retained frozen binding after a light rotates its backing buffer", () => {
    const { material, original } = fakeMaterial(true);
    const previous = {}, current = {};
    const sm = subMesh({ Light0: previous, Light1: {} });
    const receiver = { lightSources: [{ _uniformBuffer: { getBuffer: () => current } }] };
    material.bindForSubMesh(world, receiver, sm);
    expect(sm._drawWrapper._forceRebindOnNextCall).toBe(true);
    expect(original).toHaveBeenCalledWith(world, receiver, sm);
    sm._drawWrapper._forceRebindOnNextCall = false;
    sm._drawWrapper.drawContext!.buffers.Light0 = current;
    material.bindForSubMesh(world, receiver, sm);
    expect(sm._drawWrapper._forceRebindOnNextCall).toBe(false);
  });

  it("does not force a rebind for unfrozen materials", () => {
    const { material } = fakeMaterial(false);
    const sm = subMesh({ Light0: {} });
    material.bindForSubMesh(world, mesh, sm);
    expect(sm._drawWrapper._forceRebindOnNextCall).toBe(false);
  });

  it("ignores submeshes without a draw context (WebGL shape)", () => {
    const { material, original } = fakeMaterial(true);
    const sm = subMesh(undefined);
    material.bindForSubMesh(world, mesh, sm);
    expect(sm._drawWrapper._forceRebindOnNextCall).toBe(false);
    expect(original).toHaveBeenCalledWith(world, mesh, sm);
  });
});
