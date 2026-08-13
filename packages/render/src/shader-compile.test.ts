import { describe, expect, it } from "vitest";
import { createDefaultShaderGraph } from "@babylonslate/shader-graph";
import { compileShaderGraphForRender, compileShaderGraphAtLoad } from "./shader-compile";

describe("compileShaderGraphForRender", () => {
  it("skips recompile inside the preview throttle window", () => {
    const graph = createDefaultShaderGraph();
    const skipped = compileShaderGraphForRender({
      graph,
      lastCompileAt: 0,
      now: 100,
      throttleMs: 250,
    });
    expect(skipped.skipped).toBe(true);
    expect(skipped.compiled).toBe(false);
    const ready = compileShaderGraphForRender({
      graph,
      lastCompileAt: 0,
      now: 250,
      throttleMs: 250,
    });
    expect(ready.skipped).toBe(false);
    expect(ready.compiled).toBe(true);
    expect(ready.fragmentOutputNodeId).toBe("out");
  });

  it("load compile ignores preview throttle and awaits forceCompilation", async () => {
    let calls = 0;
    const result = await compileShaderGraphAtLoad(
      createDefaultShaderGraph(),
      async () => {
        calls += 1;
      },
    );
    expect(calls).toBe(1);
    expect(result.compiled).toBe(true);
    expect(result.skipped).toBe(false);
  });
});
