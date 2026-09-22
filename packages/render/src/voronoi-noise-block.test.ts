import { describe, expect, it } from "vitest";
import {
  FragmentOutputBlock,
  InputBlock,
  NodeMaterial,
  NullEngine,
  Scene,
  ShaderLanguage,
  Vector2,
  Vector4,
  VectorMergerBlock,
  VertexOutputBlock,
} from "@babylonjs/core";
import { blockAdapterFor } from "./material-block-registry";

describe("Voronoi shader generation", () => {
  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("builds both noise outputs without illegal parameter writes in language %s", async (shaderLanguage) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new NodeMaterial("Voronoi", scene);
      // Exercise source generation on NullEngine; material-noise.spec.ts covers
      // shader compilation and pixels on actual WebGL2 and WebGPU engines.
      material.shaderLanguage = shaderLanguage;
      const noise = blockAdapterFor("noise.voronoi")!({
        name: "noise",
        operation: {
          id: "noise",
          nodeType: "noise.voronoi",
          resolvedType: "float",
          inputs: {},
          properties: {},
          source: { nodeId: "noise", callPath: [] },
        },
        plumbing: {},
      });
      for (const [pin, value] of [["uv", new Vector2(0.2, 0.7)], ["offset", 0.3], ["density", 5]] as const) {
        const input = new InputBlock(pin);
        input.value = value;
        input.output.connectTo(noise.inputs[pin]!);
      }
      const color = new VectorMergerBlock("color");
      noise.outputs.out!.connectTo(color.x);
      noise.outputs.cells!.connectTo(color.y);
      const fragment = new FragmentOutputBlock("fragment");
      color.xyzw.connectTo(fragment.rgba);
      const position = new InputBlock("position");
      position.value = new Vector4(0, 0, 0, 1);
      const vertex = new VertexOutputBlock("vertex");
      position.output.connectTo(vertex.vector);
      material.addOutputNode(vertex);
      material.addOutputNode(fragment);
      await new Promise<void>((resolve, reject) => {
        material.onBuildObservable.addOnce(() => resolve());
        material.onBuildErrorObservable.addOnce(reject);
        material.build();
      });
      const source = material.compiledShaders;
      if (shaderLanguage === ShaderLanguage.WGSL) {
        expect(source).toContain("fn voronoiRandom(");
        // By-value WGSL arguments are immutable; native out arguments use pointers.
        expect(source).not.toMatch(/\b(?:p|seed|offset|density|outValue|cells)\s*=/);
        expect(source).toMatch(/\(\*outValue\)\s*=/);
        expect(source).toMatch(/\(\*cells\)\s*=/);
      } else {
        expect(source).toContain("vec2 voronoiRandom(");
        expect(source).toContain("out float outValue");
        expect(source).toContain("out float cells");
      }
      expect(source).toContain("voronoi(");
      expect(source).toContain("tempOutput");
      expect(source).toContain("tempCells");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
