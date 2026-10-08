import { expect, it } from "vitest";
import { Constants, NullEngine } from "@babylonjs/core";
import { restoreEngineDrawingState, saveEngineDrawingState, createEngineDrawingState } from "./engine-drawing-state";

it("never restores an unset cull or front face over a set one, which would send null to gl.cullFace and gl.frontFace", () => {
  const engine = new NullEngine();
  try {
    const state = createEngineDrawingState();
    saveEngineDrawingState(engine, state);
    expect(state.cullFace).toBeNull();
    expect(state.frontFace).toBeNull();
    engine.depthCullingState.cullFace = Constants.BACK;
    engine.depthCullingState.frontFace = Constants.CCW;
    restoreEngineDrawingState(engine, state);
    expect(engine.depthCullingState.cullFace).toBe(Constants.BACK);
    expect(engine.depthCullingState.frontFace).toBe(Constants.CCW);
  } finally {
    engine.dispose();
  }
});

it("restores a set cull and front face", () => {
  const engine = new NullEngine();
  try {
    engine.depthCullingState.cullFace = Constants.FRONT;
    engine.depthCullingState.frontFace = Constants.CW;
    const state = createEngineDrawingState();
    saveEngineDrawingState(engine, state);
    engine.depthCullingState.cullFace = Constants.BACK;
    engine.depthCullingState.frontFace = Constants.CCW;
    restoreEngineDrawingState(engine, state);
    expect(engine.depthCullingState.cullFace).toBe(Constants.FRONT);
    expect(engine.depthCullingState.frontFace).toBe(Constants.CW);
  } finally {
    engine.dispose();
  }
});
