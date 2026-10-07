import { expect, it } from "vitest";
import { simulationSceneDocument } from "./simulation-viewport";

it("requires an open world Scene and never promotes a Class or SceneLayer preview", () => {
  const documents = [
    { id: "hero", ref: { kind: "graph" }, content: {} },
    { id: "hud", ref: { kind: "scene-layer" }, content: {} },
  ];
  expect(simulationSceneDocument(documents, "hero")).toBeNull();
  const scene = { id: "world", ref: { kind: "scene" }, content: {} };
  expect(simulationSceneDocument([...documents, scene], "hero")).toBe(scene);
});
