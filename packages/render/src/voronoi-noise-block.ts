import { VoronoiNoiseBlock } from "@babylonjs/core/Materials/Node/Blocks/voronoiNoiseBlock";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

/** Corrects Babylon 9.20's Voronoi WGSL without changing its GLSL generation. */
export class SlateVoronoiNoiseBlock extends VoronoiNoiseBlock {
  override getClassName(): string {
    return "SlateVoronoiNoiseBlock";
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this | undefined {
    if (state.shaderLanguage === ShaderLanguage.WGSL && this.seed.isConnected) {
      // Function emission is deduplicated per build. Supply WGSL translations
      // before the native block emits its functions and unchanged output wiring.
      state._emitFunction("voronoiRandom", `fn voronoiRandom(p: vec2f) -> vec2f {
        let projected = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
        return fract(sin(projected) * 18.5453);
      }`, "// Voronoi random generator");
      state._emitFunction("voronoi", `fn voronoi(
        seed: vec2f, offset: f32, density: f32,
        outValue: ptr<function, f32>, cells: ptr<function, f32>
      ) {
        let n = floor(seed * density);
        let f = fract(seed * density);
        var m = vec3f(8.0);
        for (var j: i32 = -1; j <= 1; j++) {
          for (var i: i32 = -1; i <= 1; i++) {
            let g = vec2f(f32(i), f32(j));
            let o = voronoiRandom(n + g);
            let r = g - f + (vec2f(0.5) + 0.5 * sin(vec2f(offset) + 6.2831 * o));
            let d = dot(r, r);
            if (d < m.x) {
              m = vec3f(d, o);
              (*outValue) = m.x;
              (*cells) = m.y;
            }
          }
        }
      }`, "// Voronoi");
    }
    return super._buildBlock(state);
  }
}

RegisterClass("BABYLON.SlateVoronoiNoiseBlock", SlateVoronoiNoiseBlock);
