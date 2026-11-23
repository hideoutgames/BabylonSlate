import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { fsr1UpscalePixelShader } from "@babylonjs/core/Shaders/fsr1Upscale.fragment";
import { describe, expect, it } from "vitest";
import { easuSharedFetches } from "./fsr1-tasks";

describe("EASU's shared fetches", () => {
  it("fetches each footprint's four texels once for all three channels, and is the EASU Effects compile", () => {
    const shared = ShaderStore.ShadersStore[fsr1UpscalePixelShader.name]!;
    expect(shared).toBe(easuSharedFetches(fsr1UpscalePixelShader.shader));
    const main = shared.slice(shared.indexOf("vec3 FsrEasuF("));
    // No per-channel gather is left in the filter: a Babylon pin that rewrites them leaves this replacement undone.
    expect(main).not.toMatch(/FsrEasu[RGB]F\(/);
    expect(main.match(/FsrEasuRGBF\(p[0-3],/g)).toEqual(["FsrEasuRGBF(p0,", "FsrEasuRGBF(p1,", "FsrEasuRGBF(p2,", "FsrEasuRGBF(p3,"]);
    const helper = shared.slice(shared.indexOf("void FsrEasuRGBF("), shared.indexOf("void FsrEasuTapF("));
    expect(helper.match(/texelFetch\(/g)).toHaveLength(4);
    // The channels keep Babylon's texel order within each vector: (0,1), (1,1), (1,0), (0,0).
    expect(helper).toContain("r=vec4(t0.r,t1.r,t2.r,t3.r)");
  });
});
