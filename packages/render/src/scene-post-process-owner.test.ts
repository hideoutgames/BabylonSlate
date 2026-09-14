import { NullEngine, Scene, FreeCamera, Vector3 } from "@babylonjs/core";
import { expect, it } from "vitest";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import { ScenePostProcessOwner } from "./scene-post-process-owner";

it("replays entry values across native detach and rebuild while preserving authored reset defaults", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", Vector3.Zero(), scene);
  const library = new MaterialLibrary();
  const document = createDefaultMaterialDocument("Gain", "postProcess");
  document.nodes.push(
    { id: "gain", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Gain", value: [0.5] } },
    { id: "multiply", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} },
  );
  const output = document.edges.find((edge) => edge.id === "e-scene-output")!;
  const original = { ...output };
  output.sourceNodeId = "multiply";
  output.sourcePinId = "out";
  document.edges.push(
    { ...original, id: "color", targetNodeId: "multiply", targetPinId: "a" },
    { id: "gain-value", sourceNodeId: "gain", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "b" },
  );
  const owner = new ScenePostProcessOwner({ scene, camera, library, documentFor: () => document,
    deviceBuffers: { sceneDepth: false, sceneNormal: false },
    stack: [{ id: "a", materialGuid: "gain", enabled: true, order: 0,
      parameters: { Gain: { kind: "float", value: 0.2 } } }] });
  try {
    expect(camera._postProcesses.filter(Boolean)).toHaveLength(0);
    owner.useNative(camera);
    expect(owner.setParameter("a", "Gain", { kind: "float", value: 0.75 })).toBe(true);
    owner.useGraph();
    expect(camera._postProcesses.filter(Boolean)).toHaveLength(0);
    expect(owner.getParameter("a", "Gain")).toEqual({ kind: "float", value: 0.75 });
    owner.useNative(camera);
    expect(owner.getParameter("a", "Gain")).toEqual({ kind: "float", value: 0.75 });
    expect(owner.resetParameter("a", "Gain")).toBe(true);
    expect(owner.getParameter("a", "Gain")).toEqual({ kind: "float", value: 0.2 });
    owner.useGraph();
    owner.useNative(camera);
    expect(owner.getParameter("a", "Gain")).toEqual({ kind: "float", value: 0.2 });
    owner.dispose();
    expect(owner.setParameter("a", "Gain", { kind: "float", value: 1 })).toBe(false);
    expect(camera._postProcesses.filter(Boolean)).toHaveLength(0);
  } finally { owner.dispose(); library.dispose(); scene.dispose(); engine.dispose(); }
});
