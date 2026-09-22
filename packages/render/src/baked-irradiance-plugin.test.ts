import { afterEach, describe, expect, it } from "vitest";
import {
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  ShaderLanguage,
  StandardMaterial,
} from "@babylonjs/core";
import { CelMaterial } from "./cel-material";
import { BakedIrradiancePlugin } from "./baked-irradiance-plugin";
import type { BakedIrradianceSampling } from "./baked-irradiance";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

function sampling(scene: Scene): BakedIrradianceSampling {
  return {
    texture: RawTexture.CreateRGBATexture(
      new Uint8Array(16).fill(255),
      1,
      1,
      scene,
      false,
    ),
    scale: [1, 1],
    offset: [0, 0],
    includesEnvironment: true,
  };
}

const fragmentCode = (plugin: BakedIrradiancePlugin, wgsl = false) =>
  plugin.getCustomCode(
    "fragment",
    wgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  ) as Record<string, string>;

describe("BakedIrradiancePlugin getCustomCode", () => {
  it("zeroes finalIrradiance under SLATE_BAKED_ENV for PBR GLSL", () => {
    const scene = host();
    const plugin = new BakedIrradiancePlugin(
      new PBRMaterial("pbr", scene),
      sampling(scene),
    );
    const code = fragmentCode(plugin);
    expect(
      code["!(vec3 finalIrradiance=reflectionOut.environmentIrradiance;)"],
    ).toContain("#ifdef SLATE_BAKED_ENV\nfinalIrradiance=vec3(0.);\n#endif");
  });

  it("uses the vec3f form for PBR WGSL", () => {
    const scene = host();
    const plugin = new BakedIrradiancePlugin(
      new PBRMaterial("pbr", scene),
      sampling(scene),
    );
    const code = fragmentCode(plugin, true);
    expect(
      code["!(var finalIrradiance: vec3f=reflectionOut.environmentIrradiance;)"],
    ).toContain("#ifdef SLATE_BAKED_ENV\nfinalIrradiance=vec3f(0.);\n#endif");
  });

  it("adds no finalIrradiance key for StandardMaterial", () => {
    const scene = host();
    const plugin = new BakedIrradiancePlugin(
      new StandardMaterial("standard", scene),
      sampling(scene),
    );
    const code = fragmentCode(plugin);
    expect(
      Object.keys(code).some((key) => key.includes("finalIrradiance")),
    ).toBe(false);
    expect(code["!(vec3 finalDiffuse=)"]).toBeDefined();
  });

  it("adds only declarations for a CelMaterial host", () => {
    const scene = host();
    const plugin = new BakedIrradiancePlugin(
      new CelMaterial(new PBRMaterial("source", scene), scene),
      sampling(scene),
    );
    const code = fragmentCode(plugin);
    expect(code["CUSTOM_FRAGMENT_DEFINITIONS"]).toContain(
      "slateBakedIrradiance",
    );
    expect(
      Object.keys(code).some(
        (key) => key.includes("finalDiffuse") || key.includes("finalIrradiance"),
      ),
    ).toBe(false);
  });
});
