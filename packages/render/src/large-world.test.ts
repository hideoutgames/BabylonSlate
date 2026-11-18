import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { afterEach, describe, expect, it } from "vitest";
import { createHeadlessEngine } from "./large-world";

describe("Large World Rendering and page matrix precision", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

  it("builds matrices in 64 bits after a headless Engine, which a default one would turn to 32", () => {
    // Babylon's default: any Engine constructor sets the precision of every later matrix on the page.
    engines.push(new NullEngine());
    expect(new Matrix().asArray()).toBeInstanceOf(Float32Array);
    const engine = createHeadlessEngine();
    engines.push(engine);
    const matrix = new Matrix();
    expect(matrix.asArray()).not.toBeInstanceOf(Float32Array);
    // 20 km out, a centimetre survives in the translation the floating origin subtracts the eye from.
    Matrix.TranslationToRef(20_000.01, 0, 0, matrix);
    expect(matrix.m[12]! - 20_000).toBeCloseTo(0.01, 9);
  });
});
