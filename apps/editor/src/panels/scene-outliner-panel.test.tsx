import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import { flattenActors } from "./scene-outliner-panel";

describe("flattenActors type icons", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses the mesh glyph for an engine Actor with a MeshComponent", () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("actor-1", "Box", {
        components: [createMeshComponent("mesh-1", "box")],
      }),
    ];
    const nodes = flattenActors(scene, { collapsed: new Set(), search: "" });
    const { getByTestId } = render(<>{nodes[0]?.icon}</>);
    const glyph = getByTestId("outliner-type-icon-actor-1");
    expect(glyph.getAttribute("data-type-family")).toBe("class");
    expect(glyph.getAttribute("data-type-icon")).toBe("MeshComponent");
  });

  it("uses the Actor glyph for a user class even when it has a mesh", () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("hero-1", "Hero", {
        classId: "MyHero",
        components: [createMeshComponent("mesh-1", "box")],
      }),
    ];
    const parentOf = (id: string) =>
      ({ MyHero: "Actor", Actor: "BObject", BObject: null })[id] ?? null;
    const nodes = flattenActors(scene, {
      collapsed: new Set(),
      search: "",
      parentOf,
    });
    const { getByTestId } = render(<>{nodes[0]?.icon}</>);
    expect(getByTestId("outliner-type-icon-hero-1").getAttribute("data-type-icon")).toBe(
      "Actor",
    );
  });
});
