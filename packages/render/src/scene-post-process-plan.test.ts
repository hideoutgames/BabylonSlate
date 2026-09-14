import { expect, it } from "vitest";
import { createDefaultMaterialDocument, createDefaultMaterialFunctionDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import { prepareScenePostProcessPlan } from "./scene-post-process-plan";

function depthFunction() {
  const fn = createDefaultMaterialFunctionDocument("Depth");
  fn.inputs = [];
  fn.outputs = [{ id: "depth", name: "Depth", type: "float" }];
  fn.nodes.push(
    { id: "uv", type: "input.screenUv", properties: {}, position: { x: 0, y: 0 } },
    { id: "sample", type: "input.sceneDepth", properties: {}, position: { x: 0, y: 0 } },
  );
  fn.edges = [
    { id: "uv-depth", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "sample", targetPinId: "uv" },
    { id: "depth-output", sourceNodeId: "sample", sourcePinId: "depth", targetNodeId: "outputs", targetPinId: "depth" },
  ];
  return fn;
}

function depthDocument() {
  const doc = createDefaultMaterialDocument("Depth Consumer", "postProcess");
  doc.nodes.push(
    { id: "depth", type: "function.call", properties: { functionGuid: "depth" }, position: { x: 0, y: 0 } },
    { id: "multiply", type: "math.multiply", properties: {}, position: { x: 0, y: 0 } },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
  doc.edges.push(
    { id: "color-mul", sourceNodeId: "sceneColor", sourcePinId: "color", targetNodeId: "multiply", targetPinId: "a" },
    { id: "depth-mul", sourceNodeId: "depth", sourcePinId: "depth", targetNodeId: "multiply", targetPinId: "b" },
    { id: "mul-out", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "color" },
  );
  return doc;
}

it("resolves transitive enabled requirements while retaining ordered independent entry snapshots", () => {
  const library = new MaterialLibrary({ functions: () => ({ depth: depthFunction() }) });
  const doc = depthDocument();
  const parameters = { Gain: { kind: "color" as const, value: [0.2, 0.3, 0.4, 1] as [number, number, number, number] } };
  const plan = prepareScenePostProcessPlan(library, [
    { id: "second", materialGuid: "shared", enabled: true, order: 2, parameters },
    { id: "disabled", materialGuid: "never-load", enabled: false, order: 0 },
    { id: "first", materialGuid: "shared", enabled: true, order: 1 },
  ], (guid) => {
    if (guid !== "shared") throw new Error("Disabled material was loaded");
    return doc;
  });
  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries.map(({ entry }) => entry.id)).toEqual(["first", "second"]);
  expect(plan.buffers).toEqual({ sceneDepth: true, sceneNormal: false });
  doc.nodes.length = 0;
  parameters.Gain.value[0] = 1;
  expect(plan.entries[0]!.document.nodes.length).toBeGreaterThan(0);
  expect(plan.entries[1]!.entry.parameters!.Gain).toEqual({ kind: "color", value: [0.2, 0.3, 0.4, 1] });
  library.dispose();
});

it("isolates missing functions and wrong domains before they can request geometry buffers", () => {
  const library = new MaterialLibrary();
  const plan = prepareScenePostProcessPlan(library, [
    { id: "bad-function", materialGuid: "depth", enabled: true, order: 0 },
    { id: "surface", materialGuid: "surface", enabled: true, order: 1 },
    { id: "good", materialGuid: "good", enabled: true, order: 2 },
  ], (guid) => guid === "depth" ? depthDocument() : createDefaultMaterialDocument(guid, guid === "surface" ? "surface" : "postProcess"));
  expect(plan.entries.map(({ entry }) => entry.id)).toEqual(["good"]);
  expect(plan.buffers).toEqual({ sceneDepth: false, sceneNormal: false });
  expect(plan.diagnostics.map(({ materialGuid }) => materialGuid)).toEqual(expect.arrayContaining(["depth", "surface"]));
  library.dispose();
});
