import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera, NullEngine, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@haptic/core";
import { waterVariantBase } from "./material-compiler";
import { createWaterMesh, isBuiltInWaterMesh } from "./water-mesh";
import { meshWaterNodeSurface } from "./water-node-blocks";
import { builtInWaterMaterial } from "./water-template";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); });

function host() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 6, -12), scene);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return { scene };
}

describe("Built-in water's graph Material", () => {
  it("is one water starter Material per Scene, shared by every body as built-in water", async () => {
    const { scene } = host();
    const material = builtInWaterMaterial(scene);
    expect(builtInWaterMaterial(scene)).toBe(material);
    const body = normalizeWaterBody({ resolution: 8 });
    const lake = createWaterMesh(scene, "lake", body, createDefaultWaterDefinition(), material);
    const river = createWaterMesh(scene, "river", normalizeWaterBody({ resolution: 8 }, "river"), { ...createDefaultWaterDefinition(), roughness: 0.3 }, material);
    // Every body draws the starter's one water variant (the cut and coverage), never the starter itself.
    const drawn = lake.material!;
    expect(drawn).not.toBe(material);
    expect(river.material).toBe(drawn);
    expect(waterVariantBase(drawn)).toBe(material);
    // Each body reads its own asset through its own surface.
    expect(meshWaterNodeSurface(lake)!.water.roughness).not.toBe(meshWaterNodeSurface(river)!.water.roughness);
    // It is built-in water, which the view's graph warms under the pass that draws it; a Custom Material is not.
    const custom = createWaterMesh(scene, "custom", body, createDefaultWaterDefinition(), new StandardMaterial("custom", scene));
    expect([isBuiltInWaterMesh(lake), isBuiltInWaterMesh(river), isBuiltInWaterMesh(custom)]).toEqual([true, true, false]);
    // A body's disposal leaves the shared Material and its water variant to the others; the Scene's disposes them.
    lake.dispose();
    expect(river.material).toBe(drawn);
    expect(scene.materials).toContain(drawn);
    expect(material.getScene().materials).toContain(material);
    const dispose = vi.spyOn(material, "dispose");
    scene.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});
