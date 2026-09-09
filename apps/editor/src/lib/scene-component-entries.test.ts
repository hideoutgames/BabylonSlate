import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import {
  sceneComponentDisplayLabel,
  sceneComponentEntries,
} from "./scene-component-entries";

describe("sceneComponentEntries", () => {
  it("distinguishes existing same-name cameras using stable actor identities", () => {
    const scene = createDefaultScene();
    scene.actors = ["cam-a", "cam-b"].map((id) => createActor(id, "Camera", {
      components: [{ id: "camera", classId: "CameraComponent", properties: {} }],
    }));
    expect(sceneComponentEntries(scene).map((entry) => entry.actorName)).toEqual([
      "Camera (cam-a)", "Camera (cam-b)",
    ]);
    expect(sceneComponentDisplayLabel(scene, "cam-b", "camera")).toBe("Camera (cam-b)");
    expect(scene.actors.map((actor) => actor.name)).toEqual(["Camera", "Camera"]);
  });
  const scene = {
    ...createDefaultScene(),
    actors: [
      createActor("hero", "Hero", {
        components: [
          {
            id: "hero-cam",
            classId: "CameraComponent",
            properties: {},
          },
        ],
      }),
      createActor("lamp", "Lamp", {
        components: [
          {
            id: "lamp-light",
            classId: "LightComponent",
            properties: {},
          },
        ],
      }),
    ],
  };

  it("filters to CameraComponent for Default Camera", () => {
    const cameras = sceneComponentEntries(scene, ["CameraComponent"]);
    expect(cameras).toEqual([
      {
        actorId: "hero",
        componentId: "hero-cam",
        actorName: "Hero",
        componentTitle: "Camera",
        classId: "CameraComponent",
      },
    ]);
    expect(sceneComponentDisplayLabel(scene, "hero", "hero-cam")).toBe(
      "Hero Camera",
    );
    expect(sceneComponentDisplayLabel(scene, "missing", "hero-cam")).toBeUndefined();
  });

  it("does not double the Default Camera name when the actor is Camera", () => {
    const withDefault = {
      ...scene,
      actors: [
        createActor("cam", "Camera", {
          components: [
            {
              id: "cam-comp",
              classId: "CameraComponent",
              properties: {},
            },
          ],
        }),
      ],
    };
    expect(sceneComponentDisplayLabel(withDefault, "cam", "cam-comp")).toBe(
      "Camera",
    );
  });
});
