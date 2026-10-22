import { describe, expect, it } from "vitest";
import { modelSimpleColliderCounter, physicsPairingDiagnostics } from "./physics-pairing-diagnostics";

const box = { id: "box", name: "Box", kind: "box", position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], halfExtents: { x: 1, y: 1, z: 1 } };

const asset = (type: string, path: string, payload: unknown, placeholder = false) =>
  ({ path, placeholder, header: { type, payload } });

const registry = {
  getByGuid: (guid: string) => ({
    shapeless: asset("Model", "assets/Shapeless.model.hasset", { simpleColliders: [] }),
    boxed: asset("Model", "assets/Boxed.model.hasset", { simpleColliders: [box, { ...box, id: "box-2" }] }),
    texture: asset("Texture", "assets/Wood.texture.hasset", {}),
    lost: asset("Model", "assets/Lost.model.hasset", { simpleColliders: [] }, true),
  } as Record<string, ReturnType<typeof asset>>)[guid],
} as unknown as Parameters<typeof modelSimpleColliderCounter>[0];

describe("modelSimpleColliderCounter", () => {
  it("counts the saved simple shapes of a Model", () => {
    const count = modelSimpleColliderCounter(registry);
    expect(count("shapeless")).toBe(0);
    expect(count("boxed")).toBe(2);
  });

  it("prefers the open tab's unsaved shapes over the saved ones", () => {
    const count = modelSimpleColliderCounter(registry, [
      { ref: { path: "assets/Shapeless.model.hasset" }, content: { simpleColliders: [box] } },
    ]);
    expect(count("shapeless")).toBe(1);
    expect(count("boxed")).toBe(2);
  });

  it("answers unknown for anything that is not a resolvable Model, so it never reports missing shapes", () => {
    const count = modelSimpleColliderCounter(registry);
    expect(count("texture")).toBeUndefined();
    expect(count("lost")).toBeUndefined();
    expect(count("absent")).toBeUndefined();
    expect(modelSimpleColliderCounter(null)("shapeless")).toBeUndefined();
  });
});

describe("physicsPairingDiagnostics", () => {
  const options = { assetGuid: "assets/Main.scene.hasset", graphId: "scene:main" };
  const statue = { id: "statue", components: [{ id: "mesh", classId: "MeshComponent", properties: { collisionMode: "simple", assetGuid: "shapeless" } }] };

  it("locates a Model without simple shapes on the Mesh component", () => {
    const rows = physicsPairingDiagnostics([statue], { ...options, physicsWorld: "3d", modelSimpleColliderCount: modelSimpleColliderCounter(registry) });
    expect(rows).toEqual([expect.objectContaining({
      severity: "warning", code: "physics.mesh_collision_empty", assetGuid: options.assetGuid, graphId: options.graphId, actorId: "statue", componentId: "mesh",
    })]);
  });

  it("checks Mesh collision against the scene's physics world only when it is given", () => {
    expect(physicsPairingDiagnostics([statue], { ...options, physicsWorld: "2d" }).map((row) => row.code)).toEqual(["physics.mesh_collision_2d"]);
    expect(physicsPairingDiagnostics([statue], options)).toEqual([]);
  });
});
