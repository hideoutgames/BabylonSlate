import { describe, expect, it } from "vitest";
import { FragmentOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/fragmentOutputBlock";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector2, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { VectorMergerBlock } from "@babylonjs/core/Materials/Node/Blocks/vectorMergerBlock";
import { VertexOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/vertexOutputBlock";
import { blockAdapterFor } from "./material-block-registry";

describe("Voronoi shader generation", () => {
  it("builds both noise outputs", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new NodeMaterial("Voronoi", scene);
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
      expect(source).toContain("voronoi(");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});
