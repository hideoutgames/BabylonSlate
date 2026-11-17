import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { describe, expect, it } from "vitest";
import { SHADOW_VERTEX_CLAMP_DEFINE, applyVertexDepthClamp } from "./shadow-vertex-clamp";

describe("vertex-stage shadow depth clamp", () => {
  it("asks for the vertex clamp only where Babylon asked for the fragment clamp", () => {
    const clamped = ["#define SM_FLOAT 0", "#define SM_DEPTHCLAMP 1", "#define SM_USEDISTANCE 0"];
    applyVertexDepthClamp(clamped);
    expect(clamped).toEqual(["#define SM_FLOAT 0", SHADOW_VERTEX_CLAMP_DEFINE, "#define SM_USEDISTANCE 0"]);
    // Contact Hardening draws unclamped: it stays so.
    const unclamped = ["#define SM_DEPTHCLAMP 0"];
    applyVertexDepthClamp(unclamped);
    expect(unclamped).toEqual(["#define SM_DEPTHCLAMP 0"]);
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
