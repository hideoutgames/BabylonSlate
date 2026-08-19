import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import {
  sceneComponentDisplayLabel,
  sceneComponentEntries,
} from "./scene-component-entries";

describe("sceneComponentEntries", () => {
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
