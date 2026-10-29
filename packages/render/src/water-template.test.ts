import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera, InternalTexture, InternalTextureSource, NullEngine, PBRMaterial, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@haptic/core";
import { setHapticLighting } from "./haptic-lights";
import { createWaterMesh, isBuiltInWaterMesh } from "./water-mesh";
import { meshWaterNodeSurface } from "./water-node-blocks";
import { builtInWaterMaterial } from "./water-template";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); });

/** A NullEngine Scene that reports uniform buffers, as WebGL2 does, and makes the texture arrays it cannot. */
function host() {
  const engine = new NullEngine();
  vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  vi.spyOn(engine, "createRawTexture2DArray").mockImplementation(() => new InternalTexture(engine, InternalTextureSource.Raw2DArray));
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 6, -12), scene);
  disposers.push(() => { setHapticLighting(engine, false); scene.dispose(); engine.dispose(); });
  return { engine, scene };
}

describe("Built-in water's graph Material", () => {
  it("is null while graph Materials draw with Babylon's lighting, so built-in water keeps its plugin", () => {
    const { scene } = host();
    expect(builtInWaterMaterial(scene)).toBeNull();
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), builtInWaterMaterial(scene));
    expect(lake.material).toBeInstanceOf(PBRMaterial);
    expect(isBuiltInWaterMesh(lake)).toBe(true);
  });

  it("is one water starter Material per Scene under the lighting block, shared by every body as built-in water", async () => {
    const { engine, scene } = host();
    setHapticLighting(engine, true);
    const material = builtInWaterMaterial(scene)!;
    expect(material).not.toBeNull();
    expect(builtInWaterMaterial(scene)).toBe(material);
    const body = normalizeWaterBody({ resolution: 8 });
    const lake = createWaterMesh(scene, "lake", body, createDefaultWaterDefinition(), material);
    const river = createWaterMesh(scene, "river", normalizeWaterBody({ resolution: 8 }, "river"), { ...createDefaultWaterDefinition(), roughness: 0.3 }, material);
    // Each body reads its own asset through its own surface.
    expect(meshWaterNodeSurface(lake)!.water.roughness).not.toBe(meshWaterNodeSurface(river)!.water.roughness);
    // It is built-in water, which the view's graph warms under the pass that draws it; a Custom Material is not.
    const custom = createWaterMesh(scene, "custom", body, createDefaultWaterDefinition(), new StandardMaterial("custom", scene));
    expect([isBuiltInWaterMesh(lake), isBuiltInWaterMesh(river), isBuiltInWaterMesh(custom)]).toEqual([true, true, false]);
    // A body's disposal leaves the shared Material to the others; the Scene's disposes it.
    lake.dispose();
    expect(river.material).toBe(material);
    expect(material.getScene().materials).toContain(material);
    const dispose = vi.spyOn(material, "dispose");
    scene.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});
