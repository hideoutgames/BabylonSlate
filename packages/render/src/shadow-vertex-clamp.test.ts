import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { describe, expect, it } from "vitest";
import { SHADOW_RASTER_CLAMP_DEFINE, SHADOW_VERTEX_CLAMP_DEFINE, applyRasterDepthClamp, applyVertexDepthClamp } from "./shadow-vertex-clamp";

describe("vertex-stage shadow depth clamp", () => {
  it("asks for the vertex clamp only where Babylon asked for the fragment clamp", () => {
    const clamped = ["#define SM_FLOAT 0", "#define SM_DEPTHCLAMP 1", "#define SM_USEDISTANCE 0"];
    applyVertexDepthClamp(clamped);
    expect(clamped).toEqual(["#define SM_FLOAT 0", SHADOW_VERTEX_CLAMP_DEFINE, "#define SM_USEDISTANCE 0"]);
    // Contact Hardening draws unclamped: it stays so.
    const unclamped = ["#define SM_DEPTHCLAMP 0"];
    applyVertexDepthClamp(unclamped);
    expect(unclamped).toEqual(["#define SM_DEPTHCLAMP 0"]);
    const raster = ["#define SM_DEPTHCLAMP 1"];
    applyRasterDepthClamp(raster);
    expect(raster).toEqual([SHADOW_RASTER_CLAMP_DEFINE]);
  });

  it("has the rasteriser clamp take the fragment clamp's depth from the vertex stage, without gl_FragDepth", () => {
    const metric = ShaderStore.IncludesShadersStore.shadowMapVertexMetric!;
    const branch = metric.slice(metric.indexOf("SM_DEPTHCLAMP==3"));
    // GL's depth range maps NDC z to (z + 1) / 2: the metric Babylon's fragment clamp writes.
    expect(branch).toContain("gl_Position.z=(vDepthMetricSM*2.0-1.0)*gl_Position.w;");
    // Babylon computes the metric from the biased clip depth only off its fragment clamp, which this mode is.
    expect(metric.indexOf("vDepthMetricSM=(gl_Position.z+depthValuesSM.x)/depthValuesSM.y+biasAndScaleSM.x;")).toBeLessThan(metric.indexOf("SM_DEPTHCLAMP==3"));
  });

  it("adds its branch to Babylon's vertex metric once, after the metric, and leaves Babylon's own branches as they were", () => {
    const metric = ShaderStore.IncludesShadersStore.shadowMapVertexMetric!;
    expect(metric.split("SM_DEPTHCLAMP==2")).toHaveLength(2);
    // Babylon's fragment-clamp branch is untouched and comes first.
    const fragmentClamp = metric.indexOf("zSM=gl_Position.z;gl_Position.z=0.0;");
    expect(fragmentClamp).toBeGreaterThan(-1);
    expect(metric.indexOf("SM_DEPTHCLAMP==2")).toBeGreaterThan(fragmentClamp);
    // The clamp never moves a vertex behind the near plane: only depth nearer than it changes.
    expect(metric).toContain("gl_Position.z=max(gl_Position.z,-gl_Position.w);");
    // The fragment stage writes its own depth only for the fragment clamp.
    expect(ShaderStore.IncludesShadersStore.shadowMapFragment ?? "").not.toContain("SM_DEPTHCLAMP==2");
  });
});
