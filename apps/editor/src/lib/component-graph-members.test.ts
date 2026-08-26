import { describe, expect, it } from "vitest";
import { createMeshComponent, createText3DComponent } from "@babylonslate/core";
import { mergePrefabComponents } from "./prefab-preview";
import { componentGraphMembers } from "./component-graph-members";

describe("componentGraphMembers", () => {
  it("creates object-ref variables for each prefab component", () => {
    const members = componentGraphMembers({
      components: [
        createMeshComponent("prefab-mesh", "box"),
        createText3DComponent("text-1"),
      ],
    });
    expect(members).toEqual([
      expect.objectContaining({
        id: "component:prefab-mesh",
        kind: "variable",
        name: "Mesh",
        typeId: "object",
        typeClassId: "MeshComponent",
        componentId: "prefab-mesh",
      }),
      expect.objectContaining({
        id: "component:text-1",
        kind: "variable",
        name: "3D Text",
        typeId: "object",
        typeClassId: "Text3DComponent",
        componentId: "text-1",
      }),
    ]);
  });

  it("uniquifies duplicate catalog labels", () => {
    const members = componentGraphMembers({
      components: [
        createText3DComponent("text-a"),
        createText3DComponent("text-b"),
      ],
    });
    expect(members.map((member) => member.name)).toEqual(["3D Text", "3D Text 2"]);
  });

  it("drops a variable when the component is removed", () => {
    const withText = componentGraphMembers({
      components: [
        createMeshComponent("prefab-mesh", "box"),
        createText3DComponent("text-1"),
      ],
    });
    const withoutText = componentGraphMembers({
      components: [createMeshComponent("prefab-mesh", "box")],
    });
    expect(withText.some((member) => member.componentId === "text-1")).toBe(true);
    expect(withoutText.some((member) => member.componentId === "text-1")).toBe(
      false,
    );
  });

  it("keeps inherited prefab rows with inheritedFrom", () => {
    const parentMesh = createMeshComponent("prefab-mesh", "box");
    const merged = mergePrefabComponents(
      [{ classId: "HeroBase", components: [parentMesh] }],
      [createText3DComponent("text-1")],
    );
    const members = componentGraphMembers({ components: merged });
    expect(members.find((member) => member.componentId === "prefab-mesh")).toMatchObject(
      {
        name: "Mesh",
        inheritedFrom: "HeroBase",
      },
    );
    expect(members.find((member) => member.componentId === "text-1")?.inheritedFrom).toBe(
      undefined,
    );
  });
});
