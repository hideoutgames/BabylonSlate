import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Engine, MeshBuilder, NullEngine, RawTexture, Scene, Texture, VertexBuffer, type Mesh,
  type NodeMaterial,
} from "@babylonjs/core";
import { acquireAuthoredMaterialVariant } from "./material-compiler";
import { ensureLatticeShadowAdapter, releaseLatticeShadowAdapter } from "./lattice-deformer-binding";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { hasStockVertexStage } from "./shadow-material-policy";
import { isUnlitMaterial, setUnlitMaterial, unlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";

const handles: Array<{ dispose: () => void }> = [];
afterEach(() => { while (handles.length) handles.pop()!.dispose(); });

function scene(): Scene {
  const engine = new NullEngine();
  const value = new Scene(engine);
  handles.push(engine, value);
  // Disposed scene first, then its engine.
  handles.reverse();
  return value;
}

const world: UnlitMaterialKey = { textured: true, backFaceCulling: false, fog: true, role: "world" };
const solid: UnlitMaterialKey = { textured: false, backFaceCulling: true, fog: true, role: "world" };

function texture(target: Scene): Texture {
  const value = RawTexture.CreateRGBATexture(new Uint8Array([255, 0, 0, 255]), 1, 1, target, false, false, Texture.NEAREST_SAMPLINGMODE);
  // NullEngine never uploads, so its textures never report ready.
  value.isReady = () => true;
  return value;
}

function binding(overrides: Partial<UnlitBinding> = {}): UnlitBinding {
  return { texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: true, twoSided: false, ...overrides };
}

/** The build finishes once its blocks' shader code has loaded. */
async function built(material: NodeMaterial): Promise<void> {
  await vi.waitFor(() => expect((material as unknown as { _buildWasSuccessful: boolean })._buildWasSuccessful).toBe(true));
}

async function ready(material: NodeMaterial, mesh: Mesh): Promise<void> {
  await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true));
}

