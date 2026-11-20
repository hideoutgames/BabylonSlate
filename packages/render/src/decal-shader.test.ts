import { describe, expect, it } from "vitest";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { DECAL_SHADER_NAME, registerDecalShaders } from "./decal-shader";

/** The source of the GLSL function `name` in `source`, from its signature to its closing brace. */
function glslFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`\\b\\w+\\s+${name}\\s*\\(`));
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not closed`);
}

describe("decal shader", () => {
  // Source-text contract: no GPU here runs D3D11's HLSL compiler. On Windows (ANGLE D3D11) a `return` before the fog
  // function's end crashed the GPU process while the lit decal program linked, losing the WebGL context in Play.
  it("leaves the fog function by its one final return", () => {
    registerDecalShaders();
    const fragment = ShaderStore.ShadersStore[`${DECAL_SHADER_NAME}FragmentShader`]!;
    const fog = glslFunction(fragment, "decalFogKeep");
    expect(fog.match(/\breturn\b/g)).toHaveLength(1);
    expect(fog.trimEnd()).toMatch(/return [^;]+;\s*\}$/);
  });
});
