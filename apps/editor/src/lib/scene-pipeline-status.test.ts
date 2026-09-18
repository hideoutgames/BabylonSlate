import { describe, expect, it } from "vitest";
import { resolveRenderingPipeline } from "@babylonslate/core";
import {
  readScenePipelineStatus,
  registerScenePipelineStatus,
  scenePipelineKey,
} from "./scene-pipeline-status";

describe("scene pipeline feedback ownership", () => {
  it("rejects callbacks and cleanup from a replaced viewport while isolating projects", () => {
    const key = scenePipelineKey("project-a", "scene-a");
    const siblingKey = scenePipelineKey("project-b", "scene-a");
    const old = registerScenePipelineStatus(key);
    const sibling = registerScenePipelineStatus(siblingKey);
    const forward = resolveRenderingPipeline({ renderPath: "forward" });
    const clustered = resolveRenderingPipeline(
      { renderPath: "clusteredForward" },
      undefined,
      { gpuBackend: "webgl2" },
      { supported: true, autoEligible: true },
    );
    old.publish(forward);
    sibling.publish(forward);
    const current = registerScenePipelineStatus(key);
    expect(readScenePipelineStatus(key)).toBeUndefined();
    current.publish(clustered);
    old.publish(forward);
    old.dispose();
    expect(readScenePipelineStatus(key)).toBe(clustered);
    expect(readScenePipelineStatus(siblingKey)).toBe(forward);
    current.dispose();
    expect(readScenePipelineStatus(key)).toBeUndefined();
    sibling.dispose();
  });
});