function effectCount(engine: Engine | NullEngine): number {
  return Object.keys((engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects).length;
}

describe("unlit Material", () => {
  it("shares one instance per key and one program per texturing across keys", async () => {
    const target = scene();
    const a = unlitMaterial(target, world);
    expect(unlitMaterial(target, { ...world })).toBe(a);
    const helper = unlitMaterial(target, { ...world, role: "helper", fog: false });
    expect(helper).not.toBe(a);
    expect(helper.fogEnabled).toBe(false);
    expect(a.backFaceCulling).toBe(false);
    const other = unlitMaterial(target, solid);
    for (const material of [a, helper, other]) await built(material);
    // Render state differs, the code does not: the same program.
    expect(helper.buildId).toBe(a.buildId);
    expect(other.buildId).not.toBe(a.buildId);
    expect(isUnlitMaterial(a)).toBe(true);
  });

  it("draws meshes of different vertex layouts and bindings with one Effect, and binding changes compile nothing", async () => {
    const target = scene();
    const plane = MeshBuilder.CreatePlane("plane", {}, target);
    const box = MeshBuilder.CreateBox("box", {}, target);
    // Extra attributes the surface never reads: they must not split the program.
    box.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(box.getTotalVertices() * 2));
    const red = texture(target), blue = texture(target);
    const material = setUnlitMaterial(plane, world, binding({ texture: red }));
    expect(setUnlitMaterial(box, world, binding({ texture: blue, color: [0.5, 0.5, 0.5], alpha: 0.5 }))).toBe(material);
    await ready(material, plane);
    await ready(material, box);
    expect(box.subMeshes[0]!.effect).toBe(plane.subMeshes[0]!.effect);
    const effects = effectCount(target.getEngine());
    setUnlitMaterial(plane, world, binding({ texture: blue, cutoff: 0.4 }));
    plane.visibility = 0.5;
    await ready(material, plane);
    expect(effectCount(target.getEngine())).toBe(effects);
    // No light block: no light defines, and the surface reads no normal.
    expect(plane.subMeshes[0]!.effect!.defines).not.toMatch(/#define LIGHT\d|#define NORMAL\b|#define UV2\b/);
    expect(plane.subMeshes[0]!.effect!.defines).toMatch(/#define UV1\b/);
  });

  it("waits for the mesh's bound texture before drawing", async () => {
    const target = scene();
    const plane = MeshBuilder.CreatePlane("plane", {}, target);
    const loading = texture(target);
    let loaded = false;
    loading.isReady = () => loaded;
    const material = setUnlitMaterial(plane, world, binding({ texture: loading }));
    await built(material);
    expect(material.isReadyForSubMesh(plane, plane.subMeshes[0]!)).toBe(false);
    loaded = true;
    await ready(material, plane);
  });

  it("blends and alpha-tests per mesh, as Standard's alpha rules do", () => {
    const target = scene();
    const meshes = Array.from({ length: 6 }, (_, index) => MeshBuilder.CreatePlane(`m${index}`, {}, target));
    const material = unlitMaterial(target, world);
    setUnlitMaterial(meshes[0]!, world, binding());
    setUnlitMaterial(meshes[1]!, world, binding({ blend: true }));
    setUnlitMaterial(meshes[2]!, world, binding({ alpha: 0.5 }));
    setUnlitMaterial(meshes[3]!, world, binding({ cutoff: 0.4 }));
    setUnlitMaterial(meshes[4]!, world, binding({ cutoff: 0.4 }));
    meshes[4]!.visibility = 0.5;
    setUnlitMaterial(meshes[5]!, world, binding());
    applyOverlayVisualStyle(meshes[5]!, { opacity: 0.5 });
    expect(meshes.map((mesh) => material.needAlphaBlendingForMesh(mesh))).toEqual([false, true, true, false, true, true]);
    expect(meshes.map((mesh) => material.needAlphaTestingForMesh(mesh))).toEqual([false, false, false, true, true, false]);
  });

  it("reports the textures its meshes sample", () => {
    const target = scene();
    const plane = MeshBuilder.CreatePlane("plane", {}, target);
    const other = MeshBuilder.CreatePlane("other", {}, target);
    const red = texture(target), blue = texture(target);
    const material = setUnlitMaterial(plane, world, binding({ texture: red }));
    setUnlitMaterial(other, world, binding({ texture: blue }));
    expect(material.getActiveTextures()).toEqual(expect.arrayContaining([red, blue]));
    expect(material.hasTexture(blue)).toBe(true);
    other.dispose();
    expect(material.getActiveTextures()).not.toContain(blue);
    expect(material.hasTexture(blue)).toBe(false);
  });

  it("gives the outline, capture and shadow passes variants, deforms by lattice, and keeps the stock shadow path", async () => {
    const target = scene();
    const material = unlitMaterial(target, world);
    for (const kind of ["outlineMask", "captureDepth", "captureNormal", "shadowDepth"] as const) {
      const variant = acquireAuthoredMaterialVariant(material, kind);
      expect(variant?.compiled.material.getClassName(), kind).toBe("NodeMaterial");
      expect(variant!.compiled.buildState).toBe("ready");
      await variant!.release();
    }
    expect(ensureLatticeShadowAdapter(material)).toBe(true);
    expect(material.shadowDepthWrapper).not.toBeNull();
    releaseLatticeShadowAdapter(material);
    expect(material.shadowDepthWrapper).toBeNull();
    await built(material);
    expect(hasStockVertexStage(material)).toBe(true);
  });

  it("frees its instance and variants with the Scene", () => {
    const target = scene();
    const material = unlitMaterial(target, world);
    const variant = acquireAuthoredMaterialVariant(material, "outlineMask")!;
    target.dispose();
    expect(target.materials).toHaveLength(0);
    expect(variant.compiled.material.getScene().materials).not.toContain(variant.compiled.material);
  });
});
