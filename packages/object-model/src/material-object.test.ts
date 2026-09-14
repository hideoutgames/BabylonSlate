import { describe, expect, it } from "vitest";
import { Actor, ActorComponent, BObject, Scene, SceneLayer, getPostProcessMaterialObject } from "./objects";
import { ClassRegistry } from "./class-registry";
import { engineScriptVariablesFor } from "./engine-script-api";

it.each(["scene", "layer"] as const)("keeps %s pass handles isolated across reorder and rejects replacement or teardown", (kind) => {
  const stack = [
    { id: "first", materialGuid: "gain", enabled: true, parameters: { Gain: { kind: "float" as const, value: 0.2 } } },
    { id: "second", materialGuid: "gain", enabled: false },
  ];
  const owner = kind === "scene"
    ? new Scene({ assetGuid: "scene", sceneName: "Scene", postProcessStack: stack })
    : new SceneLayer({ assetGuid: "layer", zOrder: 0, postProcessStack: stack });
  const first = getPostProcessMaterialObject(owner, "first")!;
  const second = getPostProcessMaterialObject(owner, "second")!;
  expect(first).not.toBe(second);
  expect(first.classId).toBe("MaterialObject");
  expect(first.isCurrent()).toBe(true);
  owner.postProcessStack.reverse();
  expect(getPostProcessMaterialObject(owner, "first")).toBe(first);
  owner.postProcessStack.splice(1, 1);
  expect(first.isCurrent()).toBe(false);
  owner.postProcessStack.push({ id: "first", materialGuid: "gain", enabled: true });
  expect(getPostProcessMaterialObject(owner, "first")).not.toBe(first);
  expect(second.isCurrent()).toBe(true);
  second.entry.materialGuid = "replacement";
  expect(second.isCurrent()).toBe(false);
  expect(getPostProcessMaterialObject(owner, "second")).not.toBe(second);
  expect(stack[0]!.parameters!.Gain.value).toBe(0.2);
  const replacement = getPostProcessMaterialObject(owner, "second")!;
  owner.destroyed = true;
  expect(replacement.isCurrent()).toBe(false);
  expect(getPostProcessMaterialObject(owner, "second")).toBeNull();
});

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
