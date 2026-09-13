import { describe, expect, it } from "vitest";
import { createEmptyProject, normalizeProjectSettings } from "./project";
import { normalizeScene } from "./scene";
import {
  normalizeRenderingPipeline,
  normalizeRenderPathOverrides,
  resolveRenderingPipeline,
  type RenderingPipelineSettings,
} from "./render-path";

describe("rendering pipeline contract", () => {
  it("migrates legacy project settings to Forward/WebGL2 without changing shading", () => {
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
      renderPath: "forward",
      gpuBackend: "webgl2",
      mode: "cel",
      customResolution: false,
      width: 1280,
      height: 720,
      blackBars: true,
    });
    expect(createEmptyProject("New").settings.render).toMatchObject({
      renderPath: "forward",
      gpuBackend: "webgl2",
      mode: "pbr",
    });
  });

  it.each(["pbr", "cel"] as const)(
    "retains requested paths and backends across project save/reopen in %s",
    (mode) => {
      const project = createEmptyProject("Saved", {
        render: { renderPath: "clusteredForward", gpuBackend: "webgpu", mode },
      });
      const reopened = normalizeProjectSettings(
        JSON.parse(JSON.stringify(project.settings)),
      );
      expect(reopened.render).toMatchObject({
        renderPath: "clusteredForward",
        gpuBackend: "webgpu",
        mode,
      });
      expect(normalizeProjectSettings(reopened).render).toEqual(
        reopened.render,
      );
    },
  );

  it("rejects unsupported public enum values without inventing new renderers", () => {
    expect(
      normalizeRenderingPipeline({
        renderPath: "deferred",
        gpuBackend: "vulkan",
      }),
    ).toEqual({
      renderPath: "forward",
      gpuBackend: "webgl2",
    });
    expect(
      normalizeRenderPathOverrides({ renderPath: "gi", gpuBackend: "webgpu" }),
    ).toEqual({});
    expect(
      normalizeRenderPathOverrides({
        renderPath: "auto",
        gpuBackend: "webgpu",
      }),
    ).toEqual({ renderPath: "auto" });
    expect(
      normalizeRenderingPipeline({ renderPath: "auto", gpuBackend: "auto" }),
    ).toEqual({
      renderPath: "auto",
      gpuBackend: "auto",
    });
  });

  it("preserves sparse scene paths on reopen and restores precedence after reset", () => {
    const project: RenderingPipelineSettings = {
      renderPath: "clusteredForward",
      gpuBackend: "webgl2",
    };
    const scene = normalizeScene({
      settings: { renderPath: "forward", environmentColor: [0.2, 0.3, 0.4] },
    });
    const reopened = normalizeScene(JSON.parse(JSON.stringify(scene)));
    expect(reopened.settings.renderPath).toBe("forward");
    expect(reopened.settings.environmentColor).toEqual([0.2, 0.3, 0.4]);
    expect(
      resolveRenderingPipeline(project, reopened.settings).requested.renderPath,
    ).toBe("forward");
    const local = { renderPath: "auto" as const };
    const session = { renderPath: "clusteredForward" as const };
    expect(
      resolveRenderingPipeline(project, reopened.settings, local, session)
        .requested.renderPath,
    ).toBe("clusteredForward");
    expect(
      resolveRenderingPipeline(project, reopened.settings, local).requested
        .renderPath,
    ).toBe("auto");
    delete reopened.settings.renderPath;
    expect(
      resolveRenderingPipeline(project, reopened.settings).requested.renderPath,
    ).toBe("clusteredForward");
    project.renderPath = "auto";
    expect(
      resolveRenderingPipeline(project, reopened.settings).requested.renderPath,
    ).toBe("auto");
    expect(
      normalizeScene({ settings: { renderPath: "invalid" } }).settings,
    ).not.toHaveProperty("renderPath");
    expect(normalizeScene({}).settings).not.toHaveProperty("renderPath");
  });

  it.each([
    { renderPath: "auto", gpuBackend: "auto" },
    { renderPath: "clusteredForward", gpuBackend: "webgpu" },
  ] as const)(
    "reports unavailable renderer requests without activating them: %j",
    (requested) => {
      const saved = { ...requested };
      const result = resolveRenderingPipeline(requested);
      expect(result.requested).toEqual(saved);
      expect(requested).toEqual(saved);
      expect(result.effective).toEqual({
        renderPath: "forward",
        gpuBackend: "webgl2",
      });
      expect(result.limits).toEqual([
        expect.stringContaining("ClusteredForward"),
        expect.stringContaining("WebGPU"),
      ]);
      expect(
        resolveRenderingPipeline({
          renderPath: "forward",
          gpuBackend: "webgl2",
        }).limits,
      ).toEqual([]);
    },
  );
});
