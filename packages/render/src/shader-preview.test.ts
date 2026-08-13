import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeMaterial, NullEngine, Scene } from "@babylonjs/core";
import { createDefaultShaderGraph } from "@babylonslate/shader-graph";
import { applyShaderGraphPreview } from "./shader-preview";

describe("applyShaderGraphPreview", () => {
  let engine: NullEngine;
  let scene: Scene;

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  function host(): { engine: NullEngine; scene: Scene } {
    engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    scene = new Scene(engine);
    return { engine, scene };
  }

  it("parses a NodeMaterial when compile is not throttled", async () => {
    const { scene: previewScene } = host();
    const parsedSources: unknown[] = [];
    const forceCompilationAsync = vi.fn(async () => {});
    const result = await applyShaderGraphPreview({
      graph: createDefaultShaderGraph(),
      scene: previewScene,
      lastCompileAt: 0,
      now: 250,
      throttleMs: 250,
      parse: (source, hostScene) => {
        parsedSources.push(source);
        return NodeMaterial.Parse(source, hostScene);
      },
      forceCompilationAsync,
    });
    expect(result.compiled).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.parsed).toBe(true);
    expect(result.postProcess).toBe(false);
    expect(result.material?.getClassName()).toBe("NodeMaterial");
    expect(parsedSources).toHaveLength(1);
    expect(forceCompilationAsync).toHaveBeenCalledTimes(1);
  });

  it("uses NodeMaterial.Parse when no parser is injected", async () => {
    const { scene: previewScene } = host();
    const result = await applyShaderGraphPreview({
      graph: createDefaultShaderGraph(),
      scene: previewScene,
      now: 250,
    });
    expect(result.parsed).toBe(true);
    expect(result.material?.getClassName()).toBe("NodeMaterial");
    expect(result.material?.name).toBe("shader-preview");
  });

  it("parses a post-process default when the graph is flagged costly", async () => {
    const { scene: previewScene } = host();
    const graph = createDefaultShaderGraph();
    graph.postProcess = true;
    graph.nodes[1]!.type = "output.postProcess";
    const result = await applyShaderGraphPreview({
      graph,
      scene: previewScene,
      now: 250,
    });
    expect(result.postProcess).toBe(true);
    expect(result.ipadCostWarning).toBe(true);
    expect(result.parsed).toBe(true);
    expect(result.material?.getClassName()).toBe("NodeMaterial");
  });

  it("does not parse while the preview throttle window is open", async () => {
    const { scene: previewScene } = host();
    const parse = vi.fn();
    const result = await applyShaderGraphPreview({
      graph: createDefaultShaderGraph(),
      scene: previewScene,
      lastCompileAt: 0,
      now: 100,
      throttleMs: 250,
      parse,
    });
    expect(result.skipped).toBe(true);
    expect(result.compiled).toBe(false);
    expect(result.parsed).toBe(false);
    expect(result.material).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });
});
