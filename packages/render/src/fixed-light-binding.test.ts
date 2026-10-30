import {
  DirectionalLight,
  MaterialHelper,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  SpotLight,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  type Effect,
  type Light,
  type Material,
  type Mesh,
} from "@babylonjs/core";
import { WebGL2ShaderProcessor } from "@babylonjs/core/Engines/WebGL/webGL2ShaderProcessors";
import { normalizeShadowSettings } from "@haptic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setFixedShapeLightingWorldScene } from "./fixed-light-admission";
import { emptyLightSeatBuffer } from "./fixed-light-binding";
import { existingShadowSamplerPlaceholders, shadowSamplerPlaceholders } from "./shadow-sampler-placeholders";
import { setAuthoredLightEnabled } from "./light-policy";
import { updateSceneRenderingSettings } from "./render-settings";
import { syncSceneLighting } from "./scene-lighting";
import { sceneShadowController } from "./shadow-controller";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A world Scene on a headless WebGL2 Engine with uniform buffers. */
function world() {
  const engineOptions = new NullEngineOptions();
  engineOptions.enableMultiview = true;
  const engine = new NullEngine(engineOptions);
  engines.push(engine);
  // WebGL2's shader processing, so effects hold the source a WebGL2 Engine compiles (inactive #if blocks removed).
  (engine as unknown as { _shaderProcessor: WebGL2ShaderProcessor })._shaderProcessor = new WebGL2ShaderProcessor();
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  scene.environmentBRDFTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  vi.spyOn(scene.environmentBRDFTexture, "isReady").mockReturnValue(true);
  setFixedShapeLightingWorldScene(scene);
  return { engine, scene };
}

function frame(scene: Scene) {
  syncSceneLighting(scene);
  scene.incrementRenderId();
}

async function effectOf(material: Material, mesh: Mesh): Promise<Effect> {
  const subMesh = mesh.subMeshes[0]!;
  await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
  return subMesh.effect!;
}

function receivers(scene: Scene) {
  const pbr = new PBRMaterial("native-pbr", scene);
  const standard = new StandardMaterial("native-standard", scene);
  const meshes = [pbr, standard].map((material, index) => {
    const mesh = MeshBuilder.CreateBox(`receiver-${index}`, {}, scene);
    mesh.material = material;
    return mesh;
  });
  return { pbr, standard, meshes };
}

describe("binding a previous Effect", () => {
  /** What `BindLights` binds for `effect` and the mesh's current lights, as a world view's draw of a previous Effect would. */
  function bindPrevious(material: Material & { maxSimultaneousLights: number }, mesh: Mesh, effect: Effect) {
    const blocks = vi.spyOn(effect, "bindUniformBuffer");
    const textures = vi.spyOn(effect, "setTexture");
    try {
      MaterialHelper.BindLights(mesh.getScene(), mesh, effect, mesh.subMeshes[0]!.materialDefines!, material.maxSimultaneousLights);
      return {
        blocks: new Map(blocks.mock.calls.map(([buffer, name]) => [name, buffer])),
        textures: new Map(textures.mock.calls.map(([name, texture]) => [name, texture])),
      };
    } finally {
      blocks.mockRestore();
      textures.mockRestore();
    }
  }
  const buffer = (light: Light) => (light as unknown as { _uniformBuffer: { getBuffer(): unknown } })._uniformBuffer.getBuffer();

  it("binds each shader light to a light of its own kind, or the empty buffer of that kind once none is left", async () => {
    const { engine, scene } = world();
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2), scene);
    const near = new PointLight("near", new Vector3(-1, 2, 1), scene);
    const far = new PointLight("far", new Vector3(1, 2, 1), scene);
    const { pbr, meshes } = receivers(scene);
    frame(scene);
    const previous = await effectOf(pbr, meshes[0]!);
    for (const [index, kind] of ["DIRLIGHT", "POINTLIGHT", "POINTLIGHT"].entries()) expect(previous.defines).toContain(`#define ${kind}${index}\n`);
    // One point goes and a spot arrives: the mesh's third light is now a spot, a larger Light block than the point's.
    setAuthoredLightEnabled(far, false);
    const spot = new SpotLight("spot", new Vector3(0, 3, 0), Vector3.Down(), 1, 2, scene);
    frame(scene);
    expect(meshes[0]!.lightSources).toEqual([sun, near, spot]);
    const { blocks } = bindPrevious(pbr, meshes[0]!, previous);
    expect([blocks.get("Light0"), blocks.get("Light1"), blocks.get("Light2")])
      .toEqual([buffer(sun), buffer(near), emptyLightSeatBuffer(engine, "point").getBuffer()]);
    // The Effect the mesh's lights ask for now binds as Babylon does.
    const current = await effectOf(pbr, meshes[0]!);
    expect(current).not.toBe(previous);
    expect(bindPrevious(pbr, meshes[0]!, current).blocks.get("Light2")).toBe(buffer(spot));
  });

  it("binds a placeholder of the sampler's type where the previous Effect samples a shadow map that is gone", async () => {
    const { scene } = world();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }) });
    const shadows = sceneShadowController(scene);
    const spot = new SpotLight("spot", new Vector3(0, 3, 0), Vector3.Down(), 1, 2, scene);
    shadows.register(spot, true);
    const { standard, meshes } = receivers(scene);
    meshes[1]!.receiveShadows = true;
    const sync = () => {
      syncSceneLighting(scene);
      shadows.sync();
      frame(scene);
    };
    sync();
    const previous = await effectOf(standard, meshes[1]!);
    expect(previous.defines).toContain("#define SHADOW0\n");
    // The spot stops casting: its map is released while the receiver may still draw the shadowed variant.
    shadows.register(spot, false);
    sync();
    expect(shadows.generator(spot)).toBeNull();
    shadowSamplerPlaceholders(scene);
    const placeholders = existingShadowSamplerPlaceholders(scene)!;
    const bound = bindPrevious(standard, meshes[1]!, previous);
    expect(bound.blocks.get("Light0")).toBe(buffer(spot));
    expect(bound.textures.get("shadowTexture0")).toBe(previous.defines.includes("#define SHADOWPCF0\n") ? placeholders.compare : placeholders.plain);
  });
});
