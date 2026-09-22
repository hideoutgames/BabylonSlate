import { describe, expect, it } from "vitest";
import { ShaderStore } from "@babylonjs/core";
import { lightsFragmentFunctionsWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightsFragmentFunctions";
import { celLightingFunctions } from "./cel-shader";

describe("CEL WGSL clustered adapter", () => {
  const source = celLightingFunctions(lightsFragmentFunctionsWGSL.shader, true);

  it("adds the sequential fields to the WGSL lighting info struct", () => {
    expect(source).toContain(
      "{diffuse: vec3f,slateCelPeak: f32,slateCelTotal: f32,slateCelWins: f32,",
    );
  });

  it("routes clustered compute children through the slate include", () => {
    expect(source).toContain(
      "#include<slateCelClusteredLightingCompute>[0..maxSimultaneousLights]",
    );
    expect(source).not.toContain("#include<clusteredLightingCompute>");
  });

  it("registers the patched WGSL compute include", () => {
    const include =
      ShaderStore.GetIncludesShadersStore(1).slateCelClusteredLightingCompute;
    expect(include).toContain("slateCelPreviousPeak: f32");
    expect(include).toContain("slateCelAccumulate(result.diffuse,info.diffuse,wins)");
    expect(include).toContain("result.slateCelPeak=slateCelPreviousPeak");
  });

  it("passes the running peak into WGSL clustered call sites", () => {
    const fragment =
      ShaderStore.GetIncludesShadersStore(1).slateCelLightFragment;
    expect(fragment).toContain(
      "vec2u(light{X}.vSliceRanges[sliceIndex].xy),glossiness,slateCelPeak);}",
    );
    expect(fragment).toContain("slateCelWins=info.slateCelWins;");
    expect(fragment).toContain("slateCelPeak=info.slateCelPeak;");
    expect(fragment).toContain("#ifdef CLUSTLIGHT{X}");
  });
});
