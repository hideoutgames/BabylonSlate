import { afterEach, describe, expect, it } from "vitest";
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
} from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  lowerMaterialDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { CelMaterial } from "./cel-material";
import { compileMaterialPlan } from "./material-compiler";
import { canCacheShadowMaterial } from "./shadow-material-policy";
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

function withTextureQuality<T extends PBRMaterial | StandardMaterial>(
  material: T,
): T {
  // Babylon clears global plugin factories when the last test Engine is disposed.
  // Keep each case representative of the renderer's actual native materials.
  if (!material.pluginManager?.getPlugin("SlateTextureQuality"))
    new TextureQualityPlugin(material);
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
  it.each(["pbr", "standard", "cel"] as const)(
    "admits an opaque native %s caster but stops caching alpha coverage",
    (kind) => {
      const { scene, mesh } = fixture();
      const material = withTextureQuality(
        kind === "pbr"
          ? new PBRMaterial("opaque", scene)
          : kind === "standard"
            ? new StandardMaterial("opaque", scene)
            : new CelMaterial(
                withTextureQuality(new PBRMaterial("source", scene)),
                scene,
              ),
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

  it("revokes native CEL provenance if its shader or bind hooks change", () => {
    const { scene, mesh } = fixture();
    const material = new CelMaterial(new PBRMaterial("source", scene), scene);
    const resolver = material.customShaderNameResolve;
    material.customShaderNameResolve = () => "custom";
    expect(canCacheShadowMaterial(material, mesh)).toBe(false);
    material.customShaderNameResolve = resolver;
    expect(canCacheShadowMaterial(material, mesh)).toBe(true);
    material.onBindObservable.add(() => {});
    expect(canCacheShadowMaterial(material, mesh)).toBe(false);
  });

  it.each(["skeleton", "morph", "baked", "instance", "render-hook"] as const)(
    "keeps %s deformation on live shadow refresh",
    (kind) => {
      const { scene, mesh } = fixture();
      const material = new PBRMaterial("native", scene);
      if (kind === "skeleton")
        mesh.skeleton = new Skeleton("rig", "rig", scene);
      if (kind === "morph")
        mesh.morphTargetManager = new MorphTargetManager(scene);
      if (kind === "baked")
        mesh.bakedVertexAnimationManager = new BakedVertexAnimationManager(
          scene,
        );
      if (kind === "instance") mesh.createInstance("instance");
      if (kind === "render-hook") mesh.onBeforeRenderObservable.add(() => {});
      expect(canCacheShadowMaterial(material, mesh)).toBe(false);
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
      properties: { body: "a + b" },
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
