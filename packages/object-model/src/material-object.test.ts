import { describe, expect, it } from "vitest";
import { Actor, ActorComponent, BObject } from "./objects";
import { ClassRegistry } from "./class-registry";
import { engineScriptVariablesFor } from "./engine-script-api";

describe("MeshComponent Material Object", () => {
  it("exposes a get-only live object separately from the assignable Material asset", () => {
    const members = engineScriptVariablesFor("MeshComponent");
    expect(
      members.find((entry) => entry.propertyKey === "materialObject"),
    ).toMatchObject({
      name: "Material Object",
      typeId: "object",
      typeClassId: "MaterialObject",
      getOnly: true,
    });
    expect(
      members.find((entry) => entry.propertyKey === "materialGuid"),
    ).toMatchObject({
      typeId: "asset",
      typeClassId: "Material",
    });
    expect(new ClassRegistry().isA("MaterialObject", "BObject")).toBe(true);
  });

  it("keeps the same reference until reassignment and cannot be overwritten", () => {
    const actor = new Actor({ classId: "Actor", guid: "actor" });
    const mesh = new ActorComponent({ classId: "MeshComponent", guid: "mesh" });
    actor.attachComponent(mesh);
    expect(mesh.getVariable("materialObject")).toBeNull();
    mesh.setVariable("materialGuid", "mat-a");
    const first = mesh.getVariable("materialObject");
    expect(first).toBeInstanceOf(BObject);
    expect(first).toMatchObject({
      classId: "MaterialObject",
      materialAssetGuid: "mat-a",
      component: mesh,
    });
    mesh.setVariable("materialObject", null);
    mesh.setVariable("materialGuid", "mat-a");
    expect(mesh.getVariable("materialObject")).toBe(first);
    mesh.setVariable("materialGuid", "mat-b");
    mesh.setVariable("materialGuid", "mat-a");
    expect(mesh.getVariable("materialObject")).not.toBe(first);
    mesh.destroyed = true;
    expect(mesh.getVariable("materialObject")).toBeNull();
  });
});
