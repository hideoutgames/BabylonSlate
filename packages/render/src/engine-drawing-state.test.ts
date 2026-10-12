import { expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core";
import { restoreEngineDrawingState, saveEngineDrawingState, createEngineDrawingState } from "./engine-drawing-state";

const GL_FRONT = 1028;
const GL_BACK = 1029;
const GL_CW = 2304;
const GL_CCW = 2305;

it("never restores an unset cull or front face over a set one, which would send null to gl.cullFace and gl.frontFace", () => {
  const engine = new NullEngine();
  try {
    const state = createEngineDrawingState();
    saveEngineDrawingState(engine, state);
    expect(state.cullFace).toBeNull();
    expect(state.frontFace).toBeNull();
    engine.depthCullingState.cullFace = GL_BACK;
    engine.depthCullingState.frontFace = GL_CCW;
    restoreEngineDrawingState(engine, state);
    expect(engine.depthCullingState.cullFace).toBe(GL_BACK);
    expect(engine.depthCullingState.frontFace).toBe(GL_CCW);
  } finally {
    engine.dispose();
  }
});

it("restores a set cull and front face", () => {
  const engine = new NullEngine();
  try {
    engine.depthCullingState.cullFace = GL_FRONT;
    engine.depthCullingState.frontFace = GL_CW;
    const state = createEngineDrawingState();
    saveEngineDrawingState(engine, state);
    engine.depthCullingState.cullFace = GL_BACK;
    engine.depthCullingState.frontFace = GL_CCW;
    restoreEngineDrawingState(engine, state);
    expect(engine.depthCullingState.cullFace).toBe(GL_FRONT);
    expect(engine.depthCullingState.frontFace).toBe(GL_CW);
  } finally {
    engine.dispose();
  }
});
