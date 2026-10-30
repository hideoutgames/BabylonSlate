import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BakedVertexAnimationManager,
  Material,
  MaterialPluginBase,
  MeshBuilder,
  MorphTargetManager,
  NodeMaterial,
  NullEngine,
  PBRMaterial,
  ShadowDepthWrapper,
  Skeleton,
  StandardMaterial,
  Scene,
  Texture,
} from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  lowerMaterialDocument,
  newCustomGlslProperties,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@haptic/shader-graph";
import { compileMaterialPlan, ensureAuthoredShadowDepthWrapper } from "./material-compiler";
import { ensureLatticeShadowAdapter, releaseLatticeShadowAdapter, setLatticeBinding } from "./lattice-deformer-binding";
import { ensureNativeLatticeShadowDepthWrapper, releaseNativeLatticeShadowDepthWrapper } from "./native-lattice-shadow";
import { HelperProgramPlugin, shareHelperProgram } from "./helper-program";
import { canCacheShadowMaterial, hasStockVertexStage } from "./shadow-material-policy";
import { TextureQualityPlugin } from "./texture-quality";

const engines: NullEngine[] = [];
afterEach(() => {
  while (engines.length) engines.pop()!.dispose();
});
function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox("caster", {}, scene);
  return { scene, mesh };
}

function nativeMaterial<T extends PBRMaterial | StandardMaterial>(
  material: T,
): T {
  // The renderer registers this plugin on every native material, even after a test
  // disposed the last Engine. Without it the trusted-plugin cases below are vacuous.
  expect(material.pluginManager?.getPlugin("SlateTextureQuality")).toBeInstanceOf(
    TextureQualityPlugin,
  );
  return material;
}

