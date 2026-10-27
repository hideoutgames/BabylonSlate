import { describe, expect, it } from "vitest";
import { createEmptyProject, normalizeProjectSettings } from "./project";
import { normalizeScene } from "./scene";
import { normalizeRenderingPipeline, resolveRenderingPipeline } from "./rendering-pipeline";

describe("rendering pipeline contract", () => {
  it("migrates legacy project settings to WebGL2 without changing shading", () => {
    const legacy = normalizeProjectSettings({
      render: {
        mode: "cel",
        customResolution: false,
        width: 1280,
        height: 720,
        blackBars: true,
      },
    });
    expect(legacy.render).toMatchObject({
      gpuBackend: "webgl2",
      mode: "cel",
      customResolution: false,
      width: 1280,
      height: 720,
      blackBars: true,
    });
    expect(createEmptyProject("New").settings.render).toMatchObject({
      gpuBackend: "webgl2",
      mode: "pbr",
    });
  });

  it.each(["pbr", "cel"] as const)(
    "retains the requested backend across project save/reopen in %s",
    (mode) => {
      const project = createEmptyProject("Saved", {
        render: { gpuBackend: "webgpu", mode },
      });
      const reopened = normalizeProjectSettings(
        JSON.parse(JSON.stringify(project.settings)),
      );
      expect(reopened.render).toMatchObject({ gpuBackend: "webgpu", mode });
      expect(normalizeProjectSettings(reopened).render).toEqual(
        reopened.render,
      );
    },
  );

  it("drops a saved project's render path and rejects unknown backends", () => {
    // Projects saved while Clustered Forward existed load on the one lighting path.
    const reopened = normalizeProjectSettings({
      render: { renderPath: "clusteredForward", gpuBackend: "webgpu" } as Record<string, unknown>,
    });
    expect(reopened.render).not.toHaveProperty("renderPath");
    expect(reopened.render.gpuBackend).toBe("webgpu");
    expect(normalizeRenderingPipeline({ gpuBackend: "vulkan" })).toEqual({
      gpuBackend: "webgl2",
    });
    expect(normalizeRenderingPipeline({ gpuBackend: "auto" })).toEqual({
      gpuBackend: "auto",
    });
  });

  it("drops a stored legacy Scene renderPath key on normalize and round-trip", () => {
    const scene = normalizeScene({
      settings: { renderPath: "forward", environmentColor: [0.2, 0.3, 0.4] },
    });
    expect(scene.settings).not.toHaveProperty("renderPath");
    expect(scene.settings.environmentColor).toEqual([0.2, 0.3, 0.4]);
    const reopened = normalizeScene(JSON.parse(JSON.stringify(scene)));
    expect(reopened.settings).not.toHaveProperty("renderPath");
  });

  it("reports a requested WebGPU backend that is not active", () => {
    const result = resolveRenderingPipeline({ gpuBackend: "webgpu" });
    expect(result).toEqual({
      requested: { gpuBackend: "webgpu" },
      effective: { gpuBackend: "webgl2" },
      limits: [expect.stringContaining("WebGPU")],
    });
    expect(resolveRenderingPipeline({ gpuBackend: "webgl2" }).limits).toEqual([]);
  });

  it("reports the initialized backend and its fallback reason without rewriting preferences", () => {
    const requested = { gpuBackend: "webgpu" as const };
    const active = resolveRenderingPipeline(requested, { gpuBackend: "webgpu" });
    expect(active.effective.gpuBackend).toBe("webgpu");
    expect(active.limits).toEqual([]);
    const fallback = resolveRenderingPipeline(requested, {
      gpuBackend: "webgl2",
      reason: "Material uses Custom GLSL.",
    });
    expect(fallback.requested.gpuBackend).toBe("webgpu");
    expect(fallback.effective.gpuBackend).toBe("webgl2");
    expect(fallback.limits).toEqual(["Material uses Custom GLSL."]);
  });
});
