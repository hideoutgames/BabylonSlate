import { afterEach, describe, expect, it, vi } from "vitest";
import { Color3, FreeCamera, Matrix, MeshBuilder, Vector3, NullEngine, Scene, ShaderLanguage, type AbstractMesh, type NodeMaterial } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@haptic/core";
import { createDefaultMaterialDocument, createWaterMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { createWaterMesh, sceneWaterSamplesSceneCopy, updateSceneWater, waterMeshSamplesSceneCopy } from "./water-mesh";
import { materialSceneCopyUse, materialUsesWaterFields, meshWaterNodeSurface } from "./water-node-blocks";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); });

function host(webgpu = false): Scene {
  const engine = new NullEngine(), scene = new Scene(engine);
  if (webgpu) vi.spyOn(engine, "isWebGPU", "get").mockReturnValue(true);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return scene;
}

type Wire = readonly [node: string, pin: string, target: string];
/** A Surface graph of `nodes` (id = type suffix), each output wired to a Material Output pin. */
function graph(nodes: readonly string[], wires: readonly Wire[], blendMode: MaterialDocument["blendMode"] = "opaque"): MaterialDocument {
  const doc = createDefaultMaterialDocument("Water");
  doc.blendMode = blendMode;
  doc.edges = doc.edges.filter((edge) => !wires.some(([, , target]) => edge.targetNodeId === "output" && edge.targetPinId === target));
  for (const id of nodes) doc.nodes.push({ id, type: `input.${id}`, position: { x: 0, y: 0 }, properties: {} });
  for (const [node, pin, target] of wires) doc.edges.push({ id: `${node}-${pin}-${target}`, sourceNodeId: node, sourcePinId: pin, targetNodeId: "output", targetPinId: target });
  return doc;
}
/** Every water node with Water Waves: the waves displace and shade, the others feed colour, roughness and opacity. */
const allNodes = (blendMode: MaterialDocument["blendMode"] = "translucent") => graph(
  ["waterWaves", "waterFoam", "waterDepthFade", "waterSceneColor", "waterReflection"],
  [["waterWaves", "offset", "worldPositionOffset"], ["waterWaves", "normal", "normal"], ["waterReflection", "color", "baseColor"],
    ["waterSceneColor", "color", "emissive"], ["waterFoam", "foam", "roughness"], ["waterDepthFade", "fade", "opacity"], ["waterReflection", "fresnel", "metallic"]],
  blendMode,
);