async function compiledMaterial(
  scene: Scene,
  document: MaterialDocument,
  functions: Record<string, MaterialFunctionDocument> = {},
) {
  const lowered = lowerMaterialDocument(document, { functions });
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const result = compileMaterialPlan(lowered.plan, { scene, name: "compiled" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(await result.ready).toEqual([]);
  return result.material;
}

describe("shadow material cache policy", () => {
  it.each(["pbr", "standard"] as const)(
    "admits an opaque native %s caster but stops caching alpha coverage",
    (kind) => {
      const { scene, mesh } = fixture();
      const material = nativeMaterial(
        kind === "pbr"
          ? new PBRMaterial("opaque", scene)
          : new StandardMaterial("opaque", scene),
      );
      mesh.material = material;
      expect(canCacheShadowMaterial(material, mesh)).toBe(true);
      material.alpha = 0.5;
      expect(canCacheShadowMaterial(material, mesh)).toBe(false);
      material.alpha = 1;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      expect(canCacheShadowMaterial(material, mesh)).toBe(false);
    },
  );

  it("treats a helper that shares its program as a stock vertex stage, which GPU picking relies on", () => {
    const { scene } = fixture();
    const helper = shareHelperProgram(nativeMaterial(new StandardMaterial("helper", scene)));
    expect(helper.pluginManager?.getPlugin("SlateHelperProgram")).toBeInstanceOf(HelperProgramPlugin);
    expect(hasStockVertexStage(helper)).toBe(true);
  });

  it("rejects untrusted materials, plugins, bind hooks and shadow wrappers", () => {
    const { scene, mesh } = fixture();
    const node = new NodeMaterial("untrusted", scene);
    node.metadata = { boundsPadding: 0 };
    expect(canCacheShadowMaterial(node, mesh)).toBe(false);
    class CustomPBR extends PBRMaterial {}
    expect(canCacheShadowMaterial(new CustomPBR("custom", scene), mesh)).toBe(
      false,
    );
    const material = new PBRMaterial("native", scene);
    material.customShaderNameResolve = () => "custom";
    expect(canCacheShadowMaterial(material, mesh)).toBe(false);
    const hooked = new StandardMaterial("hooked", scene);
    hooked.onBindObservable.add(() => {});
    expect(canCacheShadowMaterial(hooked, mesh)).toBe(false);
    const plugged = new PBRMaterial("plugged", scene);
    new MaterialPluginBase(
      plugged,
      "unknown-vertex-plugin",
      200,
      {},
      true,
      true,
    );
    expect(canCacheShadowMaterial(plugged, mesh)).toBe(false);
    const wrapped = new PBRMaterial("wrapped", scene);
    wrapped.shadowDepthWrapper = new ShadowDepthWrapper(wrapped, scene);
    expect(canCacheShadowMaterial(wrapped, mesh)).toBe(false);
    const padded = new PBRMaterial("deforming-bounds", scene);
    padded.metadata = { boundsPadding: 2 };
    expect(canCacheShadowMaterial(padded, mesh)).toBe(false);
  });

  it.each(["skeleton", "morph", "baked", "render-hook"] as const)(
    "keeps %s deformation on live shadow refresh, for the mesh and its instances",
    (kind) => {
      const { scene, mesh } = fixture();
      const material = new PBRMaterial("native", scene);
      // An instance draws its source's geometry at its own pose: both cache until the source deforms.
      const instance = mesh.createInstance("instance");
      expect([canCacheShadowMaterial(material, mesh), canCacheShadowMaterial(material, instance)]).toEqual([true, true]);
      if (kind === "skeleton")
        mesh.skeleton = new Skeleton("rig", "rig", scene);
      if (kind === "morph")
        mesh.morphTargetManager = new MorphTargetManager(scene);
      if (kind === "baked")
        mesh.bakedVertexAnimationManager = new BakedVertexAnimationManager(
          scene,
        );
      if (kind === "render-hook") mesh.onBeforeRenderObservable.add(() => {});
      expect([canCacheShadowMaterial(material, mesh), canCacheShadowMaterial(material, instance)]).toEqual([false, false]);
    },
  );

  it("admits only a trusted opaque compiler result and revokes an out-of-band rebuild", async () => {
    const { scene, mesh } = fixture();
    const material = await compiledMaterial(
      scene,
      createDefaultMaterialDocument(),
    );
    mesh.material = material;
    expect(canCacheShadowMaterial(material, mesh)).toBe(true);
    const rebuilt = new Promise<void>((resolve) =>
      material.onBuildObservable.addOnce(() => resolve()),
    );
    material.build();
    await rebuilt;
    expect(canCacheShadowMaterial(material, mesh)).toBe(false);
    const masked = createDefaultMaterialDocument();
    masked.blendMode = "masked";
    expect(
      canCacheShadowMaterial(await compiledMaterial(scene, masked), mesh),
    ).toBe(false);
  });

  it("keeps a compiler result cacheable after the compiler rebuilds it for a texture that loaded", async () => {
    const { scene, mesh } = fixture();
    const document = createDefaultMaterialDocument();
    document.nodes.push({ id: "mask", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "mask" } });
    document.edges.push({ id: "mask-emission", sourceNodeId: "mask", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "emissive" });
    const texture = new Texture(null, scene);
    const loaded = vi.spyOn(texture, "isReady").mockReturnValue(false);
    const lowered = lowerMaterialDocument(document);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const result = compileMaterialPlan(lowered.plan, { scene, name: "textured", resolveTexture: () => texture });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(await result.ready).toEqual([]);
    const material = result.material;
    expect(canCacheShadowMaterial(material, mesh)).toBe(true);
    const built = material.buildId;
    loaded.mockReturnValue(true);
    const rebuilt = new Promise<void>((resolve) => material.onBuildObservable.addOnce(() => resolve()));
    texture.onLoadObservable.notifyObservers(texture);
    await rebuilt;
    // The same plan at a new build id: its vertex stage is still the stock transform.
    expect(material.buildId).not.toBe(built);
    expect(canCacheShadowMaterial(material, mesh)).toBe(true);
    result.dispose();
  });

  it("caches meshes without a cage while a cage's lattice wrapper is on their shared material", async () => {
    const { scene, mesh } = fixture();
    const caged = MeshBuilder.CreateBox("caged", {}, scene);
    const cage = { active: true, bindEffect: () => {}, bindBuffer: () => {} };
    setLatticeBinding(caged, cage);
    const native = new StandardMaterial("native", scene);
    const compiled = await compiledMaterial(scene, createDefaultMaterialDocument());
    expect(ensureNativeLatticeShadowDepthWrapper(native)).toBe(true);
    expect(ensureLatticeShadowAdapter(compiled)).toBe(true);
    for (const material of [native, compiled]) {
      expect(material.shadowDepthWrapper).not.toBeNull();
      // The wrapper draws a mesh without an active cage as its own geometry; the caged one deforms.
      expect([canCacheShadowMaterial(material, mesh), canCacheShadowMaterial(material, caged)]).toEqual([true, false]);
    }
    // A deformation that keeps the compiler's wrapper for every mesh is no longer the cage's alone.
    ensureAuthoredShadowDepthWrapper(compiled);
    expect(canCacheShadowMaterial(compiled, mesh)).toBe(false);
    releaseLatticeShadowAdapter(compiled);
    await releaseNativeLatticeShadowDepthWrapper(native);
    setLatticeBinding(caged);
  });

  it("rejects nested-function vertex displacement even with zero bounds padding", async () => {
    const { scene, mesh } = fixture();
    const fn = createDefaultMaterialFunctionDocument("Offset");
    const document = createDefaultMaterialDocument();
    document.boundsPadding = 0;
    document.nodes.push({
      id: "offset",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "offset-function" },
    });
    document.edges.push(
      {
        id: "to-offset",
        sourceNodeId: "baseColor",
        sourcePinId: "out",
        targetNodeId: "offset",
        targetPinId: "in_value",
      },
      {
        id: "offset-to-vertex",
        sourceNodeId: "offset",
        sourcePinId: "out_value",
        targetNodeId: "output",
        targetPinId: "worldPositionOffset",
      },
    );
    const material = await compiledMaterial(scene, document, {
      "offset-function": fn,
    });
    expect(material.metadata).toMatchObject({ boundsPadding: 0 });
    expect(canCacheShadowMaterial(material, mesh)).toBe(false);
  });

  it("does not certify custom GLSL even in an opaque fragment graph", async () => {
    const { scene, mesh } = fixture();
    const document = createDefaultMaterialDocument();
    document.nodes.push({
      id: "glsl",
      type: "custom.glsl",
      position: { x: 0, y: 0 },
      properties: newCustomGlslProperties(),
    });
    document.edges = document.edges.filter(
      (edge) => edge.id !== "e-color-output",
    );
    document.edges.push(
      {
        id: "color-to-glsl",
        sourceNodeId: "baseColor",
        sourcePinId: "out",
        targetNodeId: "glsl",
        targetPinId: "a",
      },
      {
        id: "glsl-to-output",
        sourceNodeId: "glsl",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    expect(
      canCacheShadowMaterial(await compiledMaterial(scene, document), mesh),
    ).toBe(false);
  });
});
