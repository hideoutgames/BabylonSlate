import { describe, expect, it } from "vitest";
import {
  SKYBOX_FACE_KEYS,
  createSkyboxComponent,
  emptySkyboxFaces,
  parseSkyboxFaces,
  parseSkyboxSize,
  patchComponentProperties,
  skyboxFaceGuids,
} from "./skybox";
import { createDefaultScene } from "./project";

describe("SkyboxComponent helpers", () => {
  it("creates a SkyboxComponent with size 1000 and empty faces", () => {
    const component = createSkyboxComponent("sky-1");
    expect(component.classId).toBe("SkyboxComponent");
    expect(component.properties.size).toBe(1000);
    expect(parseSkyboxSize(undefined)).toBe(1000);
    expect(parseSkyboxSize(-4)).toBe(1000);
    expect(parseSkyboxSize(250)).toBe(250);
    expect(component.properties.faces).toEqual(emptySkyboxFaces());
    expect(SKYBOX_FACE_KEYS).toEqual(["px", "py", "pz", "nx", "ny", "nz"]);
  });

  it("fills missing face keys with null", () => {
    expect(parseSkyboxFaces({ px: "tex-right" })).toEqual({
      px: "tex-right",
      py: null,
      pz: null,
      nx: null,
      ny: null,
      nz: null,
    });
    expect(parseSkyboxFaces(undefined)).toEqual(emptySkyboxFaces());
  });

  it("lists only assigned face texture guids", () => {
    expect(
      skyboxFaceGuids({
        px: "a",
        py: null,
        pz: "c",
        nx: "",
        ny: null,
        nz: "f",
      }),
    ).toEqual(["a", "c", "f"]);
  });

  it("patches nested faces.px without clobbering sibling faces", () => {
    const properties = {
      size: 1000,
      faces: { px: null, py: "up", pz: null, nx: null, ny: null, nz: null },
    };
    const next = patchComponentProperties(properties, "faces.px", "right");
    expect(next.faces).toEqual({
      px: "right",
      py: "up",
      pz: null,
      nx: null,
      ny: null,
      nz: null,
    });
    expect(next.size).toBe(1000);
  });
});

describe("createDefaultScene skybox", () => {
  it("seeds a locked Skybox and an unlocked directional light in 3D", () => {
    const scene = createDefaultScene();
    const skybox = scene.actors.find((actor) => actor.id === "actor-skybox");
    const sun = scene.actors.find((actor) => actor.id === "actor-sun");
    expect(skybox?.name).toBe("Skybox");
    expect(skybox?.locked).toBe(true);
    expect(skybox?.components[0]?.classId).toBe("SkyboxComponent");
    expect(skybox?.components[0]?.properties.size).toBe(1000);
    expect(sun?.name).toBe("Directional Light");
    expect(sun?.locked).toBe(false);
    const light = sun?.components[0];
    expect(light?.classId).toBe("LightComponent");
    expect(light?.properties.lightKind).toBe("directional");
    expect(light?.properties.color).toEqual([1, 0.96, 0.88]);
    expect(light?.properties.intensity).toBe(1.5);
    expect(light?.properties.castShadows).toBe(true);
    expect(scene.actors.some((actor) => actor.name === "Cube")).toBe(false);
    expect(scene.actors.some((actor) => actor.name === "Actor")).toBe(true);
    expect(scene.settings.environmentColor).toEqual([0.45, 0.62, 0.85]);
  });

  it("lets authors remove the seeded skybox like any other actor", () => {
    const scene = createDefaultScene();
    const without = {
      ...scene,
      actors: scene.actors.filter((actor) => actor.id !== "actor-skybox"),
    };
    expect(without.actors.map((actor) => actor.name)).toEqual([
      "Actor",
      "Directional Light",
      "Camera",
    ]);
  });

  it("does not seed a skybox or directional light in 2D", () => {
    const scene = createDefaultScene("2d");
    expect(scene.settings.environmentColor).toEqual([0.06, 0.07, 0.09]);
    expect(
      scene.actors.some((actor) =>
        actor.components.some((component) => component.classId === "SkyboxComponent"),
      ),
    ).toBe(false);
    expect(
      scene.actors.some((actor) =>
        actor.components.some((component) => component.classId === "LightComponent"),
      ),
    ).toBe(false);
  });
});
