import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@haptic/core";
import { sceneActorDisplayLabel, sceneDefaultCameraEntries } from "./scene-actor-entries";

describe("sceneDefaultCameraEntries", () => {
  const scene = {
    ...createDefaultScene(),
    actors: [
      createActor("lamp", "Lamp", { components: [{ id: "lamp-light", classId: "LightComponent", properties: {} }] }),
      createActor("hero", "Hero", {
        classId: "Player",
        components: [{ id: "hero-cam", classId: "CameraComponent", properties: {} }],
      }),
    ],
  };

  it("lists camera actors first and every other placed actor after them", () => {
    expect(sceneDefaultCameraEntries(scene)).toEqual([
      { actorId: "hero", actorName: "Hero", classId: "Player", group: "Camera Actors" },
      { actorId: "lamp", actorName: "Lamp", classId: "Actor", group: "Other Actors" },
    ]);
  });

  it("distinguishes same-name actors by their stable ids, without renaming them", () => {
    const twins = { ...scene, actors: ["cam-a", "cam-b"].map((id) => createActor(id, "Camera", {
      components: [{ id: "camera", classId: "CameraComponent", properties: {} }],
    })) };
    expect(sceneDefaultCameraEntries(twins).map((entry) => entry.actorName)).toEqual(["Camera (cam-a)", "Camera (cam-b)"]);
    expect(sceneActorDisplayLabel(twins, "cam-b")).toBe("Camera (cam-b)");
    expect(twins.actors.map((actor) => actor.name)).toEqual(["Camera", "Camera"]);
  });

  it("has no label for None or a deleted actor", () => {
    expect(sceneActorDisplayLabel(scene, null)).toBeUndefined();
    expect(sceneActorDisplayLabel(scene, "missing")).toBeUndefined();
  });
});
