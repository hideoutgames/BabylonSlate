import { afterEach, describe, expect, it, vi } from "vitest";
import { Color3, FreeCamera, MeshBuilder, NullEngine, Scene, ShaderLanguage, ShaderStore, StandardMaterial, Vector3 } from "@babylonjs/core";
import "@babylonjs/core/Shaders/ShadersInclude/fogFragment";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/fogFragment";
import { StandardFogPlugin } from "./standard-fog";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

/** Applies the plugin's fragment replacements to `code` as Babylon's plugin manager does. */
function inject(plugin: StandardFogPlugin, language: ShaderLanguage, code: string): string {
  for (const [key, value] of Object.entries(plugin.getCustomCode("fragment", language) ?? {})) {
    expect(key.startsWith("!")).toBe(true);
    code = code.replace(new RegExp(key.slice(1), "g"), value);
  }
  return code;
}

describe("Standard material fog", () => {
  it("replaces Babylon's display-space fog mix with the one rule, on both backends", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const plugin = new StandardFogPlugin(new StandardMaterial("text", new Scene(engine)));
    const glsl = inject(plugin, ShaderLanguage.GLSL, ShaderStore.IncludesShadersStore.fogFragment!);
    expect(glsl).not.toContain("color.rgb=mix(vFogColor,color.rgb,fog);");
    expect(glsl).toContain("color.rgb=toGammaSpace(mix(toLinearSpace(vFogColor),toLinearSpace(color.rgb),toLinearSpace(fog)));");
    const wgsl = inject(plugin, ShaderLanguage.WGSL, ShaderStore.IncludesShadersStoreWGSL.fogFragment!);
    expect(wgsl).not.toContain("mix(uniforms.vFogColor,color.rgb,fog)");
    expect(wgsl).toContain("toGammaSpaceVec3(mix(toLinearSpaceVec3(uniforms.vFogColor),toLinearSpaceVec3(color.rgb),toLinearSpace(fog)))");
    expect(plugin.getCustomCode("vertex", ShaderLanguage.GLSL)).toBeNull();
  });

  it("fogs every Standard material by the rule, created after the last Engine closed too", async () => {
    // The persistent registration survives every Engine's disposal (`registerPersistentMaterialPlugin`).
    new NullEngine().dispose();
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 0, -5), scene);
    scene.fogMode = Scene.FOGMODE_LINEAR;
    const material = new StandardMaterial("text3d", scene);
    material.disableLighting = true;
    material.emissiveColor = new Color3(1, 0.5, 0.2);
    expect(material.pluginManager?.getPlugin("HapticStandardFog")).toBeInstanceOf(StandardFogPlugin);
    const mesh = MeshBuilder.CreatePlane("text", {}, scene);
    mesh.material = material;
    const subMesh = mesh.subMeshes[0]!;
    await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
    const effect = subMesh.effect!;
    expect(effect.defines).toMatch(/^#define FOG$/m);
    expect(effect.fragmentSourceCode).toContain("toGammaSpace(mix(toLinearSpace(vFogColor),toLinearSpace(color.rgb),toLinearSpace(fog)))");
    expect(effect.fragmentSourceCode).not.toContain("mix(vFogColor,color.rgb,fog)");
  });
});
