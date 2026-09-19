import { describe, expect, it } from "vitest";
import * as upstream from "three-gpu-pathtracer";
import type { ShaderMaterial } from "three";
import { patchBakePrototypeShader } from "./bake-prototype-shader";

// Runtime export exists in pinned 0.0.24 but is deliberately omitted from its .d.ts.
const PhysicalMaterial = (upstream as unknown as { PhysicalPathTracingMaterial: new () => ShaderMaterial }).PhysicalPathTracingMaterial;

describe("pinned bake shader compatibility", () => {
  it("accepts the installed transport and rejects missing or duplicate estimator boundaries", () => {
    const material = new PhysicalMaterial();
    try {
      expect(() => patchBakePrototypeShader(material.fragmentShader)).not.toThrow();
      expect(() => patchBakePrototypeShader(material.fragmentShader.replace("Ray ray = getCameraRay();", ""))).toThrow("Unsupported");
      expect(() => patchBakePrototypeShader(`${material.fragmentShader}\n// globals`)).toThrow("Unsupported");
    } finally {
      material.dispose();
    }
  });
});