function compile(scene: Scene, doc: MaterialDocument) {
  const plan = lowerMaterialDocument(doc);
  if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
  const result = compileMaterialPlan(plan.plan, { scene, name: "water" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  disposers.push(result.dispose);
  return result;
}

async function definesFor(material: NodeMaterial, mesh: AbstractMesh): Promise<string> {
  await material.forceCompilationAsync(mesh);
  expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
  return mesh.subMeshes[0]!.effect!.defines as string;
}
/** The reflection march's function text. */
const march = (source: string) => /swMarch\(swOrigin[\s\S]*?\n\}/.exec(source)?.[0] ?? "";

describe("Water material nodes", () => {
  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("compile together with Water Waves in language %s, every prefix bound", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL, result = compile(host(wgsl), allNodes());
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders, [, fragment = ""] = source.split("// Fragment shader");
    expect(source).not.toMatch(/\b[UAOS]\.slate|\bIN\.|\bU\.\w/);
    // GLSL rejects a sampler declared twice in one stage.
    const [vertex = ""] = source.split("// Fragment shader");
    const declarations = (stage: string, name: string) => stage.split(wgsl ? `var ${name}: texture_` : ` ${name};`).length - 1;
    for (const name of ["slateWaterFftSampler", "slateWaterFoamSampler", "slateWaterFieldSampler", "slateWaterContactSampler", "slateWaterSceneSampler", "slateWaterNodeEnvSampler"]) {
      expect(declarations(fragment, name), name).toBe(1);
    }
    expect(declarations(vertex, "slateWaterFftSampler")).toBe(1);
    // Every preprocessor directive stands on its own line.
    expect(source).not.toMatch(/\bsw\w*[^\n]*\S#(ifdef|endif|if|else)\b/);
    for (const helper of ["swnFieldAt", "swnContactAt", "swSceneDepth", "swMarch", "swnEnvTap", "swnNoise"]) expect(fragment, helper).toContain(helper);
    // The terrain and contact fields read the water mesh's data, the copy only with the pass's copy, the cube only with a cube.
    const sampler = (name: string) => wgsl ? `var ${name}: texture_` : ` ${name};`;
    for (const [name, define] of [["slateWaterFieldSampler", "SLATE_WATER_SURFACE"], ["slateWaterSceneSampler", "SLATE_WATER_NODE_COPY"], ["slateWaterNodeEnvSampler", "SLATE_WATER_NODE_ENV"]] as const) {
      expect(fragment).toMatch(new RegExp(`#ifdef ${define}\\s+[^#]*${sampler(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    if (wgsl) {
      expect(fragment).not.toMatch(/^\s*(float|vec[234]) \w+ =/m);
      expect(fragment).toContain("fragmentInputs.position.xy");
      expect(fragment).toContain("fn swMarch(swOrigin: vec3f, swRay: vec3f, swVP: mat4x4f, swV: mat4x4f, swEyeP: vec3f) -> vec4f {");
      expect(march(fragment)).not.toMatch(/scene\.(view|vEyePosition)/);
    } else {
      expect(fragment).toContain("gl_FragCoord.xy");
      expect(fragment).toContain("vec4 swMarch(vec3 swOrigin, vec3 swRay, mat4 swVP, mat4 swV, vec3 swEyeP) {");
      expect(march(fragment)).not.toMatch(/\bvEyePosition\b|\(view \*/);
    }
  });

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])(
    "build the starter water Material in language %s, displacing and shading every kind of water body", async (language) => {
      const scene = host(language === ShaderLanguage.WGSL), doc = createWaterMaterialDocument("Sea");
      const plan = lowerMaterialDocument(doc);
      expect(plan.ok && plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const result = compile(scene, doc);
      expect(await result.ready).toEqual([]);
      // NullEngine has no lit WGSL includes to draw a mesh with.
      if (language === ShaderLanguage.WGSL) return;
      for (const kind of ["ocean", "lake", "river", "puddle", "global"] as const) {
        const body = createWaterMesh(scene, kind, normalizeWaterBody({ resolution: 8 }, kind), createDefaultWaterDefinition(), result.material);
        expect(await definesFor(result.material, body), kind).toMatch(/^#define SLATE_WATER_GPU_WAVES$/m);
        // It shows what lies below through the scene copy, which only a translucent Material can read.
        expect(result.material.needAlphaBlendingForMesh(body), kind).toBe(true);
        // A graph that reads terrain and contacts (its foam and depth) has the water mesh build them.
        expect(meshWaterNodeSurface(body)?.contacts ?? null, kind).not.toBeNull();
        body.dispose();
      }
    });

  it("give Water Colors the asset's own colours beside a Water Waves node", async () => {
    const scene = host(), water = { ...createDefaultWaterDefinition(), foamColor: [0.9, 0.5, 0.1] as [number, number, number] };
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    new FreeCamera("camera", new Vector3(0, 6, -12), scene);
    const result = compile(scene, graph(["waterWaves", "waterColors"], [["waterWaves", "offset", "worldPositionOffset"], ["waterWaves", "crestFoam", "roughness"], ["waterColors", "foamColor", "baseColor"]]));
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), water, result.material);
    await definesFor(result.material, lake);
    const effect = lake.subMeshes[0]!.effect!, bound = new Map<string, number[][]>();
    vi.spyOn(effect, "setFloat4").mockImplementation((name, x, y, z, w) => { bound.set(name, [...bound.get(name) ?? [], [x, y, z, w]]); return effect; });
    result.material.bindForSubMesh(lake.computeWorldMatrix(true), lake, lake.subMeshes[0]!);
    // The Foam Color output reads its own uniform: every block that binds it writes the linear Foam Color.
    const read = /(\w+) = (\w+)\.rgb;/.exec(result.material.compiledShaders.split("// Fragment shader")[1]!.match(/\w+ = slateWaterNode\w*Foam\w*\.rgb;/)![0])![2]!;
    const linear = new Color3(0.9, 0.5, 0.1).toLinearSpace(scene.getEngine().useExactSrgbConversions);
    const expected = [linear.r, linear.g, linear.b].map((v) => Number(v.toFixed(5)));
    expect(bound.get(read)!.map((value) => value.slice(0, 3).map((v) => Number(v.toFixed(5))))).toEqual(bound.get(read)!.map(() => expected));
  });

  it("compile without Water Waves, where Crest Foam and the per-pixel Normal fall back", async () => {
    const result = compile(host(), graph(["waterFoam", "waterReflection", "waterSceneColor"],
      [["waterFoam", "crestFoam", "roughness"], ["waterFoam", "foam", "metallic"], ["waterReflection", "color", "baseColor"], ["waterSceneColor", "color", "emissive"]]));
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders;
    expect(source).not.toMatch(/swnFoam|slateWaterFftSampler|SLATE_WATER_GPU_WAVES \d/);
    expect(source).toMatch(/swnN = normalize\(vec3\(0\.0, 1\.0, 0\.0\)\);/);
  });

  it("keep neutral outputs off water meshes and read the mesh's data on water", async () => {
    const scene = host(), result = compile(scene, allNodes());
    expect(await result.ready).toEqual([]);
    const ordinary = MeshBuilder.CreateGround("ordinary", {}, scene);
    ordinary.material = result.material;
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    const [plain, water] = [await definesFor(result.material, ordinary), await definesFor(result.material, lake)];
    expect(plain).not.toMatch(/^#define SLATE_WATER_SURFACE$/m);
    expect(water).toMatch(/^#define SLATE_WATER_SURFACE$/m);
    // No view registered a scene copy for this pass: the copy features compile out.
    expect(water).not.toMatch(/^#define SLATE_WATER_NODE_COPY$/m);
    expect(water).toMatch(/^#define SLATE_WATER_SSR_STEPS 0$/m);
  });

  it("give Custom Material water terrain and contact fields only when a node reads them", async () => {
    const scene = host(), water = createDefaultWaterDefinition();
    const foam = compile(scene, graph(["waterFoam"], [["waterFoam", "foam", "roughness"]]));
    const reflection = compile(scene, graph(["waterReflection"], [["waterReflection", "color", "baseColor"]]));
    expect(materialUsesWaterFields(foam.material)).toBe(true);
    expect(materialUsesWaterFields(reflection.material)).toBe(false);
    const foamy = createWaterMesh(scene, "foamy", normalizeWaterBody({ resolution: 8 }), water, foam.material);
    const mirror = createWaterMesh(scene, "mirror", normalizeWaterBody({ resolution: 8 }), water, reflection.material);
    expect(meshWaterNodeSurface(foamy)?.field).not.toBeNull();
    expect(meshWaterNodeSurface(foamy)?.contacts).not.toBeNull();
    expect(meshWaterNodeSurface(mirror)?.field).toBeNull();
    // A Material edit that adds a field-reading node builds them at the next water update.
    mirror.material = foam.material;
    updateSceneWater(scene);
    expect(meshWaterNodeSurface(mirror)?.field).not.toBeNull();
  });

  it("ask for the view's scene copy as built-in water does, only from alpha-blended water", () => {
    const scene = host();
    const blended = compile(scene, allNodes("translucent")), opaque = compile(scene, allNodes("opaque"));
    expect(materialSceneCopyUse(blended.material)).toEqual({ refraction: true, reflection: true });
    const water = createDefaultWaterDefinition();
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), { ...water, objectReflections: false }, blended.material);
    const pond = createWaterMesh(scene, "pond", normalizeWaterBody({ resolution: 8 }), water, opaque.material);
    updateSceneWater(scene);
    expect(sceneWaterSamplesSceneCopy(scene, true, false)).toBe(true);
    // Object reflections follow the asset: off on the blended lake, and the opaque pond draws before any copy exists.
    expect(waterMeshSamplesSceneCopy(lake, true, false)).toBe(true);
    expect(waterMeshSamplesSceneCopy(lake, false, true)).toBe(false);
    expect(waterMeshSamplesSceneCopy(pond, true, true)).toBe(false);
    lake.dispose(); pond.dispose();
    updateSceneWater(scene);
    expect(sceneWaterSamplesSceneCopy(scene, true, true)).toBe(false);
  });
});
